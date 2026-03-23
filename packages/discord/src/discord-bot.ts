import {
	Client,
	GatewayIntentBits,
	type Interaction,
	type Message,
	REST,
	Routes,
	SlashCommandBuilder,
	type TextChannel,
} from "discord.js";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentRunner } from "./agent.js";
import { getOrCreateRunner, getRunnerCount } from "./agent.js";
import type { DiscordConfig } from "./config.js";
import { createDiscordContext } from "./discord-context.js";
import type { SyntheticDiscordMessage } from "./events.js";
import * as log from "./log.js";
import { globalMetrics } from "./metrics.js";
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
	private workingDir: string;
	private queues = new Map<string, ChannelQueue>();
	private channelStates = new Map<string, ChannelState>();
	private botUserId: string | null = null;
	private startupTs: number = 0;
	private applicationId: string | null = null;

	constructor(config: DiscordConfig) {
		this.config = config;
		this.workingDir = config.workspaceDir;

		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
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
		// Ignore bots (including self)
		if (message.author.bot) return;
		if (message.author.id === this.botUserId) return;

		// Only process messages after startup (ignore cached/old messages replayed on reconnect)
		if (message.createdTimestamp < this.startupTs) {
			log.logInfo(
				`Skipping pre-startup message from ${message.author.username}: ${message.content.substring(0, 30)}`,
			);
			return;
		}

		const channelId = message.channelId;
		const text = message.content.trim();

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
			await this.handleAgentRun(message, state);
		});
	}

	private async handleAgentRun(message: Message, state: ChannelState): Promise<void> {
		state.running = true;
		state.stopRequested = false;

		const channelId = message.channelId;
		log.logInfo(`[${channelId}] Starting run: ${message.content.substring(0, 50)}`);

		try {
			const ctx = createDiscordContext(message, this.workingDir);

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
		];

		try {
			const rest = new REST({ version: "10" }).setToken(this.config.token);
			await rest.put(Routes.applicationCommands(this.applicationId), {
				body: commands.map((c) => c.toJSON()),
			});
			log.logInfo("Slash commands registered: /status, /costs");
		} catch (err) {
			log.logWarning("Failed to register slash commands", err instanceof Error ? err.message : String(err));
		}
	}

	private async handleInteraction(interaction: Interaction): Promise<void> {
		if (!interaction.isChatInputCommand()) return;

		if (interaction.commandName === "status") {
			const statusText = globalMetrics.formatStatus(getRunnerCount());
			await interaction.reply({ content: statusText, ephemeral: false });
		} else if (interaction.commandName === "costs") {
			const costsText = globalMetrics.formatCosts();
			await interaction.reply({ content: costsText, ephemeral: false });
		}
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
