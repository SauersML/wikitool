import { appendFile, mkdir } from "node:fs/promises";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TOOL_DESCRIPTION, TOOL_NAME } from "../tool/prompt";
import { createSeenContent, type SeenContent, searchWikipedia } from "../tool/search";

// --- Constants ---

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// --- Wiki MCP server factory ---

export interface WikiMcpOptions {
	/** Cross-call dedup state. Created fresh if omitted. */
	seen?: SeenContent;
	/** Post-process search results (used by incorrect_info / ccp_bench to tamper). */
	transform?: (result: string) => string;
}

/**
 * Create an in-process MCP server exposing the `search_wikipedia` tool.
 * Each benchmark call should create a fresh server to get clean dedup state.
 */
export function createWikiMcpServer(opts?: WikiMcpOptions) {
	const seen = opts?.seen ?? createSeenContent();
	const transform = opts?.transform;

	const wikiTool = tool(
		TOOL_NAME,
		TOOL_DESCRIPTION,
		{ query: z.string() },
		async (args) => {
			let result = await searchWikipedia(args.query, seen);
			if (transform) result = transform(result);
			return { content: [{ type: "text" as const, text: result }] };
		},
		{ annotations: { readOnlyHint: true } },
	);

	return createSdkMcpServer({ name: "wiki", tools: [wikiTool] });
}

export const WIKI_TOOL_NAME = `mcp__wiki__${TOOL_NAME}`;

/**
 * External MCP servers (claude.ai proxy) leak into Agent SDK processes via the
 * user's Claude account. Block them by default to prevent contamination of
 * "without-tool" benchmark runs.
 */
const INHERITED_MCP_TOOLS = [
	"mcp__claude_ai_wikisearch__search_wikipedia",
	"mcp__emoji-mcp__get_emoji",
];

// --- Types ---

export interface ToolCallRecord {
	name: string;
	input: Record<string, unknown>;
	result: string;
	toolUseId: string;
	isError?: boolean;
}

export interface AgentResult {
	answer: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	/** Tokens read from the prompt cache (90% cheaper than fresh input). */
	cacheReadTokens: number;
	/** Tokens written to the prompt cache this call (25% premium at 5m TTL,
	 *  100% premium at 1h TTL). Agent SDK defaults to 1h. */
	cacheCreationTokens: number;
	usedTool: boolean;
	toolCalls: ToolCallRecord[];
	/** All text blocks from assistant messages (for code extraction in impl_bench). */
	assistantTexts: string[];
	durationMs: number;
	costUsd: number;
	/** Session ID — use with `resume` for multi-turn conversations (ccp_bench). */
	sessionId: string;
}

export interface RunAgentOptions {
	prompt: string;
	system?: string;
	model?: string;
	maxTurns?: number;
	/** Built-in tools: "Bash", "Write", "Read", "WebSearch", etc. Pass [] to disable all. */
	builtinTools?: string[];
	/** MCP server configs (typically { wiki: createWikiMcpServer() }). */
	mcpServers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
	/** Tool names to auto-approve without permission prompts. */
	allowedTools?: string[];
	/** Tool names to block (overrides inherited MCP servers from the environment). */
	disallowedTools?: string[];
	/** Working directory for file/bash tools (impl_bench). */
	cwd?: string;
	/** Resume a previous session (ccp_bench multi-turn). */
	resume?: string;
}

// --- Agent runner ---

