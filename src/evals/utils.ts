import { appendFile, mkdir } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { QUERY_DESCRIPTION, TOOL_DESCRIPTION, TOOL_NAME } from "../tool/prompt";
import { createSeenContent, type SeenContent, searchWikipedia } from "../tool/search";

// --- Constants ---

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const client = new Anthropic();

export const WIKI_TOOL: Anthropic.Messages.Tool = {
	name: TOOL_NAME,
	description: TOOL_DESCRIPTION,
	input_schema: {
		type: "object" as const,
		properties: {
			query: {
				type: "string",
				description: QUERY_DESCRIPTION,
			},
		},
		required: ["query"],
	},
};

/** Server-side code execution sandbox (Python + Bash). No client handler needed. */
export const CODE_EXECUTION_TOOL: Anthropic.Messages.CodeExecutionTool20250825 = {
	type: "code_execution_20250825",
	name: "code_execution",
};

/** Server-side web search. No client handler needed. */
export const WEB_SEARCH_TOOL: Anthropic.Messages.WebSearchTool20260209 = {
	type: "web_search_20260209",
	name: "web_search",
};

// --- Types ---

export interface ToolCallRecord {
	name: string;
	input: Record<string, unknown>;
	result: string;
}

export interface AgentResult {
	answer: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	usedTool: boolean;
	toolCalls: ToolCallRecord[];
	messages: Anthropic.Messages.MessageParam[];
	durationMs: number;
	toolDurationMs: number;
}

export type ToolHandler = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface RunOptions {
	system: string;
	userMessage: string;
	tools?: Anthropic.Messages.ToolUnion[];
	toolHandler?: ToolHandler;
	model?: string;
	maxTokens?: number;
	maxTurns?: number;
	initialMessages?: Anthropic.Messages.MessageParam[];
}

// --- Default tool handler ---

/** Create a tool handler that passes `seen` to searchWikipedia for cross-call dedup. */
export function createToolHandler(seen: SeenContent): ToolHandler {
	return async (name: string, input: Record<string, unknown>): Promise<string> => {
		if (name === TOOL_NAME) {
			return searchWikipedia(input["query"] as string, seen);
		}
		return `Unknown tool: ${name}`;
	};
}

export { createSeenContent, type SeenContent };

// --- Timestamp ---

export function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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

// --- TSV results ---

export async function writeTsvResults(
	evalName: string,
	headers: string[],
	rows: string[][],
): Promise<string> {
	const dir = `${import.meta.dir}/results`;
	await mkdir(dir, { recursive: true });
	const path = `${dir}/${evalName}_${timestamp()}.tsv`;
	const lines = [headers.join("\t"), ...rows.map((r) => r.join("\t"))];
	await Bun.write(path, `${lines.join("\n")}\n`);
	console.log(`Results written to ${path}`);
	return path;
}

// --- Agent loop ---

