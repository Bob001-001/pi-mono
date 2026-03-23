/**
 * Context management for pi-discord.
 *
 * Mirrors mom/src/context.ts — two files per channel:
 * - context.jsonl: Structured API messages for LLM context
 * - log.jsonl: Human-readable channel history for grep
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import { type SessionManager, type SessionMessageEntry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 * Ensures messages logged while bot wasn't running are added to LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param excludeTs - Discord message ID of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");
	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					const attachmentsIdx = normalized.indexOf("\n\n<discord_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf("\n\n<discord_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const msgTs = logMsg.ts;
			const date = logMsg.date;
			if (!msgTs || !date) continue;

			if (excludeTs && msgTs === excludeTs) continue;

			if (logMsg.isBot) continue;

			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText);
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// Settings manager for Discord bot
// ============================================================================

type DiscordSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements DiscordSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createDiscordSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}
