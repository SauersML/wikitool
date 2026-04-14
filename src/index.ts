import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import chatBundle from "../dist/chat.bundle.txt";
import { serveHealth, serveLanding } from "./site";
import { TOOL_DESCRIPTION, TOOL_NAME } from "./tool/prompt";
import { createSeenContent, type SeenContent, searchWikipedia } from "./tool/search";

export class WikiSearchMCP extends McpAgent {
	server = new McpServer({
		name: "WikiSearch",
		version: "1.0.0",
	});

	seenContent: SeenContent = createSeenContent();

	async init() {
		this.server.tool(TOOL_NAME, TOOL_DESCRIPTION, { query: z.string() }, async ({ query }) => {
			try {
				const text = await searchWikipedia(query, this.seenContent);
				return { content: [{ type: "text" as const, text }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error searching Wikipedia: ${msg}` }],
					isError: true,
				};
			}
		});
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return WikiSearchMCP.serve("/mcp").fetch(request, env, ctx);
		}
		if (url.pathname === "/health") return serveHealth();
		if (url.pathname === "/chat.js") {
			return new Response(chatBundle, {
				headers: {
					"Content-Type": "application/javascript; charset=utf-8",
					"Cache-Control": "public, max-age=300",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}
		return serveLanding();
	},
};
