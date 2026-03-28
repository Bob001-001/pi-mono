import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

const browseSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're doing (shown to user)" }),
	action: Type.Union(
		[
			Type.Literal("launch"),
			Type.Literal("navigate"),
			Type.Literal("screenshot"),
			Type.Literal("click"),
			Type.Literal("type"),
			Type.Literal("get_text"),
			Type.Literal("evaluate"),
			Type.Literal("wait"),
			Type.Literal("scroll"),
			Type.Literal("select"),
			Type.Literal("close"),
		],
		{ description: "Browser action to perform" },
	),
	url: Type.Optional(Type.String({ description: "URL to navigate to (for launch/navigate)" })),
	selector: Type.Optional(
		Type.String({ description: "CSS selector for the target element (for click/type/get_text/select)" }),
	),
	text: Type.Optional(Type.String({ description: "Text to type (for type action)" })),
	script: Type.Optional(Type.String({ description: "JavaScript to evaluate in page context (for evaluate)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 30000)" })),
	value: Type.Optional(Type.String({ description: "Value to select (for select action)" })),
	direction: Type.Optional(
		Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "Scroll direction (default: down)" }),
	),
	amount: Type.Optional(Type.Number({ description: "Scroll amount in pixels (default: 500)" })),
	full_page: Type.Optional(Type.Boolean({ description: "Take full page screenshot (default: false)" })),
});

type BrowseParams = Static<typeof browseSchema>;

/**
 * Derive the agent user's home directory from the workspace path.
 * e.g. "/Users/elon/.pi/workspace" → "/Users/elon"
 * Falls back to the current process's homedir if not provided.
 */
export function resolveUserHome(workspaceDir?: string): string {
	if (workspaceDir) {
		// Walk up from workspace dir to find the user home (parent of .pi)
		let dir = workspaceDir;
		while (dir !== "/" && dir !== ".") {
			const base = dir.split("/").pop();
			if (base === ".pi") {
				return dirname(dir);
			}
			dir = dirname(dir);
		}
		// If .pi not found, use two levels up from workspace as a reasonable guess
		// e.g. /Users/elon/workspace → /Users/elon
		return dirname(dirname(workspaceDir));
	}
	return homedir();
}

// Singleton browser context — one session per agent lifetime
let contextInstance: any = null;
let pageInstance: any = null;
let _activeProfileDir: string | null = null;

async function ensureBrowser(profileDir: string): Promise<{ context: any; page: any }> {
	if (contextInstance && pageInstance) {
		try {
			await pageInstance.evaluate("1");
			return { context: contextInstance, page: pageInstance };
		} catch {
			contextInstance = null;
			pageInstance = null;
		}
	}

	// Ensure profile directory exists
	mkdirSync(profileDir, { recursive: true });
	_activeProfileDir = profileDir;

	const pw = await import("playwright");

	// Use real system Chrome (not Playwright's bundled Chromium) with a persistent
	// profile. This makes the browser indistinguishable from a human's — real
	// fingerprint, real codec support, real extensions directory, persistent cookies.
	contextInstance = await pw.chromium.launchPersistentContext(profileDir, {
		channel: "chrome",
		headless: false,
		args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
		ignoreDefaultArgs: ["--enable-automation"],
		viewport: { width: 1280, height: 800 },
		locale: "en-US",
	});

	// Stealth: fully remove webdriver from navigator prototype so
	// both `navigator.webdriver` and `"webdriver" in navigator` return false.
	await contextInstance.addInitScript("delete Object.getPrototypeOf(navigator).webdriver");

	pageInstance = contextInstance.pages()[0] || (await contextInstance.newPage());
	return { context: contextInstance, page: pageInstance };
}

async function takeScreenshot(page: any, fullPage: boolean): Promise<{ data: string; mimeType: string }> {
	const buffer: Buffer = await page.screenshot({ fullPage, type: "jpeg", quality: 70 });
	return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
}

