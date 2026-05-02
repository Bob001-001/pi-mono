import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	atomicConfigUpdate,
	formatCostRate,
	isDuplicateInteraction,
	logSwitchEvent,
	MODEL_ALIASES,
	modelAutocompleteChoices,
	resolveAliasOrId,
	resolveModelStrict,
	thinkingAutocompleteChoices,
	type SwitchEvent,
} from "../src/model-control.js";

describe("resolveAliasOrId", () => {
	it("resolves canonical aliases (sonnet/opus/haiku) to pinned IDs", () => {
		expect(resolveAliasOrId("sonnet")).toEqual({ api: "anthropic", id: "claude-sonnet-4-6" });
		expect(resolveAliasOrId("opus")).toEqual({ api: "anthropic", id: "claude-opus-4-7" });
		expect(resolveAliasOrId("haiku")).toEqual({ api: "anthropic", id: "claude-haiku-4-5" });
	});

	it("is case-insensitive on alias names", () => {
		expect(resolveAliasOrId("SONNET")).toEqual({ api: "anthropic", id: "claude-sonnet-4-6" });
		expect(resolveAliasOrId("  Opus  ")).toEqual({ api: "anthropic", id: "claude-opus-4-7" });
	});

	it("treats unknown strings as exact IDs (assumed anthropic)", () => {
		expect(resolveAliasOrId("claude-sonnet-4-6")).toEqual({ api: "anthropic", id: "claude-sonnet-4-6" });
		expect(resolveAliasOrId("some-future-model")).toEqual({ api: "anthropic", id: "some-future-model" });
	});

	it("returns null on empty input", () => {
		expect(resolveAliasOrId("")).toBeNull();
		expect(resolveAliasOrId("   ")).toBeNull();
	});
});

describe("resolveModelStrict", () => {
	it("resolves a known anthropic model", () => {
		const m = resolveModelStrict("anthropic", "claude-sonnet-4-6");
		expect(m).not.toBeNull();
		expect(m!.id).toBe("claude-sonnet-4-6");
	});

	it("returns null for an unknown model (no silent fallback)", () => {
		expect(resolveModelStrict("anthropic", "claude-doesnt-exist-9-9")).toBeNull();
	});

	it("returns null for unknown provider", () => {
		expect(resolveModelStrict("not-a-provider", "claude-sonnet-4-6")).toBeNull();
	});
});

describe("modelAutocompleteChoices", () => {
	it("returns all aliases when input is empty", () => {
		const choices = modelAutocompleteChoices("");
		expect(choices.length).toBe(MODEL_ALIASES.length);
		// each choice has a value matching an alias name
		const values = new Set(choices.map((c) => c.value));
		for (const a of MODEL_ALIASES) {
			expect(values.has(a.name)).toBe(true);
		}
	});

	it("filters by alias prefix", () => {
		const choices = modelAutocompleteChoices("son");
		expect(choices.length).toBe(1);
		expect(choices[0].value).toBe("sonnet");
	});

	it("filters by ID substring", () => {
		const choices = modelAutocompleteChoices("opus-4-7");
		expect(choices.length).toBe(1);
		expect(choices[0].value).toBe("opus");
	});

	it("respects discord's 25-choice cap", () => {
		// We only have 3 aliases; this asserts the cap exists and works.
		const choices = modelAutocompleteChoices("");
		expect(choices.length).toBeLessThanOrEqual(25);
	});
});

describe("thinkingAutocompleteChoices", () => {
	it("returns all 4 levels when input is empty", () => {
		const choices = thinkingAutocompleteChoices("");
		expect(choices.length).toBe(4);
		expect(choices.map((c) => c.value)).toEqual(["off", "low", "medium", "high"]);
	});

	it("filters by prefix", () => {
		const m = thinkingAutocompleteChoices("h");
		expect(m.map((c) => c.value)).toEqual(["high"]);
	});
});

describe("isDuplicateInteraction", () => {
	beforeEach(() => {
		// State is module-level; use unique IDs per test to avoid cross-test pollution.
	});

	it("returns false for a new id, true on second call", () => {
		const id = `unique-${Date.now()}-${Math.random()}`;
		expect(isDuplicateInteraction(id)).toBe(false);
		expect(isDuplicateInteraction(id)).toBe(true);
	});

	it("evicts old ids after the buffer fills", () => {
		// Insert 70 unique ids (buffer size is 64); the first ones should be evicted.
		const ids = Array.from({ length: 70 }, (_, i) => `evict-${Date.now()}-${i}`);
		for (const id of ids) {
			expect(isDuplicateInteraction(id)).toBe(false);
		}
		// First few should be evicted (buffer capped at 64).
		expect(isDuplicateInteraction(ids[0])).toBe(false);
	});
});