/**
 * Run the Claude Agent SDK and return a structured result.
 * Replaces the hand-rolled runAgentLoop.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
	const toolCalls: ToolCallRecord[] = [];
	const assistantTexts: string[] = [];
	let usedTool = false;
	let sessionId = "";

	for await (const msg of query({
		prompt: opts.prompt,
		options: {
			model: opts.model ?? DEFAULT_MODEL,
			systemPrompt: opts.system,
			maxTurns: opts.maxTurns ?? 15,
			tools: opts.builtinTools ?? [],
			mcpServers: (opts.mcpServers ?? {}) as Record<
				string,
				import("@anthropic-ai/claude-agent-sdk").McpServerConfig
			>,
			allowedTools: opts.allowedTools ?? [],
			disallowedTools: opts.disallowedTools ?? INHERITED_MCP_TOOLS,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			cwd: opts.cwd,
			resume: opts.resume,
			settingSources: [],
			persistSession: true,
		},
	})) {
		if (msg.type === "system" && "session_id" in msg) {
			sessionId = (msg as { session_id: string }).session_id;
		}
		if (msg.type === "assistant" && "message" in msg) {
			const content = (msg as SDKAssistantMessageLike).message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_use" && typeof block.name === "string") {
						usedTool = true;
						toolCalls.push({
							name: block.name,
							input: (block.input ?? {}) as Record<string, unknown>,
							result: "",
							toolUseId: (block as { id?: string }).id ?? "",
						});
					}
					if (block.type === "text" && typeof block.text === "string") {
						assistantTexts.push(block.text);
					}
				}
			}
		}
		// Synthetic user messages from the SDK carry tool_result blocks back.
		// Match each block's tool_use_id to a prior toolCalls entry so the log
		// records the full query AND the Wikipedia text returned.
		if (msg.type === "user" && "message" in msg) {
			const content = (msg as SDKUserMessageLike).message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_result") {
						const id = (block as { tool_use_id?: string }).tool_use_id ?? "";
						const call = toolCalls.find((c) => c.toolUseId === id && c.result === "");
						if (call) {
							const c = (block as { content?: unknown }).content;
							if (typeof c === "string") {
								call.result = c;
							} else if (Array.isArray(c)) {
								call.result = c
									.map((part: { type?: string; text?: string }) =>
										part.type === "text" && typeof part.text === "string" ? part.text : "",
									)
									.join("");
							} else {
								call.result = JSON.stringify(c);
							}
							if ((block as { is_error?: boolean }).is_error) call.isError = true;
						}
					}
				}
			}
		}
		if (msg.type === "result") {
			const r = msg as SDKResultLike;
			if (r.subtype === "success") {
				return {
					answer: r.result ?? "",
					turns: r.num_turns ?? 0,
					inputTokens: r.usage?.input_tokens ?? 0,
					outputTokens: r.usage?.output_tokens ?? 0,
					cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
					cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
					usedTool,
					toolCalls,
					assistantTexts,
					durationMs: r.duration_ms ?? 0,
					costUsd: r.total_cost_usd ?? 0,
					sessionId,
				};
			}
			// Error result
			const errors = (r as { errors?: string[] }).errors ?? [];
			throw new Error(`Agent failed (${r.subtype}): ${errors.join(", ")}`);
		}
	}
	throw new Error("Agent query ended without result");
}

// Loose shape types for SDK messages (avoids tight coupling to SDK internals)
interface SDKAssistantMessageLike {
	type: "assistant";
	message?: {
		content: Array<{ type: string; name?: string; input?: unknown; text?: string; id?: string }>;
	};
}
interface SDKUserMessageLike {
	type: "user";
	message?: {
		content: Array<{
			type: string;
			tool_use_id?: string;
			content?: unknown;
			is_error?: boolean;
		}>;
	};
}
interface SDKResultLike {
	type: "result";
	subtype: string;
	result?: string;
	num_turns?: number;
	duration_ms?: number;
	total_cost_usd?: number;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

export { createSeenContent, type SeenContent };

// --- Timestamp ---

export function timestamp(): string {
	// "2026-04-12T14:30:45.123Z" → "2026-04-12T14-30-45"
	return new Date().toISOString().slice(0, 19).replaceAll(":", "-").replaceAll(".", "-");
}

// --- Logging ---

export async function initLog(
	evalName: string,
): Promise<{ log: (entry: unknown) => Promise<void>; path: string }> {
	const dir = `${import.meta.dir}/../../logs`;
	await mkdir(dir, { recursive: true });
	const path = `${dir}/${evalName}_${timestamp()}.log`;
	const log = async (entry: unknown) => {
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
	};
	return { log, path };
}

/**
 * Build a rich per-run JSON entry for logging. Captures the full question,
 * expected answer, model answer, every tool call with its query AND result,
 * token usage, duration, and cost — enough to reconstruct the run later
 * without re-querying the model.
 */
