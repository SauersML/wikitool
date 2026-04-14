import { TOOL_NAME } from "./tool/prompt";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>WikiSearch MCP</title>
<link rel="icon" type="image/svg+xml" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="%230a0a0a" rx="8"/><text x="32" y="49" text-anchor="middle" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="44" font-weight="700" fill="%23c4b5a0" letter-spacing="-2">WS</text></svg>'>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0a;
    --fg: #e8e6e3;
    --dim: #6b6b6b;
    --accent: #c4b5a0;
    --border: #1e1e1e;
    --border-strong: #2a2520;
    --code-bg: #141414;
    --user-tint: #1a1814;
    --danger: #c46a6a;
    --ok: #8b9e82;
    --mono: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
  }

  body {
    font-family: var(--mono);
    background: var(--bg);
    color: var(--fg);
    line-height: 1.7;
    min-height: 100vh;
    padding: 64px 24px 80px;
  }

  main {
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
  }

  /* ─── Typography ─── */

  h1 {
    font-size: 14px;
    font-weight: 400;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  h1 span { color: var(--dim); font-weight: 300; }

  p { font-size: 13px; color: var(--dim); margin-bottom: 24px; }
  p.lead { font-size: 15px; color: var(--fg); margin-bottom: 0; }

  .divider { border: none; border-top: 1px solid var(--border); margin: 40px 0; }

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
  pre .str { color: var(--ok); }

  a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
    transition: border-color 0.2s;
  }
  a:hover { border-color: var(--accent); }

  button {
    font-family: inherit;
    font-size: inherit;
    background: none;
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 6px 12px;
    border-radius: 3px;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  input, textarea, select {
    font-family: inherit;
    font-size: inherit;
    background: var(--code-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 10px 12px;
    outline: none;
    width: 100%;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--border-strong); }
  textarea { resize: none; line-height: 1.6; }

  /* ─── Hero / chat panel ─── */

  .hero { margin-bottom: 12px; }
  .hero .lead-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin: 18px 0 24px;
    flex-wrap: wrap;
  }
  .hero .lead-row p { margin: 0; }
  .hero .actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .hero .actions button {
    font-size: 11px;
    padding: 6px 10px;
    color: var(--dim);
  }
  .hero .status {
    font-size: 11px;
    color: var(--dim);
    padding-right: 8px;
    font-style: italic;
  }
  .hero .status.ok { color: var(--ok); }
  .hero .status.err { color: var(--danger); }

  .chat-panel {
    display: flex;
    flex-direction: column;
    height: min(640px, 70vh);
    min-height: 440px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #080808;
    overflow: hidden;
  }

  .chat-messages {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 20px 22px;
    scroll-behavior: smooth;
    font-size: 13px;
  }
  .chat-messages::-webkit-scrollbar { width: 8px; }
  .chat-messages::-webkit-scrollbar-track { background: transparent; }
  .chat-messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .chat-messages::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }

  .empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    color: var(--dim);
    gap: 20px;
    padding: 20px;
  }
  .empty h2 {
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .empty p { max-width: 420px; font-size: 12px; line-height: 1.7; margin: 0; }
  .empty .examples { display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 460px; }
  .empty .examples button {
    font-size: 12px;
    color: var(--fg);
    padding: 8px 14px;
    text-align: left;
    letter-spacing: 0;
    text-transform: none;
  }

  .msg { margin-bottom: 22px; }
  .msg.user {
    background: var(--user-tint);
    padding: 10px 14px;
    border-radius: 12px 12px 4px 12px;
    max-width: 75%;
    width: fit-content;
    margin-left: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .msg.assistant .body {
    word-wrap: break-word;
    line-height: 1.7;
  }
  .msg.assistant .body.streaming { white-space: pre-wrap; }
  .msg.assistant .body { color: var(--fg); }
  .msg.assistant .body p { color: var(--fg); margin: 0 0 10px; font-size: 13px; }
  .msg.assistant .body p:last-child { margin-bottom: 0; }
  .msg.assistant .body li { color: var(--fg); font-size: 13px; }
  .msg.assistant .body h3 { font-size: 14px; font-weight: 500; color: var(--accent); margin: 16px 0 6px; }
  .msg.assistant .body h4 { font-size: 13px; font-weight: 500; color: var(--accent); margin: 14px 0 4px; }
  .msg.assistant .body h5, .msg.assistant .body h6 { font-size: 12px; font-weight: 500; color: var(--accent); margin: 12px 0 4px; }
  .msg.assistant .body ul, .msg.assistant .body ol { padding-left: 22px; margin: 0 0 10px; list-style-type: disc; }
  .msg.assistant .body li { margin: 2px 0; }
  .msg.assistant .body li > p { margin: 0 0 4px; }
  .msg.assistant .body strong { color: var(--fg); font-weight: 700; }
  .msg.assistant .body em { font-style: italic; }
  .msg.assistant .body code {
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 2px;
    font-size: 12px;
    color: var(--accent);
  }
  .msg.assistant .body pre {
    background: var(--code-bg);
    border: 1px solid var(--border);
    padding: 10px 14px;
    border-radius: 3px;
    overflow-x: auto;
    margin: 10px 0;
  }
  .msg.assistant .body pre code { background: none; padding: 0; color: var(--fg); font-size: 12px; }
  .msg.assistant .body a { color: var(--accent); border-bottom: 1px solid var(--border); word-break: break-word; }
  .msg.assistant .body a:hover { border-color: var(--accent); }
  .msg.assistant .body blockquote {
    border-left: 2px solid var(--border);
    padding-left: 12px;
    color: var(--dim);
    margin: 0 0 10px;
  }
  .msg.assistant .cursor {
    display: inline-block;
    width: 7px;
    height: 14px;
    background: var(--accent);
    vertical-align: text-bottom;
    margin-left: 2px;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .tool {
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--code-bg);
    margin: 10px 0;
    font-size: 12px;
    overflow: hidden;
  }
  .tool .tool-head {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    color: var(--dim);
    gap: 10px;
  }
  .tool .tool-head:hover { color: var(--fg); }
  .tool .tool-head .label { color: var(--accent); flex-shrink: 0; }
  .tool .tool-head .query {
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    font-style: italic;
  }
  .tool .tool-head .state {
    font-size: 11px;
    flex-shrink: 0;
    font-style: italic;
  }
  .tool .tool-head .state.running { color: var(--accent); }
  .tool .tool-head .state.ok { color: var(--ok); }
  .tool .tool-head .state.error { color: var(--danger); }
  .tool .tool-head .chev {
    display: inline-block;
    font-size: 10px;
    color: var(--dim);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .tool.open .tool-head .chev { transform: rotate(90deg); }
  .tool .tool-body {
    display: none;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--border);
    color: var(--dim);
    font-size: 11px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 300px;
    overflow-y: auto;
  }
  .tool.open .tool-body { display: block; }
  .tool .tool-body.error { color: var(--danger); }

  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .tool.running .tool-head .state.running .dots,
  .tool.running .tool-head .state.searching {
    animation: pulse 1.4s ease-in-out infinite;
  }
  .tool-head .state .dots { letter-spacing: 0.2em; font-size: 8px; }
  .tool-head .state.searching { color: var(--accent); }
  .tool-head .state .detail { color: var(--dim); margin-left: 8px; font-style: italic; }

  .hero .status:not(:empty)::after {
    content: "●";
    display: inline-block;
    margin-left: 6px;
    font-size: 9px;
    animation: pulse 1.4s ease-in-out infinite;
    vertical-align: middle;
  }
  .hero .status.ok::after { display: none; }

  .error-banner {
    border: 1px solid var(--danger);
    border-radius: 3px;
    padding: 10px 14px;
    margin: 0 0 16px;
    font-size: 12px;
    color: var(--danger);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .error-banner span { flex: 1; min-width: 0; word-wrap: break-word; }
  .error-banner .actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
  .error-banner button {
    border-color: var(--danger);
    color: var(--danger);
    padding: 4px 10px;
    font-size: 11px;
  }
  .error-banner button:hover { background: var(--danger); color: var(--bg); border-color: var(--danger); }
  .error-banner .dismiss {
    border: none;
    background: none;
    font-size: 18px;
    padding: 0 6px;
    line-height: 1;
    color: inherit;
    letter-spacing: 0;
  }
  .error-banner .dismiss:hover {
    background: none;
    border: none;
    color: var(--fg);
  }

  /* Soft-error banners (auth, network, rate-limit, overloaded) — recoverable,
     so they use the accent color instead of the hard-error red. */
  .error-banner.auth,
  .error-banner.network,
  .error-banner.rate_limit,
  .error-banner.overloaded {
    border-color: var(--accent);
    color: var(--accent);
  }
  .error-banner.auth button:not(.dismiss),
  .error-banner.network button:not(.dismiss),
  .error-banner.rate_limit button:not(.dismiss),
  .error-banner.overloaded button:not(.dismiss) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .error-banner.auth button:not(.dismiss):hover,
  .error-banner.network button:not(.dismiss):hover,
  .error-banner.rate_limit button:not(.dismiss):hover,
  .error-banner.overloaded button:not(.dismiss):hover {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
  }

  .chat-composer {
    flex-shrink: 0;
    padding: 12px 14px 14px;
    border-top: 1px solid var(--border);
    background: #080808;
  }
  .chat-composer form {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .chat-composer textarea {
    flex: 1;
    min-height: 40px;
    max-height: 160px;
    overflow-y: auto;
  }
  .chat-composer button.send {
    padding: 10px 18px;
    border-color: var(--accent);
    color: var(--accent);
    font-size: 12px;
    flex-shrink: 0;
  }
  .chat-composer button.send:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
  .chat-composer button.stop {
    padding: 10px 18px;
    border-color: var(--danger);
    color: var(--danger);
    font-size: 12px;
    flex-shrink: 0;
  }
  .chat-composer button.stop:hover { background: var(--danger); color: var(--bg); border-color: var(--danger); }
  .chat-composer .hint {
    font-size: 10px;
    color: var(--dim);
    margin-top: 6px;
    letter-spacing: 0.05em;
  }

  /* ─── Modal ─── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 100;
  }
  .modal-backdrop[hidden] { display: none; }
  .modal {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 28px;
    max-width: 520px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
  }
  .modal h2 {
    font-size: 14px;
    color: var(--accent);
    margin-bottom: 20px;
    font-weight: 500;
  }
  .modal p { font-size: 12px; color: var(--dim); margin-bottom: 14px; line-height: 1.65; }
  .modal .field { margin-bottom: 16px; }
  .modal label {
    display: block;
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 6px;
  }
  .modal .row {
    display: flex;
    gap: 8px;
    margin-top: 18px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .modal .row.left { justify-content: flex-start; }
  .modal .row button.primary { border-color: var(--accent); color: var(--accent); }
  .modal .row button.primary:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
  .modal .row button.danger { border-color: var(--danger); color: var(--danger); }
  .modal .row button.danger:hover { background: var(--danger); color: var(--bg); border-color: var(--danger); }
  .modal .checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--dim);
    cursor: pointer;
  }
  .modal .checkbox input { width: auto; }
  .modal .error { color: var(--danger); font-size: 11px; margin-top: 6px; min-height: 16px; }
  .modal .fingerprint {
    font-size: 11px;
    color: var(--accent);
    background: var(--code-bg);
    padding: 8px 12px;
    border-radius: 3px;
    border: 1px solid var(--border);
    word-break: break-all;
  }
  .modal .note { font-size: 10px; color: var(--dim); margin-top: 4px; letter-spacing: 0.02em; line-height: 1.6; }
  .modal .note strong { color: var(--fg); font-weight: 400; }

  /* ─── Flow diagram ─── */

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
  .flow-hi { border-color: var(--border-strong); color: var(--accent); }
  .flow-pipe { width: 1px; height: 20px; background: var(--border); }
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
  .flow-routes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; }
  .flow-route { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .flow-tag {
    font-size: 10px;
    letter-spacing: 0.1em;
    color: var(--dim);
    text-transform: uppercase;
  }
  .flow-route .flow-node { width: 100%; }

  /* ─── Evals ─── */

  .eval-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 24px; }
  .eval-card {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 14px 18px;
  }
  .eval-card h3 { font-size: 13px; font-weight: 500; color: var(--accent); margin-bottom: 6px; }
  .eval-card p { font-size: 12px; color: var(--dim); margin-bottom: 0; line-height: 1.5; }
  .eval-card .eval-meta {
    font-size: 11px;
    color: var(--dim);
    margin-top: 8px;
    opacity: 0.8;
    font-style: italic;
  }

  footer { margin-top: 64px; font-size: 11px; color: var(--dim); }
  footer a { font-size: 11px; }

  @media (max-width: 600px) {
    body { padding: 32px 16px 48px; }
    .chat-panel { height: min(580px, 72vh); min-height: 380px; }
    .chat-messages { padding: 16px; }
  }
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>WikiSearch <span>MCP</span></h1>

    <div class="lead-row">
      <p class="lead">Wikipedia search for agents. Try it below &mdash; your API key stays in your browser.</p>
      <div class="actions">
        <span class="status" id="status"></span>
        <button id="new-chat" title="Start a new conversation">new chat</button>
        <button id="replace-key" title="Replace your API key">replace key</button>
        <button id="forget-key" title="Remove your API key from this browser">forget key</button>
      </div>
    </div>

    <div class="chat-panel">
      <div class="chat-messages" id="messages"></div>
      <div class="chat-composer">
        <form id="composer-form">
          <textarea id="input" placeholder="Ask anything…" rows="1" autocomplete="off" autocapitalize="sentences" spellcheck="true"></textarea>
          <button type="submit" class="send" id="send-btn">send</button>
        </form>
        <div class="hint">enter to send · shift+enter for newline</div>
      </div>
    </div>
  </section>

  <hr class="divider">

  <section id="setup">
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
  </section>

  <hr class="divider">

  <section id="usage">
    <div class="section-label">Usage</div>

    <p>One tool: <code>${TOOL_NAME}</code></p>

    <p>Pass article titles, topics, or descriptive phrases. Section matching is automatic &mdash; include keywords to target specific sections.</p>

    <pre><span class="comment">// exact article</span>
<span class="str">"Albert Einstein"</span>

<span class="comment">// targeted section</span>
<span class="str">"Hafnium chemical properties"</span>

<span class="comment">// general search</span>
<span class="str">"largest earthquakes in Japan"</span></pre>
  </section>

  <hr class="divider">

  <section id="how">
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
          <div class="flow-node">top 3 results<span>lead + best matching section per result &mdash; budget weighted by rank (60% / 25% / 15%)</span></div>
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
  </section>

  <hr class="divider">

  <section id="evals">
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
        <p>Haiku 4.5 implements 20 non-trivial algorithms in Python (Aho-Corasick, SA-IS, Bentley-Ottmann, Earley parser, and more) using a server-side code execution sandbox, then Opus runs the code, writes additional tests, and grades each implementation.</p>
        <div class="eval-meta">20 algorithms &middot; graded by Opus &middot; correctness, helpfulness, elegance, completion (40 pts)</div>
      </div>
    </div>
  </section>

  <footer>
    <a href="https://github.com/SauersML/wikitool">source</a>
  </footer>
</main>

<!-- Key entry modal -->
<div class="modal-backdrop" id="key-modal" hidden>
  <div class="modal">
    <h2>Anthropic API key</h2>
    <p>This chat runs entirely in your browser. Your key is stored only on this device and sent directly to <code>api.anthropic.com</code> — never to our server. Search queries go straight from your browser to <code>en.wikipedia.org</code>.</p>
    <div class="field">
      <label for="key-input">API key</label>
      <input type="password" id="key-input" placeholder="sk-ant-api03-…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="error" id="key-error"></div>
    </div>
    <label class="checkbox">
      <input type="checkbox" id="key-persist">
      <span>Remember across browser sessions (localStorage). Otherwise cleared when the tab closes.</span>
    </label>
    <p class="note" style="margin-top:14px;">Recommended: create a dedicated key with a spend limit at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>.</p>
    <div class="row">
      <button id="key-cancel">cancel</button>
      <button class="primary" id="key-save">save</button>
    </div>
  </div>
</div>

<script type="module" src="/chat.js"></script>
</body>
</html>`;

export function serveLanding(): Response {
	return new Response(HTML, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": [
				"default-src 'none'",
				"script-src 'self'",
				"style-src 'unsafe-inline'",
				"connect-src https://api.anthropic.com https://en.wikipedia.org",
				"img-src data:",
				"font-src 'none'",
				"frame-ancestors 'none'",
				"base-uri 'none'",
			].join("; "),
			"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
		},
	});
}

export function serveHealth(): Response {
	return Response.json({ status: "ok", timestamp: new Date().toISOString() });
}
