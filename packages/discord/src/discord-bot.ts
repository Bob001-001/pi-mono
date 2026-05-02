import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	Client,
	GatewayIntentBits,
	type Interaction,
	type Message,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
	type TextChannel,
} from "discord.js";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentRunner } from "./agent.js";
import { getAllChannelEntries, getOrCreateRunner, getRunnerCount, replaceRunner } from "./agent.js";
import type { DiscordConfig, ThinkingLevel } from "./config.js";
import { THINKING_LEVELS } from "./config.js";
import { createDiscordContext } from "./discord-context.js";
import type { SyntheticDiscordMessage } from "./events.js";
import * as log from "./log.js";
import { globalMetrics } from "./metrics.js";
import {
	aliasNameForId,
	atomicConfigUpdate,
	formatCostRate,
	hasInteractionBeenSeen,
	logSwitchEvent,
	MODEL_ALIASES,
	markInteractionSeen,
	modelAutocompleteChoices,
	resolveAliasOrId,
	resolveModelStrict,
	type SwitchEvent,
	thinkingAutocompleteChoices,
} from "./model-control.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Per-channel queue for sequential processing (same as mom)
// ============================================================================

type QueuedWork = () => Promise<void>;

export class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// Channel state (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
}

// ============================================================================
// DiscordBot
// ============================================================================

export class DiscordBot {
	private client: Client;
	private config: DiscordConfig;
	private configPath: string;
	private workingDir: string;
	private queues = new Map<string, ChannelQueue>();
	private channelStates = new Map<string, ChannelState>();
	private botUserId: string | null = null;
	private startupTs: number = 0;
	private applicationId: string | null = null;
	/**
	 * Set true while a /model or /thinking swap is in progress. New runs
	 * (messages or events) refuse to start while this is set, preventing
	 * an in-flight LLM stream from being orphaned by `swapAllRunners()`.
	 * The check + set is safe in JS (single-threaded) as long as the flip
	 * happens synchronously before any await.
	 */
	private swapInProgress = false;

	constructor(config: DiscordConfig, configPath: string) {
		this.config = config;
		this.configPath = configPath;
		this.workingDir = config.workspaceDir;

		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel, Partials.Message],
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		log.logStartup(this.workingDir, this.config.agentName);

		this.setupEventHandlers();

