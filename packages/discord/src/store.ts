import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

// ============================================================================
// Per-channel message store and attachment management
// ============================================================================

export interface Attachment {
	original: string;
	local: string; // path relative to working dir
}

export interface LoggedMessage {
	date: string; // ISO 8601
	ts: string; // Discord message snowflake or epoch ms
	user: string; // user ID or "bot"
	userName?: string;
	displayName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
}

interface DiscordFile {
	name: string;
	url: string;
}

export class ChannelStore {
	private workingDir: string;
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;

		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	generateLocalFilename(originalName: string, snowflake: string): string {
		// Use the snowflake as timestamp (Discord snowflakes encode creation time)
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${snowflake}_${sanitized}`;
	}

	/**
	 * Process Discord message attachments.
	 * Queues downloads in background, returns metadata immediately.
	 */
	processAttachments(channelId: string, files: DiscordFile[], messageId: string): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const filename = this.generateLocalFilename(file.name, messageId);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// Fire-and-forget download
			this.downloadAttachment(localPath, file.url).catch((err) => {
				log.logWarning(
					"Failed to download attachment",
					`${localPath}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}

		return attachments;
	}

	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}

		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		if (!message.date) {
			message.date = new Date().toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	async logBotResponse(channelId: string, text: string, messageId: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts: messageId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) return null;

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") return null;
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}

	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));

		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}
