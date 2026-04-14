import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	RawMessageStreamEvent,
	TextBlockParam,
	Tool,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from "../tool/prompt";
import { createSeenContent, type SeenContent, searchWikipedia } from "../tool/search";

// ─── Config ─────────────────────────────────────────────────────────────────

const KEY_LS = "wikisearch.key";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 20;

const KEY_VALID = /^sk-ant-api\d+-[A-Za-z0-9_-]{10,}$/;
const KEY_ADMIN = /^sk-ant-admin/;

const TOOL: Tool = {
	name: TOOL_NAME,
	description: TOOL_DESCRIPTION,
	input_schema: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

const LAST_TURN_WARNING =
	"[System note: you have one more tool call available after this one. Use it only if strictly necessary — otherwise answer now based on what you have gathered.]";

const FORCE_ANSWER_NUDGE =
	"You have reached your tool-call limit. Do not call any more tools. Based on the information you have gathered so far, provide your best final answer now.";

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
	key: null as string | null,
	keyPersistent: false,
	conversation: [] as MessageParam[],
	seen: createSeenContent() as SeenContent,
	streaming: false,
	abortController: null as AbortController | null,
};

// ─── Key storage ────────────────────────────────────────────────────────────

function loadKey(): { key: string; persistent: boolean } | null {
	const local = localStorage.getItem(KEY_LS);
	if (local) return { key: local, persistent: true };
	const sess = sessionStorage.getItem(KEY_LS);
	if (sess) return { key: sess, persistent: false };
	return null;
}

function saveKey(key: string, persistent: boolean) {
	localStorage.removeItem(KEY_LS);
	sessionStorage.removeItem(KEY_LS);
	(persistent ? localStorage : sessionStorage).setItem(KEY_LS, key);
	state.key = key;
	state.keyPersistent = persistent;
}

/** Aborts any in-flight Anthropic stream so the Anthropic client (which closes
 *  over state.key) drops its reference and the key becomes unreachable. */
function abortAnyStream() {
	if (state.abortController) {
		state.abortController.abort();
		state.abortController = null;
	}
	state.streaming = false;
}

function forgetKey() {
	abortAnyStream();
	localStorage.removeItem(KEY_LS);
	sessionStorage.removeItem(KEY_LS);
	state.key = null;
	state.keyPersistent = false;
	// Drop the whole conversation too — tool queries may reveal what the user
	// was researching; the new user shouldn't inherit that.
	state.conversation = [];
	state.seen = createSeenContent();
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else node.setAttribute(k, v);
	}
	if (text !== undefined) node.textContent = text;
	return node;
}

function $<T extends Element = HTMLElement>(id: string): T {
	const e = document.getElementById(id);
	if (!e) throw new Error(`Missing #${id}`);
	return e as unknown as T;
}