		await this.client.login(this.config.token);
	}

	async stop(): Promise<void> {
		this.client.destroy();
		log.logDisconnected();
	}

	/**
	 * Enqueue a synthetic event for processing. Returns true if enqueued, false if queue is full.
	 */
	enqueueEvent(msg: SyntheticDiscordMessage): boolean {
		const queue = this.getQueue(msg.channelId);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${msg.channelId}, discarding: ${msg.text.substring(0, 50)}`);
			return false;
		}

		log.logInfo(`Enqueueing event for ${msg.channelId}: ${msg.text.substring(0, 50)}`);
		queue.enqueue(() => this.handleEventMessage(msg));
		return true;
	}

	// ==========================================================================
	// Private - Channel State
	// ==========================================================================

	private getState(channelId: string): ChannelState {
		let state = this.channelStates.get(channelId);
		if (!state) {
			const channelDir = join(this.workingDir, channelId);
			state = {
				running: false,
				runner: getOrCreateRunner(this.config, channelId, channelDir),
				store: new ChannelStore({ workingDir: this.workingDir }),
				stopRequested: false,
			};
			this.channelStates.set(channelId, state);
		}
		return state;
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private setupEventHandlers(): void {
		this.client.once("ready", async (client) => {
			this.botUserId = client.user.id;
			this.applicationId = client.application.id;
			this.startupTs = Date.now();

			log.logConnected(this.config.agentName);
			log.logInfo(`Bot user ID: ${this.botUserId}`);

			// Register slash commands
			await this.registerSlashCommands();
		});

		this.client.on("messageCreate", (message) => {
			this.handleMessageCreate(message).catch((err) => {
				log.logWarning("messageCreate error", err instanceof Error ? err.message : String(err));
			});
		});

		this.client.on("interactionCreate", (interaction) => {
			this.handleInteraction(interaction).catch((err) => {
				log.logWarning("interactionCreate error", err instanceof Error ? err.message : String(err));
			});
		});

		this.client.on("shardReconnecting", () => {
			globalMetrics.incrementReconnections();
			log.logInfo(`Shard reconnecting (total reconnections: ${globalMetrics.getMetrics().reconnections})`);
		});

		this.client.on("warn", (info) => {
			log.logWarning("Discord client warning", info);
		});

		this.client.on("error", (error) => {
			log.logWarning("Discord client error", error.message);
		});
	}

	private async handleMessageCreate(message: Message): Promise<void> {
		if (!this.botUserId) return;
		// Ignore own messages
		if (message.author.id === this.botUserId) return;
		// Ignore bots unless they're in the allowlist (e.g. Sentry alert bot)
		if (message.author.bot && !this.config.allowedBotIds?.includes(message.author.id)) return;

		// Only process messages after startup (ignore cached/old messages replayed on reconnect)
		if (message.createdTimestamp < this.startupTs) {
			log.logInfo(
				`Skipping pre-startup message from ${message.author.username}: ${message.content.substring(0, 30)}`,
			);
			return;
		}

		// Only respond to human messages when directly addressed (DM or @mention).
		// Allowlisted bots (e.g. Sentry) always pass through — they post alerts, not chat.
		if (!message.author.bot) {
			const isDM = message.channel.isDMBased();
			const isMention = message.mentions.users.has(this.botUserId);
			if (!isDM && !isMention) return;
		}

		const channelId = message.channelId;
		// Strip the bot's own mention so `@bob stop` matches the stop command and the agent
		// doesn't see its own mention in the prompt. Other user mentions are preserved.
		let text = message.content.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();

		// For allowlisted bots (e.g. Sentry), extract embed content since message.content is often empty
		if (!text && message.author.bot && message.embeds.length > 0) {
			const embed = message.embeds[0];
			const parts: string[] = [];
			if (embed.title) parts.push(`Title: ${embed.title}`);
			if (embed.description) parts.push(`Description: ${embed.description}`);
			if (embed.url) parts.push(`URL: ${embed.url}`);
			for (const field of embed.fields) {
				parts.push(`${field.name}: ${field.value}`);
			}
			if (embed.footer?.text) parts.push(`Source: ${embed.footer.text}`);
			text = parts.join("\n");
		}

		// Skip if still no content
		if (!text) return;

		// Log the user message to log.jsonl
		this.logUserMessage(channelId, message);

		globalMetrics.incrementReceived();
		globalMetrics.setQueueDepth(channelId, this.getQueue(channelId).size());

		// Handle stop command
		if (text.toLowerCase() === "stop") {
			const state = this.channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				await message.reply("_Stopping..._");
			} else {
				await message.reply("_Nothing running_");
			}
			return;
		}

		const state = this.getState(channelId);

		if (this.swapInProgress) {
			await message.reply("_Bot is reconfiguring (model/thinking swap). Try again in a few seconds._");
			return;
		}

		if (state.running) {
			await message.reply("_Already working. Say `stop` to cancel._");
			return;
		}

		this.getQueue(channelId).enqueue(async () => {
			// Re-check at dispatch time — a swap may have started while we waited in the queue.
			if (this.swapInProgress) {
				log.logInfo(`[${channelId}] Skipping queued run — swap in progress`);
				return;
			}
			await this.handleAgentRun(message, state, text);
		});
	}

	private async handleAgentRun(message: Message, state: ChannelState, resolvedText: string): Promise<void> {
		state.running = true;
		state.stopRequested = false;

		const channelId = message.channelId;
		log.logInfo(`[${channelId}] Starting run: ${resolvedText.substring(0, 50)}`);

		try {
			const ctx = createDiscordContext(message, this.workingDir);
			// Override text with resolved content (includes embed data for bot messages)
			ctx.message.text = resolvedText;
			ctx.message.rawText = resolvedText;

			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (message.channel.isTextBased() && "send" in message.channel) {
					await (message.channel as TextChannel).send("_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${channelId}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
			globalMetrics.setQueueDepth(channelId, this.getQueue(channelId).size());
		}
	}

	private async handleEventMessage(msg: SyntheticDiscordMessage): Promise<void> {
		const channelId = msg.channelId;
		const state = this.getState(channelId);

		if (this.swapInProgress) {
			log.logInfo(`[${channelId}] Skipping event run — swap in progress`);
			return;
		}

		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${channelId}] Starting event run: ${msg.text.substring(0, 50)}`);

		try {
			// Get the Discord channel to send the "thinking" message to
			const channel = await this.client.channels.fetch(channelId);
			if (!channel || !("send" in channel)) {
				log.logWarning(`Event: channel ${channelId} not found or not sendable`);
				return;
			}

			const sendableChannel = channel as TextChannel;

			// Create a synthetic Discord Message-like object for context
			// We need to post a placeholder message first to have a Message to work with
			const placeholderMsg = await sendableChannel.send("_Processing event..._");

			// Build a minimal context object that wraps the placeholder
			const ctx = createDiscordContext(placeholderMsg, this.workingDir, true);

			// Override the message text to the event text
			(ctx.message as { text: string }).text = msg.text;
			(ctx.message as { rawText: string }).rawText = msg.text;
			(ctx.message as { user: string }).user = "EVENT";
			(ctx.message as { ts: string }).ts = msg.messageId;

			await ctx.setWorking(true);
			const result = await state.runner.run(ctx);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				await sendableChannel.send("_Stopped_");
			}
		} catch (err) {
			log.logWarning(`[${channelId}] Event run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	}

	// ==========================================================================
	// Private - Slash Commands
	// ==========================================================================

	private async registerSlashCommands(): Promise<void> {
		if (!this.applicationId) return;

		const commands = [
			new SlashCommandBuilder()
				.setName("status")
				.setDescription("Show bot health: uptime, messages, reconnections, queue depths, session count"),
			new SlashCommandBuilder().setName("costs").setDescription("Show token usage summary"),
			new SlashCommandBuilder()
				.setName("whoami")
				.setDescription("Show your Discord user ID (debug aid for owner-ID configuration)"),
			new SlashCommandBuilder()
				.setName("model")
				.setDescription("Switch the primary model (DM-only, owner-only). No arg shows current.")
				.addStringOption((opt) =>
					opt.setName("name").setDescription("Alias (sonnet|opus|haiku) or exact model ID").setAutocomplete(true),
				),
			new SlashCommandBuilder()
				.setName("thinking")
				.setDescription("Switch the reasoning level (DM-only, owner-only). No arg shows current.")
				.addStringOption((opt) =>
					opt.setName("level").setDescription("off | low | medium | high").setAutocomplete(true),
				),
		];

		try {
			const rest = new REST({ version: "10" }).setToken(this.config.token);
			await rest.put(Routes.applicationCommands(this.applicationId), {
				body: commands.map((c) => c.toJSON()),
			});
			log.logInfo("Slash commands registered: /status, /costs, /whoami, /model, /thinking");
		} catch (err) {
			log.logWarning("Failed to register slash commands", err instanceof Error ? err.message : String(err));
		}
	}

	private async handleInteraction(interaction: Interaction): Promise<void> {
		// Dedup CHECK only — mark after successful handling so a failed handler
		// doesn't suppress Discord's retry.
		if ("id" in interaction && hasInteractionBeenSeen(interaction.id)) {
			log.logInfo(`Skipping duplicate interaction ${interaction.id}`);
			return;
		}

		try {
			if (interaction.isAutocomplete()) {
				await this.handleAutocomplete(interaction);
				if ("id" in interaction) markInteractionSeen(interaction.id);
				return;
			}

			if (!interaction.isChatInputCommand()) return;

			const name = interaction.commandName;

			if (name === "status") {
				await interaction.reply({ content: globalMetrics.formatStatus(getRunnerCount()), ephemeral: false });
			} else if (name === "costs") {
				await interaction.reply({ content: globalMetrics.formatCosts(), ephemeral: false });
			} else if (name === "whoami") {
				if (!this.isDmInteraction(interaction)) {
					await interaction.reply({ content: "_/whoami only works in DMs._", ephemeral: true });
				} else {
					// Owner-gate the disclosure: non-owners only see their own ID.
					// (Owner ID is not cryptographically secret, but it IS the trust
					// boundary for /model and /thinking — don't leak it via /whoami.)
					const isOwner = interaction.user.id === this.config.discordOwnerId;
					const lines = [`Your Discord user ID: \`${interaction.user.id}\``];
					if (isOwner) {
						lines.push(`Configured owner: \`${this.config.discordOwnerId}\` ✅ (this is you)`);
					} else {
						lines.push(`You are not the configured owner of this bot.`);
					}
					await interaction.reply({ content: lines.join("\n"), ephemeral: true });
				}
			} else if (name === "model") {
				await this.handleModelCommand(interaction);
			} else if (name === "thinking") {
				await this.handleThinkingCommand(interaction);
			}

			if ("id" in interaction) markInteractionSeen(interaction.id);
		} catch (err) {
			log.logWarning(
				`handleInteraction error for ${interaction.isChatInputCommand() ? interaction.commandName : "unknown"}`,
				err instanceof Error ? err.message : String(err),
			);
			// Mark seen even on error to avoid retry storms — the user-visible
			// failure is in the reply, the dedup is just to stop runaway loops.
			if ("id" in interaction) markInteractionSeen(interaction.id);
		}
	}

	// ==========================================================================
	// Slash command auth + autocomplete
	// ==========================================================================

	/**
	 * DM detection: use `guildId === null` (bulletproof — DMs have no guild).
	 * Avoids the `interaction.channel?.type === DM` pattern which can throw on
	 * uncached DM channels.
	 */
	private isDmInteraction(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
		return interaction.guildId === null;
	}

	private isOwner(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
		return interaction.user.id === this.config.discordOwnerId;
	}

	/** Returns true if the interaction passes the DM-only + owner-only gate. */
	private passesAuthGate(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
		return this.isDmInteraction(interaction) && this.isOwner(interaction);
	}

	private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
		// Gate identically to the command — non-owners (or guild context) get an
		// empty list, which Discord renders as "no matches". Better than leaking
		// the model alias list outside the owner DM.
		if (!this.passesAuthGate(interaction)) {
			try {
				await interaction.respond([]);
			} catch {
				// non-fatal
			}
			return;
		}

		const focused = interaction.options.getFocused(true);
		try {
			if (interaction.commandName === "model" && focused.name === "name") {
				await interaction.respond(modelAutocompleteChoices(focused.value));
			} else if (interaction.commandName === "thinking" && focused.name === "level") {
				await interaction.respond(thinkingAutocompleteChoices(focused.value));
			} else {
				await interaction.respond([]);
			}
		} catch (err) {
			log.logWarning("Autocomplete respond failed", err instanceof Error ? err.message : String(err));
		}
	}

	// ==========================================================================
	// /model handler
	// ==========================================================================

	private async handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!this.passesAuthGate(interaction)) {
			await interaction.reply({
				content: "_This command is restricted to the configured owner in DMs only._",
				ephemeral: true,
			});
			return;
		}

		const requested = interaction.options.getString("name");
		const current = this.config.model.primary;
		const currentAlias = aliasNameForId(current.id);
		const currentLabel = currentAlias ? `${currentAlias} (${current.id})` : current.id;

		// No arg → show current state.
		if (!requested) {
			const lines = [
				`**Current model:** ${currentLabel}`,
				`**Thinking level:** ${this.config.model.thinkingLevel ?? "off"}`,
				"",
				`Aliases: ${MODEL_ALIASES.map((a) => `\`${a.name}\` → ${a.id} (${a.tier})`).join(", ")}`,
				"",
				"Use `/thinking off|low|medium|high` to control reasoning depth independently.",
			];
			await interaction.reply({ content: lines.join("\n"), ephemeral: false });
			return;
		}

		// Defer FIRST so we don't blow Discord's 3s deadline under load. All
		// subsequent failures use editReply.
		await interaction.deferReply({ ephemeral: false });

		const resolved = resolveAliasOrId(requested);
		if (!resolved) {
			await interaction.editReply({ content: `_Empty model name._` });
			return;
		}

		// Strict validation against built-in catalog. Custom-provider IDs from
		// `models.json` are accepted (resolveModelStrict returns null) and
		// validated at runner-creation time. For built-in IDs, refuse here so
		// we don't lie about the swap.
		const model = resolveModelStrict(resolved.api, resolved.id);
		// If it's not in the built-in catalog, accept on faith but print a
		// caveat (the runner will fail loudly if the ID is bogus).
		const isBuiltin = model !== null;

		// Acquire swap-in-progress lock and re-check no run is active.
		// The flag must be flipped synchronously before the next await so
		// concurrent message handlers see it.
		if (this.swapInProgress) {
			await interaction.editReply({ content: "_Another swap is already in progress. Try again in a moment._" });
			return;
		}
		this.swapInProgress = true;
		try {
			const runningChannel = this.findRunningChannel();
			if (runningChannel) {
				const count = this.countRunningChannels();
				await interaction.editReply({
					content: `_${count} run${count === 1 ? "" : "s"} in progress (e.g. channel ${runningChannel}). Wait for them to finish, then retry._`,
				});
				return;
			}

			let swappedChannels: string[];
			try {
				this.config = await atomicConfigUpdate(
					this.configPath,
					(cfg) => {
						cfg.model = { ...cfg.model, primary: { api: resolved.api, id: resolved.id } };
						return cfg;
					},
					{ backupDir: join(this.workingDir, "logs", "config-backups") },
				);
			} catch (err) {
				log.logWarning("/model: atomicConfigUpdate failed", err instanceof Error ? err.message : String(err));
				await interaction.editReply({
					content: `_Config write failed: ${err instanceof Error ? err.message : String(err)}_`,
				});
				return;
			}

			try {
				swappedChannels = this.swapAllRunners();
			} catch (err) {
				log.logWarning("/model: swapAllRunners failed", err instanceof Error ? err.message : String(err));
				await interaction.editReply({
					content:
						`_Config persisted but in-memory runner swap failed: ${err instanceof Error ? err.message : String(err)}_\n` +
						"Restart the bot to pick up the new model.",
				});
				return;
			}

			// Telemetry: log the switch. Failures here are non-fatal but are
			// surfaced to the user so they know adaptive-selection backfill
			// will be missing this entry.
			const event: SwitchEvent = {
				ts: new Date().toISOString(),
				type: "model",
				model_before: current.id,
				model_after: resolved.id,
				thinking_before: this.config.model.thinkingLevel ?? "off",
				thinking_after: this.config.model.thinkingLevel ?? "off",
				channel_id: interaction.channelId ?? "unknown",
				user_id: interaction.user.id,
				triggered_by: "manual",
				next_message_id: null,
			};
			const telemetryOk = logSwitchEvent(this.workingDir, event);

			const newAlias = aliasNameForId(resolved.id) ?? resolved.id;
			const replyLines = [`**Switched model:** ${currentLabel} → **${newAlias}** (${resolved.id})`, ""];
			if (model) {
				replyLines.push(
					formatCostRate(model, {
						inputTokens: globalMetrics.getMetrics().tokenUsage.input,
						outputTokens: globalMetrics.getMetrics().tokenUsage.output,
						totalCostUsd: globalMetrics.getMetrics().tokenUsage.totalCost,
					}),
					"",
				);
			} else if (!isBuiltin) {
				replyLines.push(
					`_Note: \`${resolved.id}\` is not a built-in model. Cost not shown. If the runner fails to start, your custom \`models.json\` may not have it registered._`,
					"",
				);
			}
			replyLines.push(`Active channel runners swapped: ${swappedChannels.length}.`);
			if (!telemetryOk) {
				replyLines.push("_Telemetry log failed (see bot logs)._");
			}
			replyLines.push("Use `/thinking off|low|medium|high` to control reasoning depth independently.");
			await interaction.editReply({ content: replyLines.join("\n") });
		} finally {
			this.swapInProgress = false;
		}
	}

	// ==========================================================================
	// /thinking handler
	// ==========================================================================

	private async handleThinkingCommand(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!this.passesAuthGate(interaction)) {
			await interaction.reply({
				content: "_This command is restricted to the configured owner in DMs only._",
				ephemeral: true,
			});
			return;
		}

		const requested = interaction.options.getString("level");
		const currentLevel = this.config.model.thinkingLevel ?? "off";

		if (!requested) {
			await interaction.reply({
				content: `**Current thinking level:** ${currentLevel}\nValid: ${THINKING_LEVELS.join(", ")}.\nUse \`/model\` to swap the model itself.`,
				ephemeral: false,
			});
			return;
		}

		// Defer FIRST so we don't blow Discord's 3s deadline.
		await interaction.deferReply({ ephemeral: false });

		const normalized = requested.trim().toLowerCase() as ThinkingLevel;
		if (!THINKING_LEVELS.includes(normalized)) {
			await interaction.editReply({
				content: `_Unknown level \`${requested}\`._ Valid: ${THINKING_LEVELS.join(", ")}.`,
			});
			return;
		}

		if (this.swapInProgress) {
			await interaction.editReply({ content: "_Another swap is already in progress. Try again in a moment._" });
			return;
		}
		this.swapInProgress = true;
		try {
			const runningChannel = this.findRunningChannel();
			if (runningChannel) {
				const count = this.countRunningChannels();
				await interaction.editReply({
					content: `_${count} run${count === 1 ? "" : "s"} in progress (e.g. channel ${runningChannel}). Wait for them to finish, then retry._`,
				});
				return;
			}

			try {
				this.config = await atomicConfigUpdate(
					this.configPath,
					(cfg) => {
						cfg.model = { ...cfg.model, thinkingLevel: normalized };
						return cfg;
					},
					{ backupDir: join(this.workingDir, "logs", "config-backups") },
				);
			} catch (err) {
				log.logWarning("/thinking: atomicConfigUpdate failed", err instanceof Error ? err.message : String(err));
				await interaction.editReply({
					content: `_Config write failed: ${err instanceof Error ? err.message : String(err)}_`,
				});
				return;
			}

			let swappedChannels: string[];
			try {
				swappedChannels = this.swapAllRunners();
			} catch (err) {
				log.logWarning("/thinking: swapAllRunners failed", err instanceof Error ? err.message : String(err));
				await interaction.editReply({
					content:
						`_Config persisted but in-memory runner swap failed: ${err instanceof Error ? err.message : String(err)}_\n` +
						"Restart the bot to pick up the new thinking level.",
				});
				return;
			}

			const event: SwitchEvent = {
				ts: new Date().toISOString(),
				type: "thinking",
				model_before: this.config.model.primary.id,
				model_after: this.config.model.primary.id,
				thinking_before: currentLevel,
				thinking_after: normalized,
				channel_id: interaction.channelId ?? "unknown",
				user_id: interaction.user.id,
				triggered_by: "manual",
				next_message_id: null,
			};
			const telemetryOk = logSwitchEvent(this.workingDir, event);

			const lines = [
				`**Switched thinking:** ${currentLevel} → **${normalized}** (was: ${currentLevel})`,
				`Active channel runners swapped: ${swappedChannels.length}.`,
			];
			if (!telemetryOk) lines.push("_Telemetry log failed (see bot logs)._");
			lines.push("Use `/model` to swap the model itself.");
			await interaction.editReply({ content: lines.join("\n") });
		} finally {
			this.swapInProgress = false;
		}
	}

	// ==========================================================================
	// Runner-swap plumbing — fixes the dual-map staleness bug.
	// ==========================================================================

	/** Returns the channelId of any in-progress run, or null if all idle. */
	private findRunningChannel(): string | null {
		for (const [channelId, state] of this.channelStates) {
			if (state.running) return channelId;
		}
		return null;
	}

	/** Count how many channels are mid-run. Used in error messages. */
	private countRunningChannels(): number {
		let n = 0;
		for (const [, state] of this.channelStates) {
			if (state.running) n++;
		}
		return n;
	}

	/**
	 * For every channel that has either a cached runner OR a state, build a
	 * new runner from the current config and reassign both the module-level
	 * `channelRunners` map AND the per-channel `state.runner` reference.
	 * Iterating the union (not just channelRunners) is defensive: it guarantees
	 * we don't miss a state whose runner pointer is somehow out of sync.
	 *
	 * Old runners are aborted before being replaced. The refuse-while-running
	 * gate in /model and /thinking ensures none of them are mid-stream when
	 * abort() is called, so this is safe.
	 *
	 * Throws if any individual swap throws — caller handles cleanup.
	 */
	private swapAllRunners(): string[] {
		const moduleChannelIds = new Set(getAllChannelEntries().map(([id]) => id));
		const stateChannelIds = new Set(this.channelStates.keys());
		const allChannelIds = new Set([...moduleChannelIds, ...stateChannelIds]);

		const swapped: string[] = [];
		for (const channelId of allChannelIds) {
			const oldState = this.channelStates.get(channelId);
			// Abort the old runner if we can. Refuse-while-running guarantees it
			// isn't mid-stream, but abort is still the right cleanup signal for
			// any pending events.
			try {
				oldState?.runner.abort();
			} catch (err) {
				log.logWarning(
					`swapAllRunners: oldRunner.abort threw for ${channelId}`,
					err instanceof Error ? err.message : String(err),
				);
			}

			const channelDir = join(this.workingDir, channelId);
			const newRunner = replaceRunner(this.config, channelId, channelDir, {});
			if (oldState) {
				oldState.runner = newRunner;
			}
			swapped.push(channelId);
		}
		return swapped;
	}

	// ==========================================================================
	// Private - Logging
	// ==========================================================================

	private logUserMessage(channelId: string, message: Message): void {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const channelName =
			message.channel.isTextBased() && "name" in message.channel ? (message.channel as TextChannel).name : undefined;

		const entry = {
			date: new Date(message.createdTimestamp).toISOString(),
			ts: message.id,
			user: message.author.id,
			userName: message.author.username,
			displayName: message.member?.displayName || message.author.globalName || message.author.username,
			text: message.content,
			attachments: message.attachments.map((a) => ({
				original: a.name,
				local: `${channelId}/attachments/${message.id}_${a.name}`,
			})),
			channelName,
			isBot: false,
		};

		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}
}
