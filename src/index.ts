import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { QUERY_DESCRIPTION, TOOL_DESCRIPTION, TOOL_NAME } from "./tool/prompt";
import { type SeenPages, createSeenPages, searchWikipedia } from "./tool/search";

export class WikiSearchMCP extends McpAgent {
	server = new McpServer({
		name: "WikiSearch",
		version: "1.0.0",
	});

	seenPages: SeenPages = createSeenPages();

	async init() {
		this.server.tool(
			TOOL_NAME,
			TOOL_DESCRIPTION,
			{ query: z.string().describe(QUERY_DESCRIPTION) },
			async ({ query }) => ({
				content: [{ type: "text" as const, text: await searchWikipedia(query, this.seenPages) }],
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
		return new Response("WikiSearch MCP Server. Connect at /mcp", { status: 200 });
	},
};
