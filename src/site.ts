const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WikiSearch MCP</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0a;
    --fg: #e8e6e3;
    --dim: #6b6b6b;
    --accent: #c4b5a0;
    --border: #1e1e1e;
    --code-bg: #141414;
  }

  body {
    font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.7;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 80px 24px;
  }

  main {
    max-width: 900px;
    width: 100%;
  }

  h1 {
    font-size: 14px;
    font-weight: 400;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 48px;
  }

  h1 span {
    color: var(--dim);
    font-weight: 300;
  }

  p {
    font-size: 13px;
    color: var(--dim);
    margin-bottom: 24px;
  }

  p.lead {
    font-size: 15px;
    color: var(--fg);
    margin-bottom: 40px;
  }

  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 40px 0;
  }

  .section-label {
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 16px;
  }

  code {
    font-family: inherit;
    background: var(--code-bg);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
    color: var(--accent);
  }

  pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px 20px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.6;
    margin-bottom: 24px;
    color: var(--fg);
  }

  pre .comment { color: var(--dim); }
  pre .key { color: var(--accent); }
  pre .str { color: #8b9e82; }

  a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
    transition: border-color 0.2s;
  }
  a:hover { border-color: var(--accent); }

  footer {
    margin-top: 64px;
    font-size: 11px;
    color: var(--dim);
  }

  footer a { font-size: 11px; }
</style>
</head>
<body>
<main>
  <h1>WikiSearch <span>MCP</span></h1>

  <p class="lead">Wikipedia search for agents.</p>

  <hr class="divider">

  <div class="section-label">Setup</div>

  <pre><span class="comment"># Claude Code</span>
claude mcp add wikisearch \\
  --transport sse \\
  https://wikisearch.sauerslabs.workers.dev/mcp</pre>

  <pre><span class="comment">// Claude Desktop &mdash; claude_desktop_config.json</span>
{
  <span class="key">"mcpServers"</span>: {
    <span class="key">"wikisearch"</span>: {
      <span class="key">"type"</span>: <span class="str">"url"</span>,
      <span class="key">"url"</span>: <span class="str">"https://wikisearch.sauerslabs.workers.dev/mcp"</span>
    }
  }
}</pre>

  <hr class="divider">

  <div class="section-label">Usage</div>

  <p>One tool: <code>search_wikipedia</code></p>

  <p>Pass article titles, topics, or descriptive phrases. Section matching is automatic &mdash; include keywords to target specific sections.</p>

  <pre><span class="comment">// exact article</span>
<span class="str">"Albert Einstein"</span>

<span class="comment">// targeted section</span>
<span class="str">"Hafnium chemical properties"</span>

<span class="comment">// general search</span>
<span class="str">"largest earthquakes in Japan"</span></pre>

  <p>Exact matches return the article with relevant sections. No match returns lead sections of top 3 results. Redirects are followed automatically. Results are XML, ~4000 chars max.</p>

  <p>Within a session, previously returned pages are deduplicated.</p>

  <footer>
    <a href="https://github.com/SauersML/wikitool">source</a>
  </footer>
</main>
</body>
</html>`;

export function serveLanding(): Response {
	return new Response(HTML, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

export function serveHealth(): Response {
	return Response.json({ status: "ok", timestamp: new Date().toISOString() });
}
