import {
	AttachmentBuilder,
	type DMChannel,
	type Message,
	type NewsChannel,
	type TextChannel,
	type ThreadChannel,
} from "discord.js";
import { readFileSync } from "fs";
import { basename } from "path";
import * as log from "./log.js";

// ============================================================================
// Discord message context (replaces SlackContext)
// ============================================================================

export interface DiscordContextMessage {
	text: string;
	rawText: string;
	user: string;
	userName?: string;
	channel: string;
	ts: string; // Discord message ID (snowflake)
	attachments: Array<{ local: string }>;
}

export interface DiscordContext {
	message: DiscordContextMessage;
	channelName?: string;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

// Discord's message character limit
const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a long message into chunks at natural break points.
 * Respects code block boundaries to avoid splitting mid-block.
 */
export function splitMessage(text: string, maxLen: number = DISCORD_MAX_LENGTH): string[] {
	if (text.length <= maxLen) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}

		// Try to split at a newline within the limit
		const slice = remaining.substring(0, maxLen);
		const lastNewline = slice.lastIndexOf("\n");

		let splitAt: number;
		if (lastNewline > maxLen / 2) {
			// Good break point found
			splitAt = lastNewline + 1;
		} else {
			// Fall back to hard split at max length
			splitAt = maxLen;
		}

		chunks.push(remaining.substring(0, splitAt));
		remaining = remaining.substring(splitAt);
	}

	return chunks;
}

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

/**
 * Send potentially long text to a Discord channel, splitting at 2000 chars.
 */
export async function sendChunked(channel: SendableChannel, text: string): Promise<Message<boolean>> {
	const chunks = splitMessage(text);
	let lastMessage: Message<boolean> | null = null;

	for (const chunk of chunks) {
		lastMessage = await channel.send(chunk);
	}

	return lastMessage!;
}

/**
 * Create a DiscordContext adapter from a discord.js Message.
 * Mirrors createSlackContext in mom's main.ts.
 */
export function createDiscordContext(triggerMessage: Message, _workingDir: string, isEvent?: boolean): DiscordContext {
	let botMessage: Message | null = null;
	const threadMessages: Message[] = [];
	let thread: ThreadChannel | null = null;
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const eventFilename = isEvent ? triggerMessage.content.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	const channel = triggerMessage.channel as SendableChannel;

	const sendOrUpdate = async (text: string): Promise<void> => {
		const displayText = isWorking ? text + workingIndicator : text;
		if (botMessage) {
			// Discord only allows editing own messages; truncate to 2000 chars
			const truncated =
				displayText.length > DISCORD_MAX_LENGTH
					? `${displayText.substring(0, DISCORD_MAX_LENGTH - 3)}...`
					: displayText;
			await botMessage.edit(truncated);
		} else {
			const chunks = splitMessage(displayText);
			botMessage = await channel.send(chunks[0]);
			for (let i = 1; i < chunks.length; i++) {
				await channel.send(chunks[i]);
			}
		}
	};

	return {
		message: {
			text: triggerMessage.content,
			rawText: triggerMessage.content,
			user: triggerMessage.author.id,
			userName: triggerMessage.author.username,
			channel: triggerMessage.channelId,
			ts: triggerMessage.id,
			attachments: [],
		},
		channelName:
			triggerMessage.channel.isTextBased() && "name" in triggerMessage.channel
				? (triggerMessage.channel as TextChannel).name
				: undefined,

		respond: async (text: string, _shouldLog = true): Promise<void> => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

					// Truncate accumulated text if too long
					const MAX_MAIN_LENGTH = 1800;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (accumulatedText.length > MAX_MAIN_LENGTH) {
						accumulatedText =
							accumulatedText.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					}

					await sendOrUpdate(accumulatedText);
				} catch (err) {
					log.logWarning("Discord respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string): Promise<void> => {
			updatePromise = updatePromise.then(async () => {
				try {
					const MAX_MAIN_LENGTH = 1800;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (text.length > MAX_MAIN_LENGTH) {
						accumulatedText = text.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					} else {
						accumulatedText = text;
					}

					await sendOrUpdate(accumulatedText);
				} catch (err) {
					log.logWarning("Discord replaceMessage error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string): Promise<void> => {
			updatePromise = updatePromise.then(async () => {
				try {
					if (!thread) {
						// Create a thread on the trigger message
						if ("startThread" in triggerMessage && botMessage) {
							thread = await botMessage.startThread({
								name: "Details",
								autoArchiveDuration: 60,
							});
						} else {
							// Fall back to posting in the same channel
							const chunks = splitMessage(text);
							for (const chunk of chunks) {
								const msg = await channel.send(chunk);
								threadMessages.push(msg);
							}
							return;
						}
					}

					const chunks = splitMessage(text);
					for (const chunk of chunks) {
						const msg = await thread.send(chunk);
						threadMessages.push(msg);
					}
				} catch (err) {
					log.logWarning("Discord respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean): Promise<void> => {
			if (isTyping && !botMessage) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!botMessage) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking..._";
							await sendOrUpdate(accumulatedText);
						}
					} catch (err) {
						log.logWarning("Discord setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}

			// Also call sendTyping() to show the typing indicator (lasts ~10s)
			try {
				if (isTyping && "sendTyping" in channel) {
					await channel.sendTyping();
				}
			} catch {
				// Non-fatal
			}
		},

		uploadFile: async (filePath: string, title?: string): Promise<void> => {
			try {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);
				const attachment = new AttachmentBuilder(fileContent, { name: fileName });
				await channel.send({ files: [attachment] });
			} catch (err) {
				log.logWarning("Discord uploadFile error", err instanceof Error ? err.message : String(err));
			}
		},

		setWorking: async (working: boolean): Promise<void> => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (botMessage && accumulatedText) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						const truncated =
							displayText.length > DISCORD_MAX_LENGTH
								? `${displayText.substring(0, DISCORD_MAX_LENGTH - 3)}...`
								: displayText;
						await botMessage.edit(truncated);
					}
				} catch (err) {
					log.logWarning("Discord setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		deleteMessage: async (): Promise<void> => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages in reverse
				for (let i = threadMessages.length - 1; i >= 0; i--) {
					try {
						await threadMessages[i].delete();
					} catch {
						// Ignore
					}
				}
				threadMessages.length = 0;

				// Delete thread itself if created
				if (thread) {
					try {
						await thread.delete();
					} catch {
						// Ignore
					}
					thread = null;
				}

				// Delete main bot message
				if (botMessage) {
					try {
						await botMessage.delete();
					} catch {
						// Ignore
					}
					botMessage = null;
				}

				accumulatedText = "";
			});
			await updatePromise;
		},
	};
}