export function createBrowseTool(workspaceDir?: string): AgentTool<typeof browseSchema> {
	const userHome = resolveUserHome(workspaceDir);
	const profileDir = join(userHome, ".chrome-browse-agent");

	return {
		name: "browse",
		label: "browser",
		description: `Control a real Chrome browser for interacting with websites as a human would. Uses the system's actual Chrome with a persistent profile — cookies, sessions, and history survive across calls and restarts. Passes all bot detection. Actions:
- launch: Start browser and optionally navigate to a URL
- navigate: Go to a URL
- screenshot: Capture the current page (returns image)
- click: Click an element by CSS selector
- type: Type text into an element by CSS selector
- get_text: Extract text content from the page or a specific element
- evaluate: Run arbitrary JavaScript in the page context
- wait: Wait for a selector to appear or a timeout
- scroll: Scroll the page up or down
- select: Select an option from a dropdown
- close: Close the browser session

Pages persist between calls — navigate, interact, then extract across multiple tool calls. Cookies and login sessions persist across restarts.`,
		parameters: browseSchema,
		execute: async (_toolCallId: string, params: BrowseParams, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("Operation aborted");

			const timeoutMs = params.timeout ?? 30000;

			try {
				if (params.action === "close") {
					if (contextInstance) {
						await contextInstance.close();
						contextInstance = null;
						pageInstance = null;
					}
					return { content: [{ type: "text" as const, text: "Browser session closed." }], details: undefined };
				}

				const { page } = await ensureBrowser(profileDir);

				switch (params.action) {
					case "launch": {
						if (params.url) {
							await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
							const title = await page.title();
							const img = await takeScreenshot(page, false);
							return {
								content: [
									{ type: "text" as const, text: `Navigated to: ${params.url}\nTitle: ${title}` },
									{ type: "image" as const, data: img.data, mimeType: img.mimeType },
								],
								details: { url: params.url, title },
							};
						}
						return { content: [{ type: "text" as const, text: "Browser launched." }], details: undefined };
					}

					case "navigate": {
						if (!params.url) throw new Error("url is required for navigate action");
						await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
						const title = await page.title();
						const img = await takeScreenshot(page, false);
						return {
							content: [
								{ type: "text" as const, text: `Navigated to: ${params.url}\nTitle: ${title}` },
								{ type: "image" as const, data: img.data, mimeType: img.mimeType },
							],
							details: { url: params.url, title },
						};
					}

					case "screenshot": {
						const img = await takeScreenshot(page, params.full_page ?? false);
						const title = await page.title();
						const url = page.url();
						return {
							content: [
								{ type: "text" as const, text: `Screenshot of: ${url}\nTitle: ${title}` },
								{ type: "image" as const, data: img.data, mimeType: img.mimeType },
							],
							details: { url, title },
						};
					}

					case "click": {
						if (!params.selector) throw new Error("selector is required for click action");
						await page.click(params.selector, { timeout: timeoutMs });
						await page.waitForTimeout(500);
						const img = await takeScreenshot(page, false);
						return {
							content: [
								{ type: "text" as const, text: `Clicked: ${params.selector}` },
								{ type: "image" as const, data: img.data, mimeType: img.mimeType },
							],
							details: { selector: params.selector },
						};
					}

					case "type": {
						if (!params.selector) throw new Error("selector is required for type action");
						if (params.text === undefined) throw new Error("text is required for type action");
						await page.click(params.selector, { timeout: timeoutMs });
						await page.fill(params.selector, params.text);
						return {
							content: [{ type: "text" as const, text: `Typed "${params.text}" into ${params.selector}` }],
							details: { selector: params.selector, text: params.text },
						};
					}

					case "get_text": {
						let text: string;
						if (params.selector) {
							text = await page.textContent(params.selector, { timeout: timeoutMs });
							text = text ?? "(empty)";
						} else {
							text = await page.evaluate("document.body.innerText");
						}
						const maxLen = 8000;
						const truncated = text.length > maxLen;
						if (truncated) text = `${text.slice(0, maxLen)}\n...(truncated)`;
						return {
							content: [{ type: "text" as const, text }],
							details: { selector: params.selector ?? "body", truncated },
						};
					}

					case "evaluate": {
						if (!params.script) throw new Error("script is required for evaluate action");
						const result = await page.evaluate(params.script);
						const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
						return {
							content: [{ type: "text" as const, text: text ?? "(undefined)" }],
							details: undefined,
						};
					}

					case "wait": {
						if (params.selector) {
							await page.waitForSelector(params.selector, { timeout: timeoutMs });
							return {
								content: [{ type: "text" as const, text: `Element appeared: ${params.selector}` }],
								details: undefined,
							};
						}
						await page.waitForTimeout(timeoutMs);
						return {
							content: [{ type: "text" as const, text: `Waited ${timeoutMs}ms` }],
							details: undefined,
						};
					}

					case "scroll": {
						const dir = params.direction ?? "down";
						const px = params.amount ?? 500;
						const delta = dir === "down" ? px : -px;
						await page.evaluate(`window.scrollBy(0, ${delta})`);
						await page.waitForTimeout(300);
						const img = await takeScreenshot(page, false);
						return {
							content: [
								{ type: "text" as const, text: `Scrolled ${dir} ${px}px` },
								{ type: "image" as const, data: img.data, mimeType: img.mimeType },
							],
							details: { direction: dir, amount: px },
						};
					}

					case "select": {
						if (!params.selector) throw new Error("selector is required for select action");
						if (!params.value) throw new Error("value is required for select action");
						await page.selectOption(params.selector, params.value, { timeout: timeoutMs });
						return {
							content: [{ type: "text" as const, text: `Selected "${params.value}" in ${params.selector}` }],
							details: { selector: params.selector, value: params.value },
						};
					}

					default:
						throw new Error(`Unknown action: ${params.action}`);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Browse error (${params.action}): ${msg}`);
			}
		},
	};
}