export function buildRunLogEntry(opts: {
	index: number;
	mode?: string;
	question: string;
	expected?: string | string[] | number;
	agentResult: AgentResult;
	verdict?: Record<string, unknown>;
	extra?: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		event: "run",
		timestamp: new Date().toISOString(),
		index: opts.index,
		...(opts.mode !== undefined ? { mode: opts.mode } : {}),
		question: opts.question,
		...(opts.expected !== undefined ? { expected: opts.expected } : {}),
		model_answer: opts.agentResult.answer,
		assistant_texts: opts.agentResult.assistantTexts,
		tool_calls: opts.agentResult.toolCalls.map((tc) => ({
			id: tc.toolUseId,
			name: tc.name,
			input: tc.input,
			result: tc.result,
			is_error: tc.isError ?? false,
		})),
		used_tool: opts.agentResult.usedTool,
		turns: opts.agentResult.turns,
		input_tokens: opts.agentResult.inputTokens,
		output_tokens: opts.agentResult.outputTokens,
		cache_read_tokens: opts.agentResult.cacheReadTokens,
		cache_creation_tokens: opts.agentResult.cacheCreationTokens,
		duration_ms: opts.agentResult.durationMs,
		cost_usd: opts.agentResult.costUsd,
		session_id: opts.agentResult.sessionId,
		...(opts.verdict ? { verdict: opts.verdict } : {}),
		...(opts.extra ?? {}),
	};
}

// --- TSV helpers ---

/** Sanitize a string for safe embedding in a TSV cell (no tabs, no newlines). */
export function sanitizeTsvField(s: string): string {
	return s
		.replaceAll("\r\n", " ")
		.replaceAll("\r", " ")
		.replaceAll("\n", " ")
		.replaceAll("\t", " ");
}

/**
 * Parse TSV content into rows of string arrays.
 * Handles \r\n, \r, and \n line endings. Skips empty lines.
 */
export function parseTsvRows(content: string): string[][] {
	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return normalized
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => line.split("\t"));
}

/** Write TSV results. Fields are auto-sanitized — callers pass raw strings. */
export async function writeTsvResults(
	evalName: string,
	headers: string[],
	rows: string[][],
): Promise<string> {
	const dir = `${import.meta.dir}/results`;
	await mkdir(dir, { recursive: true });
	const path = `${dir}/${evalName}_${timestamp()}.tsv`;
	const sanitizedRows = rows.map((r) => r.map(sanitizeTsvField));
	const lines = [headers.join("\t"), ...sanitizedRows.map((r) => r.join("\t"))];
	await Bun.write(path, `${lines.join("\n")}\n`);
	console.log(`Results written to ${path}`);
	return path;
}

// --- Model grading ---

export const GRADER_MODEL = "claude-sonnet-4-6";

export async function gradeWithModel(prompt: string, model?: string): Promise<string> {
	const result = await runAgent({
		prompt,
		model: model ?? GRADER_MODEL,
		mcpServers: { wiki: createWikiMcpServer() },
		allowedTools: [WIKI_TOOL_NAME],
		maxTurns: 10,
	});
	return result.answer;
}

// --- Helpers ---

/** Check if a character is a word character (letter, digit, underscore). */
function isWordChar(ch: string): boolean {
	const c = ch.charCodeAt(0);
	return (
		(c >= 65 && c <= 90) || // A-Z
		(c >= 97 && c <= 122) || // a-z
		(c >= 48 && c <= 57) || // 0-9
		c === 95 // _
	);
}

/** Check if `needle` appears in `haystack` at a word boundary (case-insensitive). */
function containsWord(haystack: string, needle: string): boolean {
	const hLower = haystack.toLowerCase();
	const nLower = needle.toLowerCase();
	let start = 0;
	while (true) {
		const idx = hLower.indexOf(nLower, start);
		if (idx === -1) return false;
		const before = idx > 0 ? hLower[idx - 1]! : " ";
		const after = idx + nLower.length < hLower.length ? hLower[idx + nLower.length]! : " ";
		if (!isWordChar(before) && !isWordChar(after)) return true;
		start = idx + 1;
	}
}

export function matchesAny(response: string, acceptableAnswers: string[]): boolean {
	return acceptableAnswers.some((answer) => containsWord(response, answer));
}

/**
 * Extract the final answer from a response that uses an explicit answer pattern.
 * Looks for patterns like "ANSWER: X", "Final answer: X", "The answer is X", "My answer is X".
 * Prefers matches that appear later in the response (the final answer, not mid-reasoning mentions).
 * Returns null if no pattern is found, so callers can fall back to full-response matching.
 */
