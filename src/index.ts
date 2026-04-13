import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { serveHealth, serveLanding } from "./site";
import { QUERY_DESCRIPTION, TOOL_DESCRIPTION, TOOL_NAME } from "./tool/prompt";
import { createSeenContent, type SeenContent, searchWikipedia } from "./tool/search";

export class WikiSearchMCP extends McpAgent {
	server = new McpServer({
		name: "WikiSearch",
		version: "1.0.0",
	});

	seenContent: SeenContent = createSeenContent();

	async init() {
		this.server.tool(
			TOOL_NAME,
			TOOL_DESCRIPTION,
			{ query: z.string().describe(QUERY_DESCRIPTION) },
			async ({ query }) => ({
				content: [{ type: "text" as const, text: await searchWikipedia(query, this.seenContent) }],
			}),
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return WikiSearchMCP.serve("/mcp").fetch(request, env, ctx);
		}
		if (url.pathname === "/health") return serveHealth();
		return serveLanding();
	},
};
