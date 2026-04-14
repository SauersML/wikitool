import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageParam,
	Tool,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { createSeenContent, type SeenContent, searchWikipedia } from "../tool/search";

// ─── Config ─────────────────────────────────────────────────────────────────

const KEY_LS = "wikisearch.key";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 12;

const KEY_VALID = /^sk-ant-api\d+-[A-Za-z0-9_\-]{10,}$/;
const KEY_ADMIN = /^sk-ant-admin/;

const TOOL: Tool = {
	name: "search_wikipedia",
	description:
		"Search Wikipedia for factual information. Returns article content as XML (~4K chars). " +
		"Pass article titles, topics, or descriptive phrases — e.g. \"Albert Einstein\", \"Tōhoku earthquake\". " +
		"To target a specific section within an article, include section keywords in the query " +
		"(e.g. \"Hafnium chemical properties\", \"World War I causes\"). " +
		"Repeated queries across a conversation are deduplicated at sentence granularity, " +
		"so calling the tool multiple times on related topics gives new information each time.",
	input_schema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Article title, topic, or descriptive phrase. Include section keywords to target specific article sections.",
			},
		},
		required: ["query"],
	},
};

const SYSTEM = `You are a research assistant with access to a Wikipedia search tool. You help users understand facts, entities, events, and ideas by retrieving information from Wikipedia and synthesizing clear, accurate answers.

Use search_wikipedia when a question involves named entities, specific figures, dates, counts, or events — especially anything recent or outside common knowledge. Skip the tool for simple arithmetic, definitions you're certain of, or purely creative tasks.

Search with article titles or topics (e.g. "Albert Einstein", "Tōhoku earthquake"). For specific content within an article, add section keywords ("Hafnium chemical properties"). If a first search is insufficient, refine and try again — multiple calls per turn are fine.

Cite the article and section you drew from. Be direct and concise. If the tool returns nothing useful, say so rather than speculating.`;

// ─── State ──────────────────────────────────────────────────────────────────

type Conversation = MessageParam[];

