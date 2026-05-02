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
	isDuplicateInteraction,
	logSwitchEvent,
	MODEL_ALIASES,
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

		if (state.running) {
			await message.reply("_Already working. Say `stop` to cancel._");
			return;
		}

		this.getQueue(channelId).enqueue(async () => {
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
		// Dedup: Discord can deliver the same interaction.id twice on edge timeouts.
		// Note: interaction.id is unique per interaction even on retries within the
		// same gateway session, so this guards against in-process double-handling.
		if ("id" in interaction && isDuplicateInteraction(interaction.id)) {
			log.logInfo(`Skipping duplicate interaction ${interaction.id}`);
			return;
		}

		if (interaction.isAutocomplete()) {
			await this.handleAutocomplete(interaction);
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const name = interaction.commandName;

		if (name === "status") {
			await interaction.reply({ content: globalMetrics.formatStatus(getRunnerCount()), ephemeral: false });
			return;
		}

		if (name === "costs") {
			await interaction.reply({ content: globalMetrics.formatCosts(), ephemeral: false });
			return;
		}

		if (name === "whoami") {
			// Debug aid: always works (in DM only) so Yang can find his user ID
			// without `discordOwnerId` being configured correctly first.
			if (!this.isDmInteraction(interaction)) {
				await interaction.reply({ content: "_/whoami only works in DMs._", ephemeral: true });
				return;
			}
			await interaction.reply({
				content: `Your Discord user ID: \`${interaction.user.id}\`\nConfigured owner: \`${this.config.discordOwnerId}\`\nMatch: ${interaction.user.id === this.config.discordOwnerId ? "✅" : "❌"}`,
				ephemeral: true,
			});
			return;
		}

		if (name === "model") {
			await this.handleModelCommand(interaction);
			return;
		}

		if (name === "thinking") {
			await this.handleThinkingCommand(interaction);
			return;
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

		// Refuse-while-running: if any channel is mid-run, the in-flight LLM
		// stream would lose its handoff to the new runner. v1 strategy is to
		// refuse and ask the user to retry.
		const runningChannel = this.findRunningChannel();
		if (runningChannel) {
			await interaction.reply({
				content: `_A run is in progress on channel ${runningChannel}. Wait for it to finish, then retry._`,
				ephemeral: true,
			});
			return;
		}

		const resolved = resolveAliasOrId(requested);
		if (!resolved) {
			await interaction.reply({ content: `_Empty model name._`, ephemeral: true });
			return;
		}

		// Strict validation: refuse if model isn't in the registry. Otherwise
		// the silent fallback to claude-sonnet-4-5 in agent.ts would lie about
		// the swap.
		const model = resolveModelStrict(resolved.api, resolved.id);
		if (!model) {
			await interaction.reply({
				content:
					`_Unknown model \`${resolved.id}\`._ Aliases: ${MODEL_ALIASES.map((a) => `\`${a.name}\``).join(", ")}.\n` +
					"Or supply an exact Anthropic model ID.",
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: false });

		// Atomically rewrite config.json on disk and update bot's in-memory copy.
		try {
			this.config = await atomicConfigUpdate(this.configPath, (cfg) => {
				cfg.model = { ...cfg.model, primary: { api: resolved.api, id: resolved.id } };
				return cfg;
			});
		} catch (err) {
			log.logWarning("/model: atomicConfigUpdate failed", err instanceof Error ? err.message : String(err));
			await interaction.editReply({
				content: `_Config write failed: ${err instanceof Error ? err.message : String(err)}_`,
			});
			return;
		}

		// Replace every active channel runner AND reassign state.runner so the
		// next message uses the new runner (fixes dual-map staleness).
		const swappedChannels = this.swapAllRunners();

		// Telemetry: log the switch.
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
		logSwitchEvent(this.workingDir, event);

		// Reply with cost-rate disclosure + cross-reference + state diff.
		const newAlias = aliasNameForId(resolved.id) ?? resolved.id;
		const reply = [
			`**Switched model:** ${currentLabel} → **${newAlias}** (${resolved.id})`,
			"",
			formatCostRate(model, {
				inputTokens: globalMetrics.getMetrics().tokenUsage.input,
				outputTokens: globalMetrics.getMetrics().tokenUsage.output,
				totalCostUsd: globalMetrics.getMetrics().tokenUsage.totalCost,
			}),
			"",
			`Active channel runners swapped: ${swappedChannels.length}.`,
			"Use `/thinking off|low|medium|high` to control reasoning depth independently.",
		].join("\n");
		await interaction.editReply({ content: reply });
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

		const normalized = requested.trim().toLowerCase() as ThinkingLevel;
		if (!THINKING_LEVELS.includes(normalized)) {
			await interaction.reply({
				content: `_Unknown level \`${requested}\`._ Valid: ${THINKING_LEVELS.join(", ")}.`,
				ephemeral: true,
			});
			return;
		}

		const runningChannel = this.findRunningChannel();
		if (runningChannel) {
			await interaction.reply({
				content: `_A run is in progress on channel ${runningChannel}. Wait for it to finish, then retry._`,
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: false });

		try {
			this.config = await atomicConfigUpdate(this.configPath, (cfg) => {
				cfg.model = { ...cfg.model, thinkingLevel: normalized };
				return cfg;
			});
		} catch (err) {
			log.logWarning("/thinking: atomicConfigUpdate failed", err instanceof Error ? err.message : String(err));
			await interaction.editReply({
				content: `_Config write failed: ${err instanceof Error ? err.message : String(err)}_`,
			});
			return;
		}

		const swappedChannels = this.swapAllRunners();

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
		logSwitchEvent(this.workingDir, event);

		await interaction.editReply({
			content: [
				`**Switched thinking:** ${currentLevel} → **${normalized}** (was: ${currentLevel})`,
				`Active channel runners swapped: ${swappedChannels.length}.`,
				"Use `/model` to swap the model itself.",
			].join("\n"),
		});
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

	/**
	 * For every cached runner, build a new runner from the current config and
	 * reassign both the module-level `channelRunners` map AND the per-channel
	 * `state.runner` reference. This is the fix for the C1+C2 dual-map bug.
	 */
	private swapAllRunners(): string[] {
		const entries = getAllChannelEntries();
		const swapped: string[] = [];
		for (const [channelId] of entries) {
			const channelDir = join(this.workingDir, channelId);
			const newRunner = replaceRunner(this.config, channelId, channelDir, {});
			const state = this.channelStates.get(channelId);
			if (state) {
				state.runner = newRunner;
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