function autoscroll(force = false) {
	const main = $("messages");
	const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 100;
	if (force || atBottom) main.scrollTop = main.scrollHeight;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderEmpty() {
	const messages = $("messages");
	messages.innerHTML = "";
	const empty = el("div", { class: "empty" });
	empty.append(
		el("h2", {}, "Wikipedia, for agents"),
		el(
			"p",
			{},
			"Ask anything. The assistant searches Wikipedia as needed; repeat searches are deduplicated so the model gets fresh content each turn.",
		),
	);
	const examples = el("div", { class: "examples" });
	for (const q of [
		"Who topped the medal table at the 2026 Winter Olympics, and how many golds did they win?",
		"List the five largest earthquakes ever recorded, with year and location.",
		"What health risks are linked to asbestos exposure, and which diseases most strongly?",
	]) {
		const b = el("button", {}, q);
		b.addEventListener("click", () => {
			const input = $("input") as HTMLTextAreaElement;
			input.value = q;
			resizeTextarea();
			submit();
		});
		examples.append(b);
	}
	empty.append(examples);
	messages.append(empty);
}

function clearEmpty() {
	const empty = document.querySelector(".empty");
	if (empty) empty.remove();
}

function renderUserMessage(text: string) {
	clearEmpty();
	const msg = el("div", { class: "msg user" }, text);
	$("messages").append(msg);
	autoscroll(true);
}

type TextBlock = { kind: "text"; node: HTMLElement; cursor: HTMLElement; raw: string };
type ToolBlockState = {
	kind: "tool";
	card: ToolCard;
	jsonAccum: string;
	serverToolUseId: string | null;
};
type BlockState = TextBlock | ToolBlockState;

function createTextBlock(): TextBlock {
	clearEmpty();
	const node = el("div", { class: "msg assistant" });
	const body = el("div", { class: "body streaming" });
	const cursor = el("span", { class: "cursor" });
	node.append(body, cursor);
	$("messages").append(node);
	autoscroll(true);
	return { kind: "text", node: body, cursor, raw: "" };
}

function appendTextDelta(block: TextBlock, delta: string) {
	block.raw += delta;
	block.node.appendChild(document.createTextNode(delta));
	autoscroll();
}

function finalizeTextBlock(block: TextBlock) {
	block.cursor.remove();
	if (!block.raw) {
		block.node.parentElement?.remove();
		return;
	}
	block.node.classList.remove("streaming");
	block.node.replaceChildren(renderMarkdown(block.raw));
}

// ─── Minimal, safe markdown renderer ────────────────────────────────────────
// DOM-only (no innerHTML), link URLs restricted to http/https, builds nodes
// with createElement + textContent so model output can't inject script tags
// or event handlers even if prompt-injected via Wikipedia content.

function renderMarkdown(md: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	const lines = md.split("\n");
	let i = 0;

	const isBlockStart = (line: string) => /^(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s?)/.test(line);

	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === "") {
			i++;
			continue;
		}

		// Fenced code block
		if (/^```/.test(line)) {
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				buf.push(lines[i]);
				i++;
			}
			if (i < lines.length) i++;
			const pre = document.createElement("pre");
			const code = document.createElement("code");
			code.textContent = buf.join("\n");
			pre.appendChild(code);
			frag.appendChild(pre);
			continue;
		}

		// Heading — # and ## both render as h3 (biggest in-message heading),
		// then ### → h4, #### → h5, etc.
		const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (h) {
			const hashes = h[1].length;
			const level = hashes <= 2 ? 3 : Math.min(hashes + 1, 6);
			const el = document.createElement(`h${level}` as "h3" | "h4" | "h5" | "h6");
			renderInline(h[2], el);
			frag.appendChild(el);
			i++;
			continue;
		}

		// Unordered list — tolerate blank lines between items.
		if (/^[-*+]\s+/.test(line)) {
			const ul = document.createElement("ul");
			while (i < lines.length) {
				if (/^[-*+]\s+/.test(lines[i])) {
					const li = document.createElement("li");
					renderInline(lines[i].replace(/^[-*+]\s+/, ""), li);
					ul.appendChild(li);
					i++;
				} else if (lines[i].trim() === "" && /^[-*+]\s+/.test(lines[i + 1] ?? "")) {
					i++;
				} else {
					break;
				}
			}
			frag.appendChild(ul);
			continue;
		}

		// Ordered list — tolerate blank lines between items so "1.\n\n2.\n\n3."
		// renders as one list, not three lists each starting at "1.".
		if (/^\d+\.\s+/.test(line)) {
			const ol = document.createElement("ol");
			while (i < lines.length) {
				if (/^\d+\.\s+/.test(lines[i])) {
					const li = document.createElement("li");
					renderInline(lines[i].replace(/^\d+\.\s+/, ""), li);
					ol.appendChild(li);
					i++;
				} else if (lines[i].trim() === "" && /^\d+\.\s+/.test(lines[i + 1] ?? "")) {
					i++;
				} else {
					break;
				}
			}
			frag.appendChild(ol);
			continue;
		}

		// Blockquote
		if (/^>\s?/.test(line)) {
			const bq = document.createElement("blockquote");
			const parts: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) {
				parts.push(lines[i].replace(/^>\s?/, ""));
				i++;
			}
			renderInline(parts.join(" "), bq);
			frag.appendChild(bq);
			continue;
		}

		// Paragraph: collect until blank line or block-starting line
		const para: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
			para.push(lines[i]);
			i++;
		}
		const p = document.createElement("p");
		renderInline(para.join(" "), p);
		frag.appendChild(p);
	}

	return frag;
}

/** Render inline markdown (code, bold, italic, links) into a parent node.
 *  Recursive: bold/italic/link bodies are rendered inline too. */
function renderInline(text: string, parent: Node) {
	// Ordered by priority: `code`, **bold**, *italic*, [link](url).
	// Single combined regex; earliest match in the string wins.
	const re =
		/`([^`\n]+)`|\*\*([^*\n][^*\n]*?)\*\*|\*([^*\n][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/;
	let remaining = text;
	while (remaining.length > 0) {
		const m = remaining.match(re);
		if (!m || m.index === undefined) {
			parent.appendChild(document.createTextNode(remaining));
			return;
		}
		if (m.index > 0) {
			parent.appendChild(document.createTextNode(remaining.slice(0, m.index)));
		}
		if (m[1] !== undefined) {
			const c = document.createElement("code");
			c.textContent = m[1];
			parent.appendChild(c);
		} else if (m[2] !== undefined) {
			const b = document.createElement("strong");
			renderInline(m[2], b);
			parent.appendChild(b);
		} else if (m[3] !== undefined) {
			const i = document.createElement("em");
			renderInline(m[3], i);
			parent.appendChild(i);
		} else if (m[4] !== undefined && m[5] !== undefined) {
			if (/^https?:\/\//i.test(m[5])) {
				const a = document.createElement("a");
				a.href = m[5];
				a.target = "_blank";
				a.rel = "noopener noreferrer";
				renderInline(m[4], a);
				parent.appendChild(a);
			} else {
				// Unsafe URL scheme — render literal text, don't create link.
				parent.appendChild(document.createTextNode(m[0]));
			}
		}
		remaining = remaining.slice(m.index + m[0].length);
	}
}

type ToolCard = {
	setQuery: (q: string) => void;
	setState: (s: "running" | "searching" | "ok" | "error", detail?: string) => void;
	setResult: (body: string, isError: boolean) => void;
	open: () => void;
};

function renderToolCard(): ToolCard {
	clearEmpty();
	const root = el("div", { class: "tool running" });
	const head = el("div", { class: "tool-head" });
	const label = el("span", { class: "label" }, TOOL_NAME);
	const query = el("span", { class: "query" }, "…");
	const stateSpan = el("span", { class: "state running" });
	const dots = el("span", { class: "dots" }, "● ● ●");
	stateSpan.append(dots);
	const chev = el("span", { class: "chev" }, "›");
	head.append(label, query, stateSpan, chev);

	const body = el("div", { class: "tool-body" }, "preparing request…");

	root.append(head, body);
	head.addEventListener("click", () => root.classList.toggle("open"));

	$("messages").append(root);
	autoscroll();

	return {
		setQuery(q) {
			query.textContent = q ? `"${q}"` : "…";
		},
		setState(s, detail) {
			root.classList.remove("running");
			stateSpan.textContent = "";
			if (s === "running") {
				root.classList.add("running");
				stateSpan.append(dots);
			} else if (s === "searching") {
				root.classList.add("running");
				stateSpan.textContent = "searching";
			} else {
				stateSpan.textContent = s;
			}
			stateSpan.className = `state ${s}`;
			if (detail) {
				const detailSpan = el("span", { class: "detail" }, detail);
				stateSpan.append(" ", detailSpan);
			}
		},
		setResult(text, isError) {
			body.textContent = text;
			body.classList.toggle("error", isError);
			if (isError) root.classList.add("open");
		},
		open() {
			root.classList.add("open");
		},
	};
}

type ErrorKind =
	| "auth"
	| "rate_limit"
	| "overloaded"
	| "server"
	| "network"
	| "client"
	| "aborted"
	| "unknown";

function classifyError(err: unknown): { kind: ErrorKind; message: string; status?: number } {
	if (err instanceof Anthropic.APIUserAbortError) return { kind: "aborted", message: "stopped" };
	if (err instanceof Anthropic.AuthenticationError) {
		return { kind: "auth", status: 401, message: "API key rejected" };
	}
	if (err instanceof Anthropic.PermissionDeniedError) {
		return { kind: "auth", status: 403, message: "Key lacks permission for this model" };
	}
	if (err instanceof Anthropic.RateLimitError) {
		return {
			kind: "rate_limit",
			status: 429,
			message: "Rate limited — wait a moment before retrying",
		};
	}
	if (err instanceof Anthropic.BadRequestError) {
		const m = extractMessage(err);
		return { kind: "client", status: 400, message: m || "Invalid request" };
	}
	if (err instanceof Anthropic.InternalServerError) {
		const status = (err as { status?: number }).status ?? 500;
		if (status === 529) return { kind: "overloaded", status, message: "Anthropic is overloaded" };
		return { kind: "server", status, message: `Anthropic error (${status})` };
	}
	if (
		err instanceof Anthropic.APIConnectionError ||
		err instanceof Anthropic.APIConnectionTimeoutError
	) {
		return { kind: "network", message: "Network error reaching Anthropic" };
	}
	if (err instanceof Anthropic.APIError) {
		return {
			kind: "unknown",
			status: (err as { status?: number }).status,
			message:
				extractMessage(err) ||
				`API error${(err as { status?: number }).status ? ` (${(err as { status?: number }).status})` : ""}`,
		};
	}
	if (err instanceof Error) {
		// Fetch-level errors from the browser
		if (/Failed to fetch|NetworkError/i.test(err.message)) {
			return { kind: "network", message: "Network error — check your connection" };
		}
		return { kind: "unknown", message: err.message };
	}
	return { kind: "unknown", message: String(err) };
}

function extractMessage(err: unknown): string {
	if (err instanceof Anthropic.APIError) {
		const errorObj = (err as { error?: { error?: { message?: string } } }).error?.error;
		return errorObj?.message || err.message || "";
	}
	return err instanceof Error ? err.message : String(err);
}

function renderError(
	kind: ErrorKind,
	message: string,
	actions: { label: string; handler: () => void }[],
) {
	const banner = el("div", { class: `error-banner ${kind}` });
	banner.append(el("span", {}, message));
	const actionsWrap = el("div", { class: "actions" });
	for (const a of actions) {
		const btn = el("button", {}, a.label);
		btn.addEventListener("click", () => {
			banner.remove();
			a.handler();
		});
		actionsWrap.append(btn);
	}
	const close = el("button", { class: "dismiss", "aria-label": "Dismiss" }, "×");
	close.addEventListener("click", () => banner.remove());
	actionsWrap.append(close);
	banner.append(actionsWrap);
	$("messages").append(banner);
	autoscroll(true);
}

function clearErrorBanners() {
	for (const b of document.querySelectorAll(".error-banner")) b.remove();
}

function setStatus(text: string, tone: "" | "ok" | "err" = "") {
	const s = $("status");
	s.textContent = text;
	s.className = tone ? `status ${tone}` : "status";
}

function setStreamingUI(streaming: boolean) {
	state.streaming = streaming;
	const input = $("input") as HTMLTextAreaElement;
	const send = $("send-btn") as HTMLButtonElement;
	input.disabled = streaming;
	if (streaming) {
		send.textContent = "stop";
		send.classList.remove("send");
		send.classList.add("stop");
		send.setAttribute("type", "button");
	} else {
		send.textContent = "send";
		send.classList.remove("stop");
		send.classList.add("send");
		send.setAttribute("type", "submit");
		input.focus();
	}
}

// ─── Streaming agent loop ───────────────────────────────────────────────────

/** Extract `query` from a partially-streamed JSON string for live preview. */
function extractPartialQuery(json: string): string | null {
	const match = json.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)/);
	if (!match) return null;
	return match[1]
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/**
 * Run one Anthropic streaming turn. Returns the final message (caller pushes to conversation).
 * Renders text and tool_use blocks as they stream. Throws on API error or user abort.
 */
async function runOneTurn(
	client: Anthropic,
	toolCardById: Map<string, ToolCard>,
	includeTools = true,
) {
	state.abortController = new AbortController();
	setStatus("thinking", "");

	const stream = client.messages.stream(
		{
			model: MODEL,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			...(includeTools ? { tools: [TOOL] } : {}),
			messages: state.conversation,
		},
		{ signal: state.abortController.signal },
	);

	const blocks = new Map<number, BlockState>();

	stream.on("connect", () => {
		setStatus("responding", "");
	});

	stream.on("streamEvent", (event: RawMessageStreamEvent) => {
		if (event.type === "content_block_start") {
			const cb = event.content_block;
			if (cb.type === "text") {
				blocks.set(event.index, createTextBlock());
			} else if (cb.type === "tool_use") {
				const card = renderToolCard();
				toolCardById.set(cb.id, card);
				blocks.set(event.index, {
					kind: "tool",
					card,
					jsonAccum: "",
					serverToolUseId: cb.id,
				});
			}
		} else if (event.type === "content_block_delta") {
			const block = blocks.get(event.index);
			if (!block) return;
			if (block.kind === "text" && event.delta.type === "text_delta") {
				appendTextDelta(block, event.delta.text);
			} else if (block.kind === "tool" && event.delta.type === "input_json_delta") {
				block.jsonAccum += event.delta.partial_json;
				const partial = extractPartialQuery(block.jsonAccum);
				if (partial !== null) block.card.setQuery(partial);
			}
		} else if (event.type === "content_block_stop") {
			const block = blocks.get(event.index);
			if (block?.kind === "text") finalizeTextBlock(block);
		}
	});

	const final = await stream.finalMessage();

	// Safety net: finalize any text blocks whose content_block_stop didn't land
	// in time (or at all). finalizeTextBlock is idempotent — cursor is already
	// gone after the first run, and re-rendering the same raw string produces
	// the same DOM. Without this, plain-text streaming stays as-is and markdown
	// like **bold** never gets transformed.
	for (const block of blocks.values()) {
		if (block.kind === "text") finalizeTextBlock(block);
	}

	setStatus("", "");
	return final;
}

/**
 * Outer agent loop. Keeps issuing turns until the model stops asking for tools
 * or we hit the safety cap. Handles tool execution between turns.
 */
async function runAgentLoop() {
	if (!state.key) {
		openKeyModal();
		return;
	}

	const client = new Anthropic({
		apiKey: state.key,
		dangerouslyAllowBrowser: true,
	});

	setStreamingUI(true);
	clearErrorBanners();
	const toolCardById = new Map<string, ToolCard>();

	try {
		for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
			toolCardById.clear();
			const final = await runOneTurn(client, toolCardById);

			state.conversation.push({ role: "assistant", content: final.content });

			if (final.stop_reason !== "tool_use") {
				return; // Normal end.
			}

			// Execute tool calls in parallel. The model can emit several tool_use
			// blocks in one turn (e.g. "check both Einstein and Gödel"); running
			// the Wikipedia requests concurrently cuts turn latency roughly by the
			// number of calls.
			const toolUses = final.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

			if (toolUses.length > 1) {
				setStatus(`searching ${toolUses.length} queries in parallel`, "");
			} else if (toolUses.length === 1) {
				const q = (((toolUses[0].input ?? {}) as { query?: string }).query || "").trim();
				setStatus(`searching "${truncate(q, 40)}"`, "");
			}

			const results: ToolResultBlockParam[] = await Promise.all(
				toolUses.map(async (tu): Promise<ToolResultBlockParam> => {
					const card = toolCardById.get(tu.id) ?? renderToolCard();
					const input = (tu.input ?? {}) as { query?: string };
					const query = (input.query || "").trim();
					card.setQuery(query);

					if (tu.name !== TOOL_NAME || !query) {
						card.setState("error");
						card.setResult(`Unknown tool or missing query: ${tu.name}`, true);
						return {
							type: "tool_result",
							tool_use_id: tu.id,
							content: "Error: invalid tool invocation.",
							is_error: true,
						};
					}

					card.setState("searching");
					try {
						const text = await searchWikipedia(query, state.seen);
						card.setState("ok");
						card.setResult(text, false);
						return { type: "tool_result", tool_use_id: tu.id, content: text };
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						card.setState("error");
						card.setResult(`Wikipedia search failed: ${message}`, true);
						return {
							type: "tool_result",
							tool_use_id: tu.id,
							content: `Error: ${message}`,
							is_error: true,
						};
					}
				}),
			);

			// Compose the user message: tool_results + any turn-budget nudge.
			// - On the turn BEFORE the last allowed tool turn, warn the model.
			// - On the last allowed tool turn itself (if still tool_use), append the
			//   force-answer nudge and then run one final turn with no tools.
			const isPenultimate = turn === MAX_TOOL_TURNS - 2;
			const isFinal = turn === MAX_TOOL_TURNS - 1;
			const userContent: Array<ToolResultBlockParam | TextBlockParam> = [...results];
			if (isPenultimate) {
				userContent.push({ type: "text", text: LAST_TURN_WARNING });
			} else if (isFinal) {
				userContent.push({ type: "text", text: FORCE_ANSWER_NUDGE });
			}
			state.conversation.push({ role: "user", content: userContent });

			if (isFinal) {
				toolCardById.clear();
				const forced = await runOneTurn(client, toolCardById, false);
				state.conversation.push({ role: "assistant", content: forced.content });
				return;
			}
		}
	} catch (err) {
		handleLoopError(err);
	} finally {
		state.abortController = null;
		setStreamingUI(false);
		setStatus("", "");
		// Clean up any text blocks that are still open (e.g. on abort mid-stream).
		for (const c of document.querySelectorAll(".msg.assistant .cursor")) c.remove();
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function handleLoopError(err: unknown) {
	const info = classifyError(err);
	if (info.kind === "aborted") return; // Silent on user abort.

	const actions: { label: string; handler: () => void }[] = [];

	if (info.kind === "auth") {
		actions.push({
			label: "update key",
			handler: () => openKeyModal(true),
		});
	} else if (
		info.kind === "network" ||
		info.kind === "overloaded" ||
		info.kind === "server" ||
		info.kind === "rate_limit"
	) {
		actions.push({ label: "retry", handler: retry });
	} else if (info.kind === "unknown") {
		actions.push({ label: "retry", handler: retry });
	}

	renderError(info.kind, info.message, actions);
}

function retry() {
	if (state.streaming) return;
	runAgentLoop();
}

// ─── Input handling ─────────────────────────────────────────────────────────

function submit() {
	if (!state.key) {
		openKeyModal();
		return;
	}
	const input = $("input") as HTMLTextAreaElement;
	const text = input.value.trim();
	if (!text || state.streaming) return;
	input.value = "";
	resizeTextarea();
	state.conversation.push({ role: "user", content: text });
	renderUserMessage(text);
	runAgentLoop();
}

function resizeTextarea() {
	const input = $("input") as HTMLTextAreaElement;
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function openKeyModal(replace = false) {
	const modal = $("key-modal");
	const input = $("key-input") as HTMLInputElement;
	const err = $("key-error");
	const persist = $("key-persist") as HTMLInputElement;
	const cancelBtn = $("key-cancel") as HTMLButtonElement;
	input.value = "";
	err.textContent = "";
	persist.checked = state.keyPersistent || !replace;
	cancelBtn.hidden = !state.key; // no cancel on first-run
	modal.hidden = false;
	setTimeout(() => input.focus(), 10);
}

function closeKeyModal() {
	$("key-modal").hidden = true;
}

function handleKeySave() {
	const input = $("key-input") as HTMLInputElement;
	const err = $("key-error");
	const persist = $("key-persist") as HTMLInputElement;
	const key = input.value.trim();
	if (!key) {
		err.textContent = "Key required.";
		return;
	}
	if (KEY_ADMIN.test(key)) {
		err.textContent =
			"Admin keys are too powerful for a chat UI (they can create keys and manage billing). Use a regular API key.";
		return;
	}
	if (!KEY_VALID.test(key)) {
		err.textContent = "Doesn't look like an Anthropic API key (expected sk-ant-api…).";
		return;
	}
	saveKey(key, persist.checked);
	closeKeyModal();
	setStatus("key saved", "ok");
	setTimeout(() => setStatus("", ""), 2000);
	// If an auth error was the reason we're here, retry.
	const hadAuthError = document.querySelector(".error-banner.auth");
	if (hadAuthError) {
		hadAuthError.remove();
		retry();
	} else {
		($("input") as HTMLTextAreaElement).focus();
	}
}

function newConversation() {
	if (state.streaming) state.abortController?.abort();
	state.conversation = [];
	state.seen = createSeenContent();
	renderEmpty();
	setStatus("", "");
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

function init() {
	const stored = loadKey();
	if (stored) {
		state.key = stored.key;
		state.keyPersistent = stored.persistent;
	}

	renderEmpty();

	const form = $("composer-form") as HTMLFormElement;
	const input = $("input") as HTMLTextAreaElement;
	const sendBtn = $("send-btn") as HTMLButtonElement;

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		submit();
	});

	sendBtn.addEventListener("click", (e) => {
		if (state.streaming) {
			e.preventDefault();
			state.abortController?.abort();
		}
	});

	input.addEventListener("input", resizeTextarea);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	});

	$("new-chat").addEventListener("click", newConversation);
	$("replace-key").addEventListener("click", () => {
		if (!state.key) {
			openKeyModal();
			return;
		}
		abortAnyStream();
		openKeyModal(true);
	});
	$("forget-key").addEventListener("click", () => {
		if (!confirm("Forget your API key? This also clears the current conversation.")) return;
		forgetKey();
		renderEmpty();
		clearErrorBanners();
		setStatus("key forgotten", "ok");
		setTimeout(() => setStatus("", ""), 2000);
		openKeyModal();
	});

	$("key-save").addEventListener("click", handleKeySave);
	$("key-cancel").addEventListener("click", () => {
		// Only allow cancel if a key is already set.
		if (state.key) closeKeyModal();
	});
	$("key-input").addEventListener("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Enter") {
			e.preventDefault();
			handleKeySave();
		}
	});

	const keyModal = $("key-modal");
	keyModal.addEventListener("click", (e) => {
		if (e.target === keyModal && state.key) keyModal.hidden = true;
	});

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !$("key-modal").hidden && state.key) closeKeyModal();
	});

	if (!state.key) openKeyModal();
	else input.focus();
}

init();
