# WikiSearch MCP

Wikipedia search for LLM agents. A single tool — `search_wikipedia` — that returns parsed, deduplicated article content as XML bounded to ~4K chars.

**Live:** <https://wikisearch.sauerslabs.workers.dev>

Not a thin API wrapper. Each query runs a parallel title-lookup + fulltext search, detects relevant sections from query words, parses wikitext (infoboxes flattened to key/value, numeric templates like `{{convert}}`/`{{val}}`/`{{coord}}` preserved, refs and boilerplate stripped), truncates at sentence boundaries, and deduplicates sentence-level across the whole session — so repeat searches yield new content instead of the same intro.

## Use it

**As an MCP server** — in any MCP client:

```bash
claude mcp add wikisearch --transport sse https://wikisearch.sauerslabs.workers.dev/mcp
```

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wikisearch": {
      "type": "url",
      "url": "https://wikisearch.sauerslabs.workers.dev/mcp"
    }
  }
}
```

**As a browser chat** — open the live link, paste an Anthropic API key, ask. The key stays in your browser (sent directly to `api.anthropic.com`); searches go directly to `en.wikipedia.org`. No server in between handles either.

## Develop

```bash
bun install
bun run dev       # http://localhost:8787 — landing + chat + /mcp + /health
bun run deploy    # Cloudflare Workers
bun test          # unit tests
bun run evals     # 11 benchmarks; needs ANTHROPIC_API_KEY in .env
```

## Evals

Eleven benchmarks compare Haiku 4.5 with and without the tool — retrieval uplift, appropriate tool abstention, robustness to tampered content, citation behavior, hallucination under tool-unavailability, and more. Methodology and per-eval details on the [landing page](https://wikisearch.sauerslabs.workers.dev).
