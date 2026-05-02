#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";
import type { DiscordConfig } from "./config.js";
import { validateConfig } from "./config.js";
import { DiscordBot } from "./discord-bot.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";

// ============================================================================
// Arg parsing
// ============================================================================

function parseArgs(): { configPath: string } {
	const args = process.argv.slice(2);
	let configPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--config" || arg === "-c") {
			configPath = args[++i];
		} else if (arg.startsWith("--config=")) {
			configPath = arg.slice("--config=".length);
		} else if (!arg.startsWith("-") && !configPath) {
			configPath = arg;
		}
	}

	if (!configPath) {
		console.error("Usage: pi-discord --config <path-to-config.json>");
		console.error("");
		console.error("Config format:");
		console.error(
			JSON.stringify(
				{
					token: "YOUR_DISCORD_BOT_TOKEN",
					agentName: "elon",
					workspaceDir: "/Users/elon/.pi/workspace",
					discordOwnerId: "YOUR_DISCORD_USER_ID",
					model: {
						primary: { api: "anthropic", id: "claude-sonnet-4-6" },
						fallback: { api: "anthropic", id: "claude-haiku-4-5" },
						fallbackTrigger: { authError: true, consecutiveTimeouts: 3 },
						thinkingLevel: "off",
					},
					observability: {
						logLevel: "info",
						metricsEnabled: true,
					},
				},
				null,
				2,
			),
		);
		process.exit(1);
	}

	return { configPath: resolve(configPath) };
}

// ============================================================================
// Main
// ============================================================================

const { configPath } = parseArgs();

let rawConfig: unknown;
try {
	const content = readFileSync(configPath, "utf-8");
	rawConfig = JSON.parse(content);
} catch (err) {
	console.error(`Failed to load config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

let config: DiscordConfig;
try {
	config = validateConfig(rawConfig);
} catch (err) {
	console.error(`Invalid config: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

log.logInfo(`Config loaded from ${configPath}`);
log.logInfo(`Agent: ${config.agentName}`);
log.logInfo(`Workspace: ${config.workspaceDir}`);
log.logInfo(`Model: ${config.model.primary.api}/${config.model.primary.id}`);
log.logInfo(`Thinking level: ${config.model.thinkingLevel ?? "off"}`);
log.logInfo(`Owner: ${config.discordOwnerId}`);

// Create and start the bot
const bot = new DiscordBot(config, configPath);

// Start events watcher
const eventsWatcher = createEventsWatcher(config.workspaceDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down (SIGINT)...");
	eventsWatcher.stop();
	bot.stop().catch(() => {});
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down (SIGTERM)...");
	eventsWatcher.stop();
	bot.stop().catch(() => {});
	process.exit(0);
});

await bot.start();
