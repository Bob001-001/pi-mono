import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config.js";

const goodConfig = {
	token: "abc",
	agentName: "test",
	workspaceDir: "/tmp/test",
	discordOwnerId: "12345",
	model: { primary: { api: "anthropic", id: "claude-sonnet-4-6" } },
};

describe("validateConfig", () => {
	it("accepts a minimal valid config", () => {
		expect(() => validateConfig(goodConfig)).not.toThrow();
	});

	it("rejects missing discordOwnerId (REQUIRED)", () => {
		const { discordOwnerId, ...rest } = goodConfig;
		void discordOwnerId;
		expect(() => validateConfig(rest)).toThrow(/discordOwnerId/);
	});

	it("rejects empty discordOwnerId (REQUIRED + non-empty)", () => {
		expect(() => validateConfig({ ...goodConfig, discordOwnerId: "" })).toThrow(/discordOwnerId/);
	});

	it("accepts thinkingLevel when valid", () => {
		expect(() =>
			validateConfig({
				...goodConfig,
				model: { ...goodConfig.model, thinkingLevel: "high" },
			}),
		).not.toThrow();
	});

	it("rejects invalid thinkingLevel", () => {
		expect(() =>
			validateConfig({
				...goodConfig,
				model: { ...goodConfig.model, thinkingLevel: "ultra" },
			}),
		).toThrow(/thinkingLevel/);
	});

	it("rejects missing token", () => {
		const { token, ...rest } = goodConfig;
		void token;
		expect(() => validateConfig(rest)).toThrow(/token/);
	});

	it("rejects missing model.primary.id", () => {
		expect(() =>
			validateConfig({
				...goodConfig,
				model: { primary: { api: "anthropic" } },
			}),
		).toThrow(/model\.primary\.id/);
	});
});
