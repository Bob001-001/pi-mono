import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const webSearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	query: Type.String({ description: "Search query string" }),
	count: Type.Optional(Type.Number({ description: "Number of results to return (default: 8, max: 20)" })),
});

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8888";

/** Search via local SearXNG instance (self-hosted, free, unlimited). */
async function searchSearXNG(query: string, count: number): Promise<SearchResult[]> {
	const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`);
	const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
	return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
}

/** Search via Brave Search API (requires BRAVE_SEARCH_API_KEY env var). */
async function searchBrave(query: string, count: number): Promise<SearchResult[]> {
	const key = process.env.BRAVE_SEARCH_API_KEY;
	if (!key) throw new Error("no-brave-key");

	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
	const res = await fetch(url, {
		headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
	});
	if (!res.ok) throw new Error(`Brave API ${res.status}: ${res.statusText}`);
	const data = (await res.json()) as {
		web?: { results?: Array<{ title: string; url: string; description: string }> };
	};
	return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

/** Search via duck-duck-scrape (free, no API key). May be rate-limited. */
async function searchDDG(query: string, count: number): Promise<SearchResult[]> {
	const DDG = await import("duck-duck-scrape");
	const res = await DDG.search(query, { safeSearch: DDG.SafeSearchType.OFF });
	if (!res.results || res.results.length === 0) return [];
	return res.results.slice(0, count).map((r: any) => ({
		title: r.title,
		url: r.url,
		snippet: r.description || "",
	}));
}

function formatResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No results found for: ${query}`;
	const formatted = results
		.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet || "(no snippet)"}`)
		.join("\n\n");
	return `Search results for "${query}" (${results.length} results):\n\n${formatted}`;
}

export const webSearchTool: AgentTool<typeof webSearchSchema> = {
	name: "web_search",
	label: "web search",
	description:
		"Search the web. Returns titles, URLs, and snippets. Use for researching topics, finding current information, competitive analysis, and market research.",
	parameters: webSearchSchema,
	execute: async (_toolCallId, { query, count }, signal?) => {
		if (signal?.aborted) throw new Error("Operation aborted");

		const maxResults = Math.min(count ?? 8, 20);
		let results: SearchResult[];
		let source: string;

		// Priority: SearXNG (self-hosted) > Brave (API key) > DuckDuckGo (free)
		try {
			results = await searchSearXNG(query, maxResults);
			source = "SearXNG";
		} catch {
			if (process.env.BRAVE_SEARCH_API_KEY) {
				results = await searchBrave(query, maxResults);
				source = "Brave";
			} else {
				try {
					results = await searchDDG(query, maxResults);
					source = "DuckDuckGo";
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					if (msg.includes("anomaly")) {
						return {
							content: [
								{
									type: "text" as const,
									text: `All search backends failed. SearXNG not reachable, DuckDuckGo rate-limited. Query: ${query}`,
								},
							],
							details: undefined,
						};
					}
					throw e;
				}
			}
		}

		return {
			content: [{ type: "text" as const, text: formatResults(query, results) }],
			details: { source },
		};
	},
};
