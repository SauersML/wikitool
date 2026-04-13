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
    grid-template-columns: 1fr 1fr;
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

  .eval-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    margin-bottom: 24px;
  }

  .eval-card {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 14px 18px;
  }

  .eval-card h3 {
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
    margin-bottom: 6px;
  }

  .eval-card p {
    font-size: 12px;
    color: var(--dim);
    margin-bottom: 0;
    line-height: 1.5;
  }

  .eval-card .eval-meta {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    margin-top: 8px;
    opacity: 0.7;
  }

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
      <div class="flow-node">title lookup<span>REST API &mdash; does this exact article exist?</span></div>
      <div class="flow-node">fulltext search<span>Action API &mdash; what articles mention this?</span></div>
    </div>
    <div class="flow-pipe"></div>
    <div class="flow-routes">
      <div class="flow-route">
        <div class="flow-tag">title found</div>
        <div class="flow-node flow-hi">single article<span>detect sections from search hits + extra query words &mdash; sections prioritized, intro fills remaining budget</span></div>
      </div>
      <div class="flow-route">
        <div class="flow-tag">no title</div>
        <div class="flow-node">top 3 results<span>lead + best matching section per result &mdash; budget split evenly across results</span></div>
      </div>
    </div>
    <div class="flow-pipe"></div>
    <div class="flow-node">parse wikitext per page<span>resolve infoboxes, preserve numeric templates, strip markup/refs/boilerplate</span></div>
    <div class="flow-pipe"></div>
    <div class="flow-node">deduplicate per-article<span>sentence-level, across session &mdash; skip already-returned content</span></div>
    <div class="flow-pipe"></div>
    <div class="flow-node">truncate at sentence boundaries</div>
    <div class="flow-pipe"></div>
    <div class="flow-node flow-hi">XML response &thinsp;~4K chars</div>
  </div>

  <hr class="divider">

  <div class="section-label">Evals</div>

  <p>11 benchmarks compare model performance with and without the tool. All use Haiku 4.5 as the test model unless noted.</p>

  <div class="eval-grid">
    <div class="eval-card">
      <h3>Wiki Trivia</h3>
      <p>Questions drawn from willcb/wiki-trivia-questions, spanning obscure corners of history, biology, military technology, and geography &mdash; run with and without the tool to measure retrieval uplift.</p>
      <div class="eval-meta">25 questions &middot; exact-match judging (acceptable-answer list)</div>
    </div>

    <div class="eval-card">
      <h3>Obscure Information Retrieval</h3>
      <p>Probes whether Wikipedia access unlocks facts beyond parametric knowledge &mdash; precise figures and named individuals tied to remote villages, minor tunnels, and forgotten ghost towns across five continents.</p>
      <div class="eval-meta">20 questions &middot; numeric (2&ndash;3% tolerance) + string match</div>
    </div>

    <div class="eval-card">
      <h3>QA Precise</h3>
      <p>Technically demanding questions &mdash; from Wiles's 3-5 switch in the FLT proof to crystal field splitting energies &mdash; isolating how much retrieval improves accuracy on knowledge that is hard to recall precisely.</p>
      <div class="eval-meta">10 questions &middot; graded by Sonnet with live web search &middot; correctness + quality 1&ndash;5</div>
    </div>

    <div class="eval-card">
      <h3>HLE Sauers</h3>
      <p>Multi-step problems from Humanity's Last Exam in genetics, bioinformatics, and related fields requiring precise numerical reasoning or careful elimination of plausible-but-wrong options.</p>
      <div class="eval-meta">14 questions &middot; rule-based judge + LLM reasoning scorer (1&ndash;5)</div>
    </div>

    <div class="eval-card">
      <h3>Private QA</h3>
      <p>Hand-crafted technical questions spanning probability theory, programming language semantics, genetics, and algorithms &mdash; each paired with a reference rationale so reasoning is graded independently of correctness.</p>
      <div class="eval-meta">16 questions &middot; answer correctness + LLM reasoning score (1&ndash;5)</div>
    </div>

    <div class="eval-card">
      <h3>Good Recency</h3>
      <p>Real-world questions about late-2025 and 2026 events &mdash; sports championships, awards, geopolitical outcomes &mdash; testing whether the model recognizes its training cutoff and reaches for the tool.</p>
      <div class="eval-meta">17 questions &middot; LLM judge (answered + hallucination detection)</div>
    </div>

    <div class="eval-card">
      <h3>Bad Recency</h3>
      <p>Probes hallucination on 2026 events with no Wikipedia article &mdash; from genuinely unanswerable questions (lottery numbers, future contests) to hallucination-prone traps (Eurovision winner, Bitcoin price).</p>
      <div class="eval-meta">20 questions &middot; LLM-judged 1&ndash;5 hallucination scale</div>
    </div>

    <div class="eval-card">
      <h3>Incorrect Information Robustness</h3>
      <p>Tool results are silently tampered &mdash; correct facts swapped with plausible wrong values for obscure measurements, names, and counts &mdash; to test whether the model blindly trusts the source or cross-checks against its own knowledge.</p>
      <div class="eval-meta">20 questions &middot; strict string + numeric match</div>
    </div>

    <div class="eval-card">
      <h3>CCP Influence Benchmark</h3>
      <p>Tests whether subtly pro-CCP rewrites of Wikipedia content &mdash; softening "massacre" to "incident," "internment camps" to "vocational education centers" &mdash; shift the model's numeric opinion estimates on contested geopolitical topics.</p>
      <div class="eval-meta">20 topics &middot; Cohen's d effect size (control vs. treatment)</div>
    </div>

    <div class="eval-card">
      <h3>Unnecessary Tool Use</h3>
      <p>Measures whether the model wastes tokens calling Wikipedia on questions any trained model already knows &mdash; arithmetic, basic geography, common science facts &mdash; tracking invocation rate and token overhead.</p>
      <div class="eval-meta">10 questions &middot; exact-match judging + token comparison</div>
    </div>

    <div class="eval-card">
      <h3>Implementation Benchmark</h3>
      <p>Sonnet implements 20 non-trivial algorithms in Python (Aho-Corasick, SA-IS, Bentley-Ottmann, Earley parser, and more) using a server-side code execution sandbox, then Opus runs the code, writes additional tests, and grades each implementation.</p>
      <div class="eval-meta">20 algorithms &middot; graded by Opus &middot; correctness, helpfulness, elegance, completion (40 pts)</div>
    </div>
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
