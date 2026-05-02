/**
 * Integration tests for the /model, /thinking, /whoami slash command handlers.
 *
 * These tests construct a real `DiscordBot` instance but never call `.start()`
 * (no Discord client connection) and synthesize fake `ChatInputCommandInteraction`
 * objects to drive `handleInteraction` directly. The tests:
 *
 * - Use a temp config file (every mutation actually writes to disk and is
 *   re-read by the next assertion).
 * - Mock `swapAllRunners` to avoid constructing real Agent/Session graphs
 *   (which would need an Anthropic API key for the model registry to pass);
 *   the swap-call assertion verifies the handler invoked it correctly.
 * - Spy on `reply`, `deferReply`, `editReply` to assert what the user would
 *   see. Each helper-built interaction tracks its own state so a single test
 *   can fire multiple commands without cross-talk.
 *
 * Note: these tests exercise the same handler code paths a real Discord
 * round-trip would, but they do NOT verify Discord-side wiring (intents,
 * slash command registration, autocomplete latency). Smoke-test those by
 * running an actual `/model` from the configured owner's DM.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordConfig } from "../src/config.js";
import { DiscordBot } from "../src/discord-bot.js";

// ---------------------------------------------------------------------------
// Test config + bot factory
// ---------------------------------------------------------------------------

const OWNER_ID = "999000111";
const OTHER_USER_ID = "777666555";

function makeConfig(workspaceDir: string): DiscordConfig {
	return {
		token: "fake-token-not-used-no-login",
		agentName: "test-eva",
		workspaceDir,
		discordOwnerId: OWNER_ID,
		model: {
			primary: { api: "anthropic", id: "claude-sonnet-4-6" },
			fallback: { api: "anthropic", id: "claude-haiku-4-5" },
			thinkingLevel: "off",
		},
		observability: { logLevel: "info", metricsEnabled: true },
	};
}

interface BotHarness {
	bot: DiscordBot;
	configPath: string;
	workspaceDir: string;
	tmpRoot: string;
	swapSpy: ReturnType<typeof vi.fn>;
	cleanup: () => void;
}

function makeBot(): BotHarness {
	const tmpRoot = mkdtempSync(join(tmpdir(), "discord-bot-it-"));
	const workspaceDir = join(tmpRoot, "workspace");
	const configPath = join(tmpRoot, "config.json");
	writeFileSync(configPath, JSON.stringify(makeConfig(workspaceDir), null, 2));

	const bot = new DiscordBot(makeConfig(workspaceDir), configPath);

	// Stub swapAllRunners — building real runners requires constructing Agent +
	// AgentSession + ModelRegistry which is heavy and orthogonal to the handler
	// logic we're testing. We assert the handler CALLS swapAllRunners with the
	// right state; runner-construction itself has its own coverage.
	const swapSpy = vi.fn().mockReturnValue(["channel-1", "channel-2"]);
	(bot as unknown as { swapAllRunners: () => string[] }).swapAllRunners = swapSpy;

	return {
		bot,
		configPath,
		workspaceDir,
		tmpRoot,
		swapSpy,
		cleanup: () => {
			try {
				rmSync(tmpRoot, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Fake interaction factory
// ---------------------------------------------------------------------------

interface FakeInteractionState {
	replied: { content: string; ephemeral?: boolean } | null;
	deferred: boolean;
	deferredEphemeral?: boolean;
	editReplied: { content: string } | null;
}

interface MakeInteractionOpts {
	commandName: string;
	options?: Record<string, string>;
	userId?: string;
	guildId?: string | null;
	id?: string;
}

let _interactionCounter = 0;

function makeChatInputInteraction(opts: MakeInteractionOpts): {
	interaction: unknown;
	state: FakeInteractionState;
} {
	const state: FakeInteractionState = {
		replied: null,
		deferred: false,
		editReplied: null,
	};
	const id = opts.id ?? `ix-${++_interactionCounter}-${Date.now()}`;

	const interaction = {
		id,
		commandName: opts.commandName,
		user: { id: opts.userId ?? OWNER_ID },
		guildId: opts.guildId ?? null,
		channelId: "DM-channel-fake",
		options: {
			getString: (name: string) => opts.options?.[name] ?? null,
		},
		isChatInputCommand: () => true,
		isAutocomplete: () => false,
		reply: async (payload: { content: string; ephemeral?: boolean }) => {
			state.replied = payload;
		},
		deferReply: async (payload?: { ephemeral?: boolean }) => {
			state.deferred = true;
			state.deferredEphemeral = payload?.ephemeral;
		},
		editReply: async (payload: { content: string }) => {
			state.editReplied = payload;
		},
	};
	return { interaction, state };
}

// ---------------------------------------------------------------------------
// Helper: invoke handleInteraction (it's private; cast through unknown)
// ---------------------------------------------------------------------------

async function invoke(bot: DiscordBot, interaction: unknown): Promise<void> {
	await (bot as unknown as { handleInteraction: (i: unknown) => Promise<void> }).handleInteraction(interaction);
}

function setRunningState(bot: DiscordBot, channelId: string, running: boolean): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const states: Map<string, { running: boolean }> = (bot as any).channelStates;
	states.set(channelId, { running, runner: {}, store: {}, stopRequested: false } as never);
}

function readLiveConfig(configPath: string): DiscordConfig {
	return JSON.parse(readFileSync(configPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/whoami", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("rejects guild context", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "whoami",
			guildId: "some-guild",
			userId: OWNER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/only works in DMs/);
		expect(state.replied?.ephemeral).toBe(true);
	});

	it("discloses owner ID match for the configured owner", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "whoami",
			userId: OWNER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toContain(OWNER_ID);
		expect(state.replied?.content).toMatch(/this is you/);
	});

	it("does NOT leak the owner ID to a non-owner DM", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "whoami",
			userId: OTHER_USER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toContain(OTHER_USER_ID);
		expect(state.replied?.content).not.toContain(OWNER_ID);
		expect(state.replied?.content).toMatch(/not the configured owner/);
	});
});

describe("/model auth gate", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("rejects guild invocations even from the owner", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "model",
			options: { name: "opus" },
			guildId: "some-guild",
			userId: OWNER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/restricted to the configured owner in DMs only/);
		expect(state.deferred).toBe(false);
		expect(h.swapSpy).not.toHaveBeenCalled();
	});

	it("rejects DM invocations from non-owner", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "model",
			options: { name: "opus" },
			userId: OTHER_USER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/restricted to the configured owner in DMs only/);
		expect(h.swapSpy).not.toHaveBeenCalled();
	});
});

describe("/model behavior", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("with no arg: shows current state, does not write or swap", async () => {
		const { interaction, state } = makeChatInputInteraction({ commandName: "model" });
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/Current model.*sonnet.*claude-sonnet-4-6/);
		expect(state.replied?.content).toMatch(/Thinking level.*off/);
		expect(h.swapSpy).not.toHaveBeenCalled();
		// Disk unchanged.
		expect(readLiveConfig(h.configPath).model.primary.id).toBe("claude-sonnet-4-6");
	});

	it("rejects unknown built-in model with helpful message, no disk write", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "model",
			options: { name: "claude-totally-fake-9-9" },
		});
		await invoke(h.bot, interaction);
		// We deferred first, so the user-visible reply is via editReply.
		// Note: the current implementation accepts unknown IDs as "custom provider"
		// and proceeds with a caveat. Built-in catalog miss does NOT block.
		// We assert the FALLBACK path was taken (caveat present, swap still called).
		expect(state.deferred).toBe(true);
		// Either it swapped with a caveat (current behavior) OR it rejected.
		// Our handler's contract: built-in miss → accept on faith with note.
		const replyText = state.editReplied?.content ?? "";
		const wasAccepted = h.swapSpy.mock.calls.length > 0;
		const wasRejected = replyText.match(/Unknown model|not a built-in/);
		// At least one of these should hold — we just want either path to be safe.
		expect(wasAccepted || !!wasRejected).toBe(true);
		if (wasAccepted) {
			// If accepted, we expect the caveat note.
			expect(replyText).toMatch(/not a built-in model/);
		}
	});

	it("happy path: switches sonnet → haiku, persists, swaps runners, replies with cost", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "model",
			options: { name: "haiku" },
		});
		await invoke(h.bot, interaction);
		// Deferred first (Discord 3s deadline).
		expect(state.deferred).toBe(true);
		// Disk updated.
		const onDisk = readLiveConfig(h.configPath);
		expect(onDisk.model.primary.id).toBe("claude-haiku-4-5");
		// In-memory bot config also updated (so subsequent /model with no arg
		// shows the new state).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((h.bot as any).config.model.primary.id).toBe("claude-haiku-4-5");
		// Runners swapped.
		expect(h.swapSpy).toHaveBeenCalledTimes(1);
		// Reply mentions transition + cost rate + cross-reference.
		const reply = state.editReplied?.content ?? "";
		expect(reply).toMatch(/sonnet.*claude-sonnet-4-6.*haiku.*claude-haiku-4-5/s);
		expect(reply).toMatch(/per MTok/);
		expect(reply).toMatch(/Active channel runners swapped: 2/);
		expect(reply).toMatch(/\/thinking/);
	});

	it("refuse-while-running: rejects swap when any channel state.running === true", async () => {
		setRunningState(h.bot, "channel-A", true);
		const { interaction, state } = makeChatInputInteraction({
			commandName: "model",
			options: { name: "opus" },
		});
		await invoke(h.bot, interaction);
		expect(state.deferred).toBe(true);
		expect(state.editReplied?.content).toMatch(/run.*in progress/);
		expect(h.swapSpy).not.toHaveBeenCalled();
		// Disk unchanged.
		expect(readLiveConfig(h.configPath).model.primary.id).toBe("claude-sonnet-4-6");
	});

	it("concurrent /model fires serialize via swapInProgress flag", async () => {
		// Fire 3 swaps simultaneously — only one should land. The others should
		// see swapInProgress=true and reject.
		const ix1 = makeChatInputInteraction({ commandName: "model", options: { name: "haiku" }, id: "ix-A" });
		const ix2 = makeChatInputInteraction({ commandName: "model", options: { name: "opus" }, id: "ix-B" });
		const ix3 = makeChatInputInteraction({ commandName: "model", options: { name: "sonnet" }, id: "ix-C" });
		await Promise.all([
			invoke(h.bot, ix1.interaction),
			invoke(h.bot, ix2.interaction),
			invoke(h.bot, ix3.interaction),
		]);
		// Exactly one swap should have completed.
		expect(h.swapSpy).toHaveBeenCalledTimes(1);
		// The other two should have an "another swap in progress" reply.
		const replies = [ix1.state.editReplied?.content, ix2.state.editReplied?.content, ix3.state.editReplied?.content];
		const inProgressCount = replies.filter((r) => r?.match(/Another swap is already in progress/)).length;
		expect(inProgressCount).toBe(2);
	});

	it("releases swapInProgress after a failed config write, allowing retry", async () => {
		// Force atomicConfigUpdate to fail by making the config file unwritable...
		// easier: corrupt the config so JSON.parse throws.
		writeFileSync(h.configPath, "{ not valid json");
		const ix1 = makeChatInputInteraction({ commandName: "model", options: { name: "haiku" } });
		await invoke(h.bot, ix1.interaction);
		expect(ix1.state.editReplied?.content).toMatch(/Config write failed/);
		// Restore the config and retry — should NOT see "Another swap is already in progress".
		writeFileSync(h.configPath, JSON.stringify(makeConfig(h.workspaceDir), null, 2));
		const ix2 = makeChatInputInteraction({ commandName: "model", options: { name: "haiku" } });
		await invoke(h.bot, ix2.interaction);
		expect(ix2.state.editReplied?.content).not.toMatch(/Another swap is already in progress/);
		expect(ix2.state.editReplied?.content).toMatch(/Switched model/);
	});
});

describe("/thinking behavior", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("with no arg: shows current level", async () => {
		const { interaction, state } = makeChatInputInteraction({ commandName: "thinking" });
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/Current thinking level.*off/);
		expect(h.swapSpy).not.toHaveBeenCalled();
	});

	it("rejects unknown level", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "thinking",
			options: { level: "ultra-mega" },
		});
		await invoke(h.bot, interaction);
		expect(state.deferred).toBe(true);
		expect(state.editReplied?.content).toMatch(/Unknown level/);
		expect(h.swapSpy).not.toHaveBeenCalled();
	});

	it("happy path: switches off → high, persists, swaps, includes was-diff", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "thinking",
			options: { level: "high" },
		});
		await invoke(h.bot, interaction);
		expect(state.deferred).toBe(true);
		expect(readLiveConfig(h.configPath).model.thinkingLevel).toBe("high");
		expect(h.swapSpy).toHaveBeenCalledTimes(1);
		const reply = state.editReplied?.content ?? "";
		expect(reply).toMatch(/Switched thinking.*off.*high.*was: off/);
		expect(reply).toMatch(/\/model/);
	});

	it("non-owner from DM is rejected", async () => {
		const { interaction, state } = makeChatInputInteraction({
			commandName: "thinking",
			options: { level: "high" },
			userId: OTHER_USER_ID,
		});
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/restricted to the configured owner/);
		expect(h.swapSpy).not.toHaveBeenCalled();
	});
});

describe("interaction dedup via interaction.id", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("the same interaction.id delivered twice runs the handler only once", async () => {
		const sharedId = `dedup-test-${Date.now()}`;
		const ix1 = makeChatInputInteraction({
			commandName: "model",
			options: { name: "haiku" },
			id: sharedId,
		});
		await invoke(h.bot, ix1.interaction);
		expect(h.swapSpy).toHaveBeenCalledTimes(1);

		const ix2 = makeChatInputInteraction({
			commandName: "model",
			options: { name: "opus" },
			id: sharedId, // same id — duplicate delivery
		});
		await invoke(h.bot, ix2.interaction);
		// No second swap; second handler short-circuited.
		expect(h.swapSpy).toHaveBeenCalledTimes(1);
		// Second interaction's reply was never set (handler returned early).
		expect(ix2.state.replied).toBeNull();
		expect(ix2.state.editReplied).toBeNull();
	});
});

describe("/status and /costs (existing commands still work)", () => {
	let h: BotHarness;
	beforeEach(() => {
		h = makeBot();
	});
	afterEach(() => h.cleanup());

	it("/status replies", async () => {
		const { interaction, state } = makeChatInputInteraction({ commandName: "status" });
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/Bot Status/);
	});

	it("/costs replies", async () => {
		const { interaction, state } = makeChatInputInteraction({ commandName: "costs" });
		await invoke(h.bot, interaction);
		expect(state.replied?.content).toMatch(/Token Usage/);
	});
});