const state = {
	key: null as string | null,
	keyPersistent: false,
	conversation: [] as Conversation,
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

function forgetKey() {
	localStorage.removeItem(KEY_LS);
	sessionStorage.removeItem(KEY_LS);
	state.key = null;
	state.keyPersistent = false;
}

function fingerprint(key: string): string {
	return `${key.slice(0, 14)}…${key.slice(-4)} · ${state.keyPersistent ? "localStorage" : "sessionStorage"}`;
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
	const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 80;
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
		"Compare the flight envelopes of the SR-71 and the MiG-25.",
		"What is hafnium's role in nuclear reactors?",
		"Summarize the causes of the 2011 Tōhoku earthquake.",
	]) {
		const b = el("button", {}, q);
		b.addEventListener("click", () => {
			($("input") as HTMLTextAreaElement).value = q;
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

function beginAssistantMessage(): { body: HTMLElement; wrapper: HTMLElement } {
	const wrapper = el("div", { class: "msg assistant" });
	const body = el("div", { class: "body" });
	const cursor = el("span", { class: "cursor" });
	wrapper.append(body, cursor);
	$("messages").append(wrapper);
	autoscroll(true);
	return { body, wrapper };
}

function endAssistantMessage(wrapper: HTMLElement) {
	const cursor = wrapper.querySelector(".cursor");
	if (cursor) cursor.remove();
}

type ToolCard = {
	root: HTMLElement;
	setQuery: (q: string) => void;
	setState: (s: "running" | "ok" | "error") => void;
	setResult: (body: string, isError: boolean) => void;
};

function renderToolCard(): ToolCard {
	const root = el("div", { class: "tool" });
	const head = el("div", { class: "tool-head" });
	const label = el("span", { class: "label" }, "search_wikipedia");
	const query = el("span", { class: "query" }, "");
	const stateSpan = el("span", { class: "state running" }, "running");
	const chev = el("span", { class: "chev" }, "›");
	head.append(label, query, stateSpan, chev);
	const body = el("div", { class: "tool-body" });
	body.textContent = "Searching…";
	root.append(head, body);
	head.addEventListener("click", () => root.classList.toggle("open"));

	$("messages").append(root);
	autoscroll();

	return {
		root,
		setQuery(q) {
			query.textContent = q ? `"${q}"` : "";
		},
		setState(s) {
			stateSpan.className = `state ${s}`;
			stateSpan.textContent = s;
		},
		setResult(text, isError) {
			body.textContent = text;
			body.classList.toggle("error", isError);
		},
	};
}

function renderError(message: string, onRetry?: () => void) {
	const banner = el("div", { class: "error-banner" });
	banner.append(el("span", {}, message));
	if (onRetry) {
		const btn = el("button", {}, "retry");
		btn.addEventListener("click", () => {
			banner.remove();
			onRetry();
		});
		banner.append(btn);
	}
	const close = el("button", {}, "×");
	close.addEventListener("click", () => banner.remove());
	banner.append(close);
	$("messages").append(banner);
	autoscroll(true);
}

function setStatus(text: string, tone: "" | "ok" = "") {
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

// ─── Anthropic error extraction ─────────────────────────────────────────────

function formatError(err: unknown): string {
	if (err instanceof Anthropic.APIError) {
		const msg = (err as { message?: string }).message || "API error";
		// Strip any embedded request body/headers just in case.
		return `${err.status ?? ""} ${msg}`.trim();
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

// ─── Agent loop ─────────────────────────────────────────────────────────────

async function runAgentLoop(userText: string) {
	if (!state.key) {
		openKeyModal();
		return;
	}
	state.conversation.push({ role: "user", content: userText });
	renderUserMessage(userText);

	const client = new Anthropic({
		apiKey: state.key,
		dangerouslyAllowBrowser: true,
	});

	setStreamingUI(true);
	setStatus("thinking");

	try {
		for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
			state.abortController = new AbortController();
			const assistant = beginAssistantMessage();

			const stream = client.messages.stream(
				{
					model: MODEL,
					max_tokens: MAX_TOKENS,
					system: SYSTEM,
					tools: [TOOL],
					messages: state.conversation,
				},
				{ signal: state.abortController.signal },
			);

			const toolCards = new Map<number, ToolCard>();

			stream.on("text", (delta, _snapshot) => {
				assistant.body.appendChild(document.createTextNode(delta));
				autoscroll();
			});

			stream.on("contentBlock", (block) => {
				if (block.type === "tool_use") {
					// Nothing to do — card was already created on start.
				}
			});

			stream.on("streamEvent", (event) => {
				if (event.type === "content_block_start") {
					if (event.content_block.type === "tool_use") {
						const card = renderToolCard();
						toolCards.set(event.index, card);
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "input_json_delta") {
						const card = toolCards.get(event.index);
						if (!card) return;
						try {
							const accum = (card as ToolCard & { _accum?: string })._accum || "";
							const next = accum + event.delta.partial_json;
							(card as ToolCard & { _accum?: string })._accum = next;
							const match = next.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)/);
							if (match) card.setQuery(unescapeJsonString(match[1]));
						} catch {
							/* ignore partial-json errors */
						}
					}
				}
			});

			const final = await stream.finalMessage();
			endAssistantMessage(assistant.wrapper);

			// If the assistant produced no visible text, drop the empty body.
			if (!assistant.body.textContent) {
				assistant.body.remove();
			}

			state.conversation.push({ role: "assistant", content: final.content });

			if (final.stop_reason !== "tool_use") {
				setStatus("");
				break;
			}

			// Execute tool calls.
			const toolUses = final.content.filter(
				(b): b is ToolUseBlock => b.type === "tool_use",
			);
			const results: ToolResultBlockParam[] = [];
			setStatus("searching");

			for (let i = 0; i < toolUses.length; i++) {
				const tu = toolUses[i];
				const card = [...toolCards.values()][i] ?? renderToolCard();
				const input = (tu.input ?? {}) as { query?: string };
				const query = (input.query || "").trim();
				card.setQuery(query);

				if (tu.name !== "search_wikipedia" || !query) {
					card.setState("error");
					card.setResult(`Invalid tool call: ${tu.name}`, true);
					results.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: "Error: invalid tool call.",
						is_error: true,
					});
					continue;
				}

				try {
					const text = await searchWikipedia(query, state.seen);
					card.setState("ok");
					card.setResult(text, false);
					results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
				} catch (err) {
					const msg = `Wikipedia search failed: ${formatError(err)}`;
					card.setState("error");
					card.setResult(msg, true);
					results.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: msg,
						is_error: true,
					});
				}
			}

			state.conversation.push({ role: "user", content: results });
			setStatus("thinking");
		}
	} catch (err) {
		const aborted = state.abortController?.signal.aborted;
		if (!aborted) {
			renderError(formatError(err), () => runAgentLoop(userText));
			// Roll back the user message so retry doesn't duplicate it.
			state.conversation = state.conversation.slice(0, -1);
		}
	} finally {
		state.abortController = null;
		setStreamingUI(false);
		setStatus("");
	}
}

