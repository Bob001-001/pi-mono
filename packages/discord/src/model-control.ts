// ============================================================================
// Model & thinking-level control: aliases, atomic config update, telemetry,
// strict resolution, cost-rate display.
// ============================================================================

import { getModel, type Model, type Provider } from "@mariozechner/pi-ai";
import { randomBytes } from "crypto";
import {
	appendFileSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "fs";
import { dirname, join } from "path";
import type { DiscordConfig, ModelConfig, ThinkingLevel } from "./config.js";
import { validateConfig } from "./config.js";
import * as log from "./log.js";

// ----------------------------------------------------------------------------
// Aliases — pinned to specific versions. New model releases require explicit
// alias bumps so users don't get surprise upgrades.
// ----------------------------------------------------------------------------

export interface ModelAlias {
	name: string;
	api: string;
	id: string;
	tier: "fast" | "balanced" | "max";
}

export const MODEL_ALIASES: ModelAlias[] = [
	{ name: "haiku", api: "anthropic", id: "claude-haiku-4-5", tier: "fast" },
	{ name: "sonnet", api: "anthropic", id: "claude-sonnet-4-6", tier: "balanced" },
	{ name: "opus", api: "anthropic", id: "claude-opus-4-7", tier: "max" },
];

const ALIAS_BY_NAME = new Map(MODEL_ALIASES.map((a) => [a.name, a]));
const ALIAS_BY_ID = new Map(MODEL_ALIASES.map((a) => [a.id, a]));

/** Resolve a user-supplied string into a (api, id) pair. Accepts alias names or exact IDs. */
export function resolveAliasOrId(input: string): { api: string; id: string } | null {
	const trimmed = input.trim().toLowerCase();
	const alias = ALIAS_BY_NAME.get(trimmed);
	if (alias) return { api: alias.api, id: alias.id };
	// Treat exact IDs as anthropic by default — only provider supported in v1.
	if (input.trim().length > 0) return { api: "anthropic", id: input.trim() };
	return null;
}

// ----------------------------------------------------------------------------
// Strict model resolution — does NOT silently fall back to a default model.
//
// We deliberately do NOT instantiate a `ModelRegistry` here: its constructor
// calls `authStorage.setFallbackResolver()` and `getOAuthProviders()` on the
// passed object, which throws unless given a real `AuthStorage`. The caller
// (`DiscordBot`) holds the actual per-runner registry; for /model validation
// we use the built-in model catalog only. Custom-provider IDs from
// `models.json` are accepted as a string but are NOT validated by this fn —
// validation in that case is deferred to `createRunner`, which now also
// refuses (logs warning + throws) on unresolved IDs.
// ----------------------------------------------------------------------------

/**
 * Resolve a (api, id) pair into a concrete built-in Model. Returns null if
 * the ID is not a built-in. Caller decides whether to accept a non-built-in
 * (e.g. custom provider from `models.json`) on faith and validate at runner
 * creation time.
 */
export function resolveModelStrict(api: string, id: string): Model<Provider> | null {
	try {
		// `getModel` is typed against a KnownProvider literal union; cast since
		// our DiscordConfig.api is an unconstrained string in the schema.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const fromBuiltin = getModel(api as any, id);
		if (fromBuiltin && fromBuiltin.id === id) return fromBuiltin as Model<Provider>;
	} catch {
		// not found
	}
	return null;
}

// ----------------------------------------------------------------------------
// Cost-rate display — uses model.cost (per MTok) plus session token usage
// for a rough projected cost.
// ----------------------------------------------------------------------------

export interface SessionCostSnapshot {
	inputTokens: number;
	outputTokens: number;
	totalCostUsd: number;
}

export function formatCostRate(model: Model<Provider>, currentSnapshot: SessionCostSnapshot): string {
	const cost = model.cost;
	if (!cost) return `${model.name ?? model.id} — pricing unknown`;

	// Use 2 decimals so haiku's $0.80 doesn't truncate to "$1".
	const inputRate = cost.input.toFixed(2).replace(/\.?0+$/, "");
	const outputRate = cost.output.toFixed(2).replace(/\.?0+$/, "");

	const lines: string[] = [`${model.name ?? model.id} — $${inputRate} in / $${outputRate} out per MTok.`];

	// Session-relative projection.
	const sessionInput = currentSnapshot.inputTokens;
	const sessionOutput = currentSnapshot.outputTokens;
	const projected = (sessionInput * cost.input + sessionOutput * cost.output) / 1_000_000;
	if (sessionInput + sessionOutput > 0) {
		lines.push(
			`Session so far: $${currentSnapshot.totalCostUsd.toFixed(4)}. ` +
				`Same volume on this model would run ~$${projected.toFixed(4)}.`,
		);
	} else {
		lines.push("Session so far: $0.0000 (no usage yet).");
	}
	return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Atomic config write with process-level mutex.
// ----------------------------------------------------------------------------

let _writeChain: Promise<void> = Promise.resolve();

/**
 * Atomically apply an in-place mutation to the config file. Serializes against
 * concurrent calls IN THE SAME PROCESS. Writes to a temp file then renames
 * (atomic on the same filesystem). Re-validates the result before writing
 * so a hand-edited bad config doesn't get re-serialized.
 *
 * Caveats:
 * - This mutex is process-local. If another process (e.g. `deploy.sh`) writes
 *   to the same file concurrently, the last writer wins. The bot's contract
 *   is that nothing else should write `model.*` while it's running. The deploy
 *   script preserves the live config when it has a real token, so in practice
 *   the only writer is the bot itself.
 * - We refuse symlinks (security: prevents redirecting writes outside .pi/).
 * - On crash mid-write, the temp file is unlinked in the finally block. If
 *   the process is hard-killed, an orphan temp may remain — name includes pid
 *   and 32-bit random so multiple orphans don't collide on cleanup.
 */
export async function atomicConfigUpdate(
	configPath: string,
	apply: (config: DiscordConfig) => DiscordConfig,
): Promise<DiscordConfig> {
	let result!: DiscordConfig;
	const next = _writeChain.then(async () => {
		// Refuse symlinks — caller intends to write a regular file.
		const fs = await import("fs");
		const stat = fs.lstatSync(configPath);
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing to write through symlink at ${configPath}`);
		}

		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as DiscordConfig;
		const updated = apply(parsed);
		// Re-validate so a malformed update (or a bad on-disk starting state)
		// doesn't get persisted.
		validateConfig(updated);

		const serialized = `${JSON.stringify(updated, null, 2)}\n`;
		const tmpSuffix = `${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
		const tmpPath = `${configPath}.tmp.${tmpSuffix}`;
		const dir = dirname(configPath);

		let fd: number | null = null;
		try {
			fd = openSync(tmpPath, "w", 0o600);
			writeSync(fd, serialized);
			fsyncSync(fd); // durably persist the temp file's data
			closeSync(fd);
			fd = null;
			renameSync(tmpPath, configPath);
			// fsync the parent dir to durably persist the rename's metadata.
			// On filesystems that don't support dir fsync (rare on macOS HFS+/APFS)
			// this throws EPERM/EINVAL — non-fatal, log and continue.
			try {
				const dfd = openSync(dir, "r");
				try {
					fsyncSync(dfd);
				} finally {
					closeSync(dfd);
				}
			} catch (err) {
				log.logWarning(
					"atomicConfigUpdate: dir fsync failed (non-fatal)",
					err instanceof Error ? err.message : String(err),
				);
			}
			result = updated;
		} catch (err) {
			// Cleanup orphan temp file if anything failed.
			if (fd !== null) {
				try {
					closeSync(fd);
				} catch {
					/* ignore */
				}
			}
			try {
				unlinkSync(tmpPath);
			} catch {
				/* ignore — may not exist */
			}
			throw err;
		}
	});
	_writeChain = next.catch(() => {}); // never break the chain
	await next;
	return result;
}

// ----------------------------------------------------------------------------
// JSONL switch telemetry.
// ----------------------------------------------------------------------------

export interface SwitchEvent {
	ts: string;
	type: "model" | "thinking";
	model_before: string;
	model_after: string;
	thinking_before: ThinkingLevel;
	thinking_after: ThinkingLevel;
	channel_id: string;
	user_id: string;
	triggered_by: "manual" | "auto";
	/** Discord message ID of the next user message. Backfilled by future research. */
	next_message_id: string | null;
}

/**
 * Append a switch event to the JSONL log. Returns true on success, false on
 * any failure (mkdir EACCES, append ENOSPC, etc). Errors are logged but never
 * thrown — telemetry is best-effort and must not break the user-facing reply.
 */
export function logSwitchEvent(workspaceDir: string, event: SwitchEvent): boolean {
	const dir = join(workspaceDir, "logs");
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		log.logWarning("logSwitchEvent: mkdir failed", err instanceof Error ? err.message : String(err));
		return false;
	}
	const path = join(dir, "model-switches.jsonl");
	try {
		appendFileSync(path, `${JSON.stringify(event)}\n`);
		return true;
	} catch (err) {
		log.logWarning("logSwitchEvent: append failed", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ----------------------------------------------------------------------------
// Discord interaction dedup — tiny ring buffer with check/mark split so a
// failed handler doesn't permanently mark an unacknowledged interaction.
// ----------------------------------------------------------------------------

const RECENT_INTERACTIONS_LIMIT = 64;
const _recentInteractions: string[] = [];
const _recentInteractionSet = new Set<string>();

/** True if this interaction.id was already marked seen. Does NOT add it. */
export function hasInteractionBeenSeen(interactionId: string): boolean {
	return _recentInteractionSet.has(interactionId);
}

/** Add an interaction to the seen set. Call only after successful handling. */
export function markInteractionSeen(interactionId: string): void {
	if (_recentInteractionSet.has(interactionId)) return;
	_recentInteractions.push(interactionId);
	_recentInteractionSet.add(interactionId);
	if (_recentInteractions.length > RECENT_INTERACTIONS_LIMIT) {
		const old = _recentInteractions.shift()!;
		_recentInteractionSet.delete(old);
	}
}

/**
 * Legacy combined check-and-mark. Kept for compatibility but prefer
 * `hasInteractionBeenSeen` + `markInteractionSeen` so a failed handler
 * doesn't suppress Discord's retry of an unacknowledged interaction.
 */
export function isDuplicateInteraction(interactionId: string): boolean {
	if (hasInteractionBeenSeen(interactionId)) return true;
	markInteractionSeen(interactionId);
	return false;
}

// ----------------------------------------------------------------------------
// Convenience: build the autocomplete choice list.
// ----------------------------------------------------------------------------

export function modelAutocompleteChoices(focused: string): { name: string; value: string }[] {
	const f = focused.trim().toLowerCase();
	const matches = MODEL_ALIASES.filter((a) => !f || a.name.startsWith(f) || a.id.includes(f));
	return matches.slice(0, 25).map((a) => ({ name: `${a.name} — ${a.id} (${a.tier})`, value: a.name }));
}

export function thinkingAutocompleteChoices(focused: string): { name: string; value: string }[] {
	const levels: { value: ThinkingLevel; label: string }[] = [
		{ value: "off", label: "off — no extended reasoning (default, fastest, cheapest)" },
		{ value: "low", label: "low — light reasoning" },
		{ value: "medium", label: "medium — balanced" },
		{ value: "high", label: "high — deep reasoning (slowest, most thorough)" },
	];
	const f = focused.trim().toLowerCase();
	return levels.filter((l) => !f || l.value.startsWith(f)).map((l) => ({ name: l.label, value: l.value }));
}

/** Look up alias name from a model ID, for human-readable display. */
export function aliasNameForId(id: string): string | null {
	return ALIAS_BY_ID.get(id)?.name ?? null;
}

/** Convenience: build a `ModelConfig` from an alias name or exact id. */
export function modelConfigFromInput(input: string): ModelConfig | null {
	const resolved = resolveAliasOrId(input);
	if (!resolved) return null;
	return { api: resolved.api, id: resolved.id };
}
