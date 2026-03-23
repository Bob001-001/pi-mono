// ============================================================================
// Discord Bot Configuration Types
// ============================================================================

export interface ModelConfig {
	api: string; // e.g. "anthropic"
	id: string; // e.g. "claude-sonnet-4-5"
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
	model: {
		primary: ModelConfig;
		fallback?: ModelConfig;
		fallbackTrigger?: FallbackTrigger;
	};
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

	return config as DiscordConfig;
}
