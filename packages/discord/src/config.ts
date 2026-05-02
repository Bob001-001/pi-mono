// ============================================================================
// Discord Bot Configuration Types
// ============================================================================

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

export interface ModelConfig {
	api: string; // e.g. "anthropic"
	id: string; // e.g. "claude-sonnet-4-6"
}

export interface FallbackTrigger {
	authError: boolean;
	consecutiveTimeouts: number;
}

export interface DiscordConfig {
	/** Discord bot token */
	token: string;
	/** Agent name, e.g. "elon" */
	agentName: string;
	/** Workspace directory, e.g. "/Users/elon/.pi/workspace" */
	workspaceDir: string;
	/**
	 * Discord user ID of the owner. Used to gate the /model, /thinking,
	 * and /whoami slash commands. REQUIRED — bot will refuse to start
	 * without it. Find via /whoami once the bot is running, or via
	 * Discord's "Copy User ID" with developer mode enabled.
	 */
	discordOwnerId: string;
	model: {
		primary: ModelConfig;
		fallback?: ModelConfig;
		fallbackTrigger?: FallbackTrigger;
		/** Reasoning effort for the primary model. Default "off". */
		thinkingLevel?: ThinkingLevel;
	};
	/** Bot IDs whose messages should NOT be ignored (e.g. Sentry alert bot) */
	allowedBotIds?: string[];
	observability?: {
		logLevel?: string;
		metricsEnabled?: boolean;
	};
}

export function validateConfig(config: unknown): DiscordConfig {
	if (typeof config !== "object" || config === null) {
		throw new Error("Config must be an object");
	}

	const c = config as Record<string, unknown>;

	if (typeof c.token !== "string" || !c.token) {
		throw new Error("Config missing required field: token (string)");
	}
	if (typeof c.agentName !== "string" || !c.agentName) {
		throw new Error("Config missing required field: agentName (string)");
	}
	if (typeof c.workspaceDir !== "string" || !c.workspaceDir) {
		throw new Error("Config missing required field: workspaceDir (string)");
	}
	if (typeof c.discordOwnerId !== "string" || !c.discordOwnerId) {
		throw new Error(
			"Config missing required field: discordOwnerId (string). " +
				"Find your Discord user ID via the /whoami slash command (deploy first with a placeholder, " +
				"then DM /whoami to the bot), or via Discord's 'Copy User ID' option with developer mode enabled.",
		);
	}
	if (typeof c.model !== "object" || c.model === null) {
		throw new Error("Config missing required field: model (object)");
	}

	const model = c.model as Record<string, unknown>;
	if (typeof model.primary !== "object" || model.primary === null) {
		throw new Error("Config missing required field: model.primary (object)");
	}

	const primary = model.primary as Record<string, unknown>;
	if (typeof primary.api !== "string" || !primary.api) {
		throw new Error("Config missing required field: model.primary.api (string)");
	}
	if (typeof primary.id !== "string" || !primary.id) {
		throw new Error("Config missing required field: model.primary.id (string)");
	}

	if (model.thinkingLevel !== undefined) {
		if (typeof model.thinkingLevel !== "string" || !THINKING_LEVELS.includes(model.thinkingLevel as ThinkingLevel)) {
			throw new Error(`Config model.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
	}

	return config as DiscordConfig;
}
