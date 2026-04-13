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

  .flow {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    margin-bottom: 24px;
  }

  .flow-node {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px 20px;
    font-size: 13px;
    color: var(--fg);
    text-align: center;
    line-height: 1.5;
  }

  .flow-node span {
    display: block;
    font-size: 11px;
    color: var(--dim);
    margin-top: 2px;
  }

  .flow-hi {
    border-color: #2a2520;
    color: var(--accent);
  }

  .flow-pipe {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .flow-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    width: 100%;
    position: relative;
  }

  .flow-split::before {
    content: "parallel";
    position: absolute;
    top: -14px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 9px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--dim);
  }

  .flow-split .flow-node { width: 100%; }

  .flow-routes {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
    width: 100%;
  }

  .flow-route {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .flow-tag {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--dim);
    text-transform: uppercase;
  }

  .flow-route .flow-node { width: 100%; }

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

  <hr class="divider">

  <div class="section-label">How it works</div>

  <div class="flow">
    <div class="flow-node flow-hi">query</div>
    <div class="flow-pipe"></div>
    <div class="flow-split">
      <div class="flow-node">title lookup<span>does this article exist?</span></div>
      <div class="flow-node">fulltext search<span>what articles mention this?</span></div>
    </div>
    <div class="flow-pipe"></div>
    <div class="flow-routes">
      <div class="flow-route">
        <div class="flow-tag">exact match</div>
        <div class="flow-node flow-hi">single article<span>auto-detect relevant sections</span></div>
      </div>
      <div class="flow-route">
        <div class="flow-tag">partial match</div>
        <div class="flow-node flow-hi">single article<span>extra query words select sections</span></div>
      </div>
      <div class="flow-route">
        <div class="flow-tag">no match</div>
        <div class="flow-node">top 3 results<span>lead section + best matching section</span></div>
      </div>
    </div>
    <div class="flow-pipe"></div>
    <div class="flow-node">clean wikitext<span>strip markup, templates, refs, boilerplate</span></div>
    <div class="flow-pipe"></div>
    <div class="flow-node">truncate at sentence boundaries</div>
    <div class="flow-pipe"></div>
    <div class="flow-node">deduplicate across session</div>
    <div class="flow-pipe"></div>
    <div class="flow-node flow-hi">response &thinsp;~4K chars</div>
  </div>

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
