// ============================================================================
// Model & thinking-level control: aliases, atomic config update, telemetry,
// strict resolution, cost-rate display.
// ============================================================================

import { getModel, type Model, type Provider } from "@mariozechner/pi-ai";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { DiscordConfig, ModelConfig, ThinkingLevel } from "./config.js";
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
// ----------------------------------------------------------------------------

let _registry: ModelRegistry | null = null;
function getRegistry(): ModelRegistry {
	if (!_registry) {
		// Use a no-auth registry just for model lookup. Auth is handled per-runner.
		_registry = new ModelRegistry({ getApiKey: async () => undefined } as never);
	}
	return _registry;
}

/**
 * Resolve a (api, id) pair into a concrete Model. Returns null if not found.
 * NEVER falls back silently — caller decides what to do on miss.
 */
export function resolveModelStrict(api: string, id: string): Model<Provider> | null {
	try {
		const fromRegistry = getRegistry().find(api, id);
		if (fromRegistry) return fromRegistry as Model<Provider>;
	} catch {
		// fall through
	}
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

	const inputRate = cost.input.toFixed(0);
	const outputRate = cost.output.toFixed(0);

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
 * concurrent calls in the same process. Writes to a temp file then renames
 * (atomic on the same filesystem).
 *
 * The `apply` function receives the parsed config and mutates it. Returns the
 * mutated config (which is also written back to disk).
 */
export async function atomicConfigUpdate(
	configPath: string,
	apply: (config: DiscordConfig) => DiscordConfig,
): Promise<DiscordConfig> {
	let result!: DiscordConfig;
	const next = _writeChain.then(async () => {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as DiscordConfig;
		const updated = apply(parsed);
		const serialized = `${JSON.stringify(updated, null, 2)}\n`;
		const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
		writeFileSync(tmpPath, serialized, { mode: 0o600 });
		renameSync(tmpPath, configPath);
		result = updated;
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

export function logSwitchEvent(workspaceDir: string, event: SwitchEvent): void {
	const dir = join(workspaceDir, "logs");
	try {
		mkdirSync(dir, { recursive: true });
	} catch (err) {
		log.logWarning("logSwitchEvent: mkdir failed", err instanceof Error ? err.message : String(err));
	}
	const path = join(dir, "model-switches.jsonl");
	try {
		appendFileSync(path, `${JSON.stringify(event)}\n`);
	} catch (err) {
		log.logWarning("logSwitchEvent: append failed", err instanceof Error ? err.message : String(err));
	}
}

// ----------------------------------------------------------------------------
// Discord interaction dedup — tiny ring buffer.
// ----------------------------------------------------------------------------

const RECENT_INTERACTIONS_LIMIT = 64;
const _recentInteractions: string[] = [];
const _recentInteractionSet = new Set<string>();

/** Returns true if this interaction.id was seen recently (i.e. duplicate delivery). */
export function isDuplicateInteraction(interactionId: string): boolean {
	if (_recentInteractionSet.has(interactionId)) return true;
	_recentInteractions.push(interactionId);
	_recentInteractionSet.add(interactionId);
	if (_recentInteractions.length > RECENT_INTERACTIONS_LIMIT) {
		const old = _recentInteractions.shift()!;
		_recentInteractionSet.delete(old);
	}
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
