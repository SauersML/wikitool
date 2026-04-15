# WikiSearch

A Wikipedia search tool for LLMs. One tool, `search_wikipedia`, available as an MCP server for agents and as a browser chat for people.

**Live:** <https://wikisearch.sauerslabs.workers.dev>

## How it works

```
query → search Wikipedia → one article (exact title) or a few articles
      → clean wikitext → skip already-seen sentences → ~4K chars of XML
```

Each query runs a title lookup and a fulltext search in parallel. The wikitext is parsed into plain text: infoboxes become `key: value` lines, numeric templates like `{{convert}}` and `{{coord}}` are kept, references and boilerplate are removed. The response is capped at about 4000 characters, cut at a sentence boundary. Sentences already returned earlier in the session are not returned again.

## Use it

**As an MCP server** — any MCP client:

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

**As a browser chat** — the live URL is a chat interface running Claude Haiku 4.5 with `search_wikipedia` enabled. You provide an Anthropic API key, which is stored in your browser. Model requests go directly to `api.anthropic.com` and Wikipedia requests go directly to `en.wikipedia.org`; the server only serves the page and the `/mcp` endpoint.

## Run locally

macOS, one line (assumes [Homebrew](https://brew.sh)):

```bash
brew install bun && git clone https://github.com/SauersML/wikitool.git && cd wikitool && bun install && bun run dev
```

Then open <http://localhost:8787>. Local MCP clients can connect to `http://localhost:8787/mcp`.

Other scripts:

```bash
bun run deploy   # deploy to Cloudflare Workers (needs `wrangler login` once)
bun test         # unit tests
bun run evals    # benchmark suite (needs ANTHROPIC_API_KEY in .env)
bun run lint     # biome
```

## Evals

Eleven benchmarks compare Haiku 4.5 with and without the tool. Per-eval details on the [landing page](https://wikisearch.sauerslabs.workers.dev).