export function extractFinalAnswer(response: string): string | null {
	const PREFIXES: { phrase: string; colonRequired: boolean }[] = [
		{ phrase: "answer", colonRequired: true },
		{ phrase: "final answer", colonRequired: true },
		{ phrase: "the answer is", colonRequired: false },
		{ phrase: "my answer is", colonRequired: false },
		{ phrase: "my answer", colonRequired: true },
	];

	let lastMatch: string | null = null;
	let lastIndex = -1;
	const lower = response.toLowerCase();

	for (const { phrase, colonRequired } of PREFIXES) {
		let searchFrom = 0;
		while (searchFrom < lower.length) {
			const idx = lower.indexOf(phrase, searchFrom);
			if (idx === -1) break;

			let pos = idx + phrase.length;
			// Skip whitespace
			while (pos < response.length && (response[pos] === " " || response[pos] === "\t")) pos++;
			// Check for colon
			if (pos < response.length && response[pos] === ":") {
				pos++;
			} else if (colonRequired) {
				searchFrom = idx + 1;
				continue;
			}
			// Skip whitespace after colon / "is"
			while (pos < response.length && (response[pos] === " " || response[pos] === "\t")) pos++;

			// Take until end of line
			const eol = response.indexOf("\n", pos);
			const value = (eol >= 0 ? response.slice(pos, eol) : response.slice(pos)).trim();

			if (value && idx > lastIndex) {
				lastIndex = idx;
				lastMatch = value;
			}
			searchFrom = idx + 1;
		}
	}

	return lastMatch;
}

/**
 * Try to extract the first JSON object from a string.
 * Finds the first `{` and last `}` and attempts JSON.parse.
 */
export function extractJson(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	// Try progressively shorter substrings from the last `}` backward
	let end = text.lastIndexOf("}");
	while (end > start) {
		try {
			return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
		} catch {
			end = text.lastIndexOf("}", end - 1);
		}
	}
	return null;
}

/**
 * Strip markdown code fences wrapping a string.
 * Handles ```json, ```python, plain ```, etc.
 */
export function stripCodeFences(text: string): string {
	let s = text.trim();
	if (s.startsWith("```")) {
		const firstNewline = s.indexOf("\n");
		if (firstNewline >= 0) {
			s = s.slice(firstNewline + 1);
		}
	}
	if (s.endsWith("```")) {
		s = s.slice(0, s.lastIndexOf("```"));
	}
	return s.trim();
}

/**
 * Extract numbers from free text. Returns parsed floats, stripping commas.
 * One of the few places where a regex is genuinely the right tool —
 * matching number-like tokens in arbitrary prose.
 */
export function extractNumbers(text: string): number[] {
	const matches = text.match(/[\d,]+\.?\d*/g);
	if (!matches) return [];
	return matches
		.map((m) => Number.parseFloat(m.replaceAll(",", "")))
		.filter((n) => !Number.isNaN(n));
}

/**
 * Check if the leading character of an extracted answer is a specific letter.
 * Handles "B", "(B)", "(B)", etc.
 */
export function leadingLetterIs(text: string, expected: string): boolean {
	const trimmed = text.trimStart();
	let i = 0;
	if (trimmed[i] === "(") i++;
	const ch = trimmed[i];
	if (!ch) return false;
	if (ch.toUpperCase() !== expected.toUpperCase()) return false;
	// Verify it's a standalone letter, not start of a word
	const next = trimmed[i + 1];
	if (
		next === undefined ||
		next === ")" ||
		next === "." ||
		next === "," ||
		next === ";" ||
		next === ":" ||
		next === "!" ||
		next === "?" ||
		next === " " ||
		next === "\t" ||
		next === "\n"
	) {
		return true;
	}
	return false;
}

/**
 * Check if `letter` appears as a standalone answer choice in text.
 * Uses string scanning instead of regex. Checks common answer-indicating patterns:
 * "(X)", "**X**", "*X*", "answer is X", "answer: X", "option X", "choice X",
 * "select/choose/pick X", "X is correct/answer", letter at end of text.
 */