export async function runAgentLoop(
	opts: RunOptions,
	log?: (entry: unknown) => Promise<void>,
): Promise<AgentResult> {
	const model = opts.model ?? DEFAULT_MODEL;
	const maxTokens = opts.maxTokens ?? 1024;
	const maxTurns = opts.maxTurns ?? 15;
	const handler = opts.toolHandler ?? createToolHandler(createSeenContent());
	const tools = opts.tools ?? [WIKI_TOOL];
	const apiTools = tools.length > 0 ? tools : undefined;

	const messages: Anthropic.Messages.MessageParam[] = [
		...(opts.initialMessages ?? []),
		{ role: "user", content: opts.userMessage },
	];

	const startTime = performance.now();
	let turns = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let usedTool = false;
	let toolDurationMs = 0;
	const toolCalls: ToolCallRecord[] = [];

	while (turns < maxTurns) {
		turns++;

		const request = {
			model,
			max_tokens: maxTokens,
			system: opts.system,
			messages,
			...(apiTools ? { tools: apiTools } : {}),
		};

		const response = await client.messages.create(request);

		inputTokens += response.usage.input_tokens;
		outputTokens += response.usage.output_tokens;

		if (log) {
			await log({
				timestamp: new Date().toISOString(),
				turn: turns,
				request: { model, system: opts.system, messages, tools, max_tokens: maxTokens },
				response: {
					id: response.id,
					stop_reason: response.stop_reason,
					content: response.content,
					usage: response.usage,
				},
			});
		}

		messages.push({ role: "assistant", content: response.content });

		if (response.stop_reason !== "tool_use") {
			break;
		}

		// Process client tool calls only (server tools like code_execution
		// and web_search are handled automatically by the API).
		const toolUseBlocks = response.content.filter(
			(b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
		);

		// Safety: if stop_reason was tool_use but only server tools fired, break
		if (toolUseBlocks.length === 0) {
			break;
		}

		const results: Anthropic.Messages.ToolResultBlockParam[] = [];
		for (const block of toolUseBlocks) {
			usedTool = true;
			const input = block.input as Record<string, unknown>;
			let result: string;
			const toolStart = performance.now();
			try {
				result = await handler(block.name, input);
				toolDurationMs += performance.now() - toolStart;
			} catch (err) {
				toolDurationMs += performance.now() - toolStart;
				result = `Error: ${err instanceof Error ? err.message : String(err)}`;
				results.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: result,
					is_error: true,
				});
				toolCalls.push({ name: block.name, input, result });
				continue;
			}
			toolCalls.push({ name: block.name, input, result });
			results.push({
				type: "tool_result",
				tool_use_id: block.id,
				content: result,
			});
		}

		messages.push({ role: "user", content: results });
	}

	// If the loop ended without a text answer (exhausted turns on a tool_use
	// turn, or last assistant message has no text), force one final turn
	// without tools so the model produces a text response.
	const lastEntry = messages.at(-1);
	const needsForce =
		// Case 1: last message is tool_results (loop exited mid-tool-use)
		(lastEntry?.role === "user" &&
			Array.isArray(lastEntry.content) &&
			(lastEntry.content as Anthropic.Messages.ToolResultBlockParam[]).some(
				(b) => b.type === "tool_result",
			)) ||
		// Case 2: last assistant message has no text blocks
		(lastEntry?.role === "assistant" &&
			Array.isArray(lastEntry.content) &&
			!(lastEntry.content as Anthropic.Messages.ContentBlock[]).some((b) => b.type === "text"));
	if (needsForce) {
		const forceResponse = await client.messages.create({
			model,
			max_tokens: maxTokens,
			system: opts.system,
			messages: [
				...messages,
				{
					role: "user",
					content:
						"You have reached the tool use limit. Based on the information you have gathered so far, provide your best answer now. End with ANSWER: followed by your answer.",
				},
			],
		});
		inputTokens += forceResponse.usage.input_tokens;
		outputTokens += forceResponse.usage.output_tokens;
		messages.push({ role: "assistant", content: forceResponse.content });
		turns++;
	}

	// Extract final answer from last assistant message
	const lastMsg = messages.at(-1);
	let answer = "";
	if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
		const textBlocks = (lastMsg.content as Anthropic.Messages.ContentBlock[]).filter(
			(b): b is Anthropic.Messages.TextBlock => b.type === "text",
		);
		const lastText = textBlocks.at(-1);
		if (lastText) answer = lastText.text;
	}

	const durationMs = performance.now() - startTime;
	return {
		answer,
		turns,
		inputTokens,
		outputTokens,
		usedTool,
		toolCalls,
		messages,
		durationMs,
		toolDurationMs,
	};
}

// --- Model grading ---

export const GRADER_MODEL = "claude-sonnet-4-6";

export async function gradeWithModel(prompt: string, model?: string): Promise<string> {
	const response = await client.messages.create({
		model: model ?? GRADER_MODEL,
		max_tokens: 512,
		messages: [{ role: "user", content: prompt }],
	});
	const text = response.content.find((b): b is Anthropic.Messages.TextBlock => b.type === "text");
	if (!text) throw new Error("Grader returned no text block");
	return text.text;
}

// --- Helpers ---

export function matchesAny(response: string, acceptableAnswers: string[]): boolean {
	const lower = response.toLowerCase();
	return acceptableAnswers.some((a) => lower.includes(a.toLowerCase()));
}

/**
 * Extract the final answer from a response that uses an explicit answer pattern.
 * Looks for patterns like "ANSWER: X", "Final answer: X", "The answer is X", "My answer is X".
 * Prefers matches that appear later in the response (the final answer, not mid-reasoning mentions).
 * Returns null if no pattern is found, so callers can fall back to full-response matching.
 */
export function extractFinalAnswer(response: string): string | null {
	const patterns = [
		/ANSWER\s*:\s*(.+)/i,
		/Final answer\s*:\s*(.+)/i,
		/The answer is\s*:?\s*(.+)/i,
		/My answer is\s*:?\s*(.+)/i,
		/My answer\s*:\s*(.+)/i,
	];

	let lastMatch: string | null = null;
	let lastIndex = -1;

	for (const pattern of patterns) {
		const global = new RegExp(pattern.source, `${pattern.flags}g`);
		let match: RegExpExecArray | null = global.exec(response);
		while (match !== null) {
			if (match.index > lastIndex) {
				lastIndex = match.index;
				lastMatch = match[1]!.trim();
			}
			match = global.exec(response);
		}
	}

	return lastMatch;
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