function unescapeJsonString(s: string): string {
	return s.replace(/\\(.)/g, (_m, c) => {
		if (c === "n") return "\n";
		if (c === "t") return "\t";
		if (c === "r") return "\r";
		if (c === '"') return '"';
		if (c === "\\") return "\\";
		return c;
	});
}

// ─── Input handling ─────────────────────────────────────────────────────────

function submit() {
	const input = $("input") as HTMLTextAreaElement;
	const text = input.value.trim();
	if (!text || state.streaming) return;
	input.value = "";
	resizeTextarea();
	runAgentLoop(text);
}

function resizeTextarea() {
	const input = $("input") as HTMLTextAreaElement;
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function openKeyModal(replace = false) {
	const modal = $("key-modal");
	const input = $("key-input") as HTMLInputElement;
	const err = $("key-error");
	const persist = $("key-persist") as HTMLInputElement;
	input.value = "";
	err.textContent = "";
	persist.checked = state.keyPersistent || !replace;
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
			"Admin keys are too powerful for a chat UI (they can create/delete keys and manage billing). Use a regular API key.";
		return;
	}
	if (!KEY_VALID.test(key)) {
		err.textContent = "Doesn't look like an Anthropic API key (expected sk-ant-api…).";
		return;
	}
	saveKey(key, persist.checked);
	closeKeyModal();
	setStatus("key saved", "ok");
	setTimeout(() => setStatus(""), 2000);
}

function openSettings() {
	if (!state.key) {
		openKeyModal();
		return;
	}
	const fp = $("key-fp");
	fp.textContent = fingerprint(state.key);
	$("settings-modal").hidden = false;
}

function closeSettings() {
	$("settings-modal").hidden = true;
}

function newConversation() {
	state.conversation = [];
	state.seen = createSeenContent();
	renderEmpty();
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

	$("settings-btn").addEventListener("click", openSettings);
	$("new-chat").addEventListener("click", newConversation);

	$("settings-close").addEventListener("click", closeSettings);
	$("key-replace").addEventListener("click", () => {
		closeSettings();
		openKeyModal(true);
	});
	$("key-forget").addEventListener("click", () => {
		forgetKey();
		closeSettings();
		renderEmpty();
		setStatus("key forgotten", "ok");
		setTimeout(() => setStatus(""), 2000);
	});

	$("key-save").addEventListener("click", handleKeySave);
	$("key-cancel").addEventListener("click", closeKeyModal);
	$("key-input").addEventListener("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Enter") {
			e.preventDefault();
			handleKeySave();
		}
	});

	// Close modals on backdrop click
	for (const id of ["key-modal", "settings-modal"]) {
		const m = $(id);
		m.addEventListener("click", (e) => {
			if (e.target === m) {
				// Don't dismiss key modal if it's required (no key set).
				if (id === "key-modal" && !state.key) return;
				m.hidden = true;
			}
		});
	}

	// Keyboard: Esc closes modals
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			if (!$("settings-modal").hidden) closeSettings();
			else if (!$("key-modal").hidden && state.key) closeKeyModal();
		}
	});

	// First-run: prompt for key
	if (!state.key) openKeyModal();
	else input.focus();
}

init();