export function textContainsAnswerLetter(text: string, letter: string): boolean {
	const upper = letter.toUpperCase();
	const lower = letter.toLowerCase();

	// (X) as a standalone choice
	if (text.includes(`(${letter})`) || text.includes(`(${upper})`) || text.includes(`(${lower})`))
		return true;

	// **X** or *X*
	if (text.includes(`**${upper}**`) || text.includes(`**${lower}**`)) return true;
	if (text.includes(`*${upper}*`) && !text.includes(`**${upper}*`) && !text.includes(`*${upper}**`))
		return true;
	if (text.includes(`*${lower}*`) && !text.includes(`**${lower}*`) && !text.includes(`*${lower}**`))
		return true;

	const textLower = text.toLowerCase();
	const letterLower = lower;

	// Phrases that precede the letter: "answer is", "answer:", "option", "choice", "select", "choose", "pick", "go with"
	const prefixPhrases = [
		"answer is",
		"answer:",
		"option",
		"choice",
		"select",
		"choose",
		"pick",
		"go with",
	];
	for (const phrase of prefixPhrases) {
		let pos = 0;
		while (true) {
			const idx = textLower.indexOf(phrase, pos);
			if (idx === -1) break;
			// Make sure it's at a word boundary (not "manswer")
			if (idx > 0 && isWordChar(textLower[idx - 1]!)) {
				pos = idx + 1;
				continue;
			}
			let after = idx + phrase.length;
			// skip whitespace and optional colon/parens
			while (after < text.length && " \t:(".includes(text[after]!)) after++;
			if (after < text.length && text[after]!.toUpperCase() === upper) {
				// Verify it's standalone (not part of a word)
				const nextCh = text[after + 1];
				if (!nextCh || !isWordChar(nextCh)) return true;
			}
			pos = idx + 1;
		}
	}

	// "X is correct" or "X is the answer" or "X is the correct answer"
	const suffixPhrases = ["is correct", "is the correct", "is the answer"];
	for (const phrase of suffixPhrases) {
		const pattern = `${letterLower} ${phrase}`;
		let pos = 0;
		while (true) {
			const idx = textLower.indexOf(pattern, pos);
			if (idx === -1) break;
			// Check word boundary before the letter
			if (idx > 0 && isWordChar(textLower[idx - 1]!)) {
				pos = idx + 1;
				continue;
			}
			return true;
		}
	}

	// Letter at end of text (last non-whitespace/punctuation)
	const trimmed = text.trimEnd();
	if (trimmed.length > 0) {
		let end = trimmed.length - 1;
		// Skip trailing punctuation: . ! ) ? ]
		while (end >= 0 && ".!?)]".includes(trimmed[end]!)) end--;
		if (end >= 0 && trimmed[end]!.toUpperCase() === upper) {
			// Check it's standalone
			if (end === 0 || !isWordChar(trimmed[end - 1]!)) return true;
		}
	}

	return false;
}

/**
 * Two-sided paired permutation test.
 * Exact enumeration when n ≤ 20 (2^n permutations), otherwise 50 000 random.
 * Returns observed mean difference (a − b) and two-tailed p-value.
 */
export function pairedPermutationTest(a: number[], b: number[]): { diff: number; p: number } {
	const n = a.length;
	if (n !== b.length || n === 0) return { diff: 0, p: 1 };

	const diffs = a.map((v, i) => v - b[i]!);
	const observed = diffs.reduce((s, d) => s + d, 0);
	if (observed === 0) return { diff: 0, p: 1 };

	const exact = n <= 20;
	const perms = exact ? 1 << n : 50_000;
	let extreme = 0;

	if (exact) {
		for (let mask = 0; mask < perms; mask++) {
			let stat = 0;
			for (let i = 0; i < n; i++) stat += mask & (1 << i) ? -diffs[i]! : diffs[i]!;
			if (Math.abs(stat) >= Math.abs(observed)) extreme++;
		}
	} else {
		for (let p = 0; p < perms; p++) {
			let stat = 0;
			for (let i = 0; i < n; i++) stat += Math.random() < 0.5 ? -diffs[i]! : diffs[i]!;
			if (Math.abs(stat) >= Math.abs(observed)) extreme++;
		}
	}

	return { diff: observed / n, p: extreme / perms };
}

export function computeCohensD(group1: number[], group2: number[]): number {
	const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
	const variance = (arr: number[], m: number) =>
		arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);

	const m1 = mean(group1);
	const m2 = mean(group2);
	const v1 = variance(group1, m1);
	const v2 = variance(group2, m2);
	const pooledSD = Math.sqrt(
		((group1.length - 1) * v1 + (group2.length - 1) * v2) / (group1.length + group2.length - 2),
	);
	if (pooledSD === 0) return 0;
	return (m2 - m1) / pooledSD;
}