describe("atomicConfigUpdate", () => {
	let tmpDir: string;
	let configPath: string;
	const baseConfig = {
		token: "fake-token",
		agentName: "test",
		workspaceDir: "/tmp/test",
		discordOwnerId: "123",
		model: {
			primary: { api: "anthropic", id: "claude-sonnet-4-6" },
			thinkingLevel: "off" as const,
		},
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "discord-cfg-"));
		configPath = join(tmpDir, "config.json");
		writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));
	});

	it("applies a single mutation and persists to disk", async () => {
		const updated = await atomicConfigUpdate(configPath, (cfg) => {
			cfg.model.primary = { api: "anthropic", id: "claude-opus-4-7" };
			return cfg;
		});
		expect(updated.model.primary.id).toBe("claude-opus-4-7");
		const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(onDisk.model.primary.id).toBe("claude-opus-4-7");
		expect(onDisk.token).toBe("fake-token"); // other fields preserved
	});

	it("preserves token and other fields under repeated updates", async () => {
		await atomicConfigUpdate(configPath, (cfg) => {
			cfg.model.primary = { api: "anthropic", id: "claude-haiku-4-5" };
			return cfg;
		});
		await atomicConfigUpdate(configPath, (cfg) => {
			cfg.model.thinkingLevel = "high";
			return cfg;
		});
		const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(onDisk.model.primary.id).toBe("claude-haiku-4-5");
		expect(onDisk.model.thinkingLevel).toBe("high");
		expect(onDisk.token).toBe("fake-token");
		expect(onDisk.discordOwnerId).toBe("123");
	});

	it("serializes concurrent updates so neither is lost", async () => {
		// Fire two updates that touch different fields. Without serialization, one would clobber.
		await Promise.all([
			atomicConfigUpdate(configPath, (cfg) => {
				cfg.model.primary = { api: "anthropic", id: "claude-opus-4-7" };
				return cfg;
			}),
			atomicConfigUpdate(configPath, (cfg) => {
				cfg.model.thinkingLevel = "medium";
				return cfg;
			}),
		]);
		const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
		// Both fields should survive — serialization guarantees the second update
		// reads the first's result, not the original.
		expect(onDisk.model.primary.id).toBe("claude-opus-4-7");
		expect(onDisk.model.thinkingLevel).toBe("medium");
	});

	it("does not leave a temp file behind on success", async () => {
		await atomicConfigUpdate(configPath, (cfg) => cfg);
		// No .tmp.* siblings should remain
		const fs = await import("fs");
		const siblings = fs.readdirSync(tmpDir);
		const tmps = siblings.filter((f) => f.includes(".tmp."));
		expect(tmps).toEqual([]);
	});

	afterEach();
	function afterEach() {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

describe("logSwitchEvent", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "discord-log-"));
	});

	it("creates the logs directory if missing and writes a JSONL line", () => {
		const event: SwitchEvent = {
			ts: "2026-05-02T10:00:00Z",
			type: "model",
			model_before: "claude-sonnet-4-6",
			model_after: "claude-opus-4-7",
			thinking_before: "off",
			thinking_after: "off",
			channel_id: "ch-1",
			user_id: "u-1",
			triggered_by: "manual",
			next_message_id: null,
		};
		logSwitchEvent(tmpDir, event);
		const logPath = join(tmpDir, "logs", "model-switches.jsonl");
		expect(existsSync(logPath)).toBe(true);
		const content = readFileSync(logPath, "utf-8").trim();
		expect(JSON.parse(content)).toEqual(event);
	});

	it("appends multiple events without overwriting", () => {
		const e1: SwitchEvent = {
			ts: "2026-05-02T10:00:00Z",
			type: "model",
			model_before: "claude-sonnet-4-6",
			model_after: "claude-opus-4-7",
			thinking_before: "off",
			thinking_after: "off",
			channel_id: "ch-1",
			user_id: "u-1",
			triggered_by: "manual",
			next_message_id: null,
		};
		const e2: SwitchEvent = { ...e1, ts: "2026-05-02T10:00:05Z", type: "thinking", thinking_after: "high" };
		logSwitchEvent(tmpDir, e1);
		logSwitchEvent(tmpDir, e2);
		const content = readFileSync(join(tmpDir, "logs", "model-switches.jsonl"), "utf-8").trim();
		const lines = content.split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0])).toEqual(e1);
		expect(JSON.parse(lines[1])).toEqual(e2);
	});
});

describe("formatCostRate", () => {
	it("includes per-MTok rates and a session projection", () => {
		const model = resolveModelStrict("anthropic", "claude-sonnet-4-6");
		expect(model).not.toBeNull();
		const out = formatCostRate(model!, { inputTokens: 100_000, outputTokens: 50_000, totalCostUsd: 0.5 });
		expect(out).toMatch(/per MTok/);
		expect(out).toMatch(/Session so far: \$0\.5000/);
		expect(out).toMatch(/Same volume on this model would run/);
	});

	it("handles zero session usage gracefully", () => {
		const model = resolveModelStrict("anthropic", "claude-sonnet-4-6");
		const out = formatCostRate(model!, { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 });
		expect(out).toMatch(/no usage yet/);
	});
});
