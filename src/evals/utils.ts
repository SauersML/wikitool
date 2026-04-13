import Anthropic from "@anthropic-ai/sdk";
import { appendFile, mkdir } from "node:fs/promises";
import { QUERY_DESCRIPTION, TOOL_DESCRIPTION, TOOL_NAME } from "../tool/prompt";
import { searchWikipedia } from "../tool/search";

// --- Constants ---

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export const client = new Anthropic();

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

export type ToolHandler = (
	name: string,
	input: Record<string, unknown>,
) => Promise<string>;

export interface RunOptions {
	system: string;
	userMessage: string;
	tools?: Anthropic.Messages.Tool[];
	toolHandler?: ToolHandler;
	model?: string;
	maxTokens?: number;
	maxTurns?: number;
	initialMessages?: Anthropic.Messages.MessageParam[];
}

// --- Default tool handler ---

export async function defaultToolHandler(
	name: string,
	input: Record<string, unknown>,
): Promise<string> {
	if (name === TOOL_NAME) {
		return searchWikipedia(input.query as string);
	}
	return `Unknown tool: ${name}`;
}

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
		await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
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
	await Bun.write(path, lines.join("\n") + "\n");
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
	const maxTurns = opts.maxTurns ?? 10;
	const handler = opts.toolHandler ?? defaultToolHandler;
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

		// Process tool calls
		const toolUseBlocks = response.content.filter(
			(b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
		);

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

	// Extract final answer from last assistant message
	const lastMsg = messages.at(-1);
	let answer = "";
	if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
		const textBlocks = (
			lastMsg.content as Anthropic.Messages.ContentBlock[]
		).filter((b): b is Anthropic.Messages.TextBlock => b.type === "text");
		const lastText = textBlocks.at(-1);
		if (lastText) answer = lastText.text;
	}

	const durationMs = performance.now() - startTime;
	return { answer, turns, inputTokens, outputTokens, usedTool, toolCalls, messages, durationMs, toolDurationMs };
}

// --- Model grading ---

export async function gradeWithModel(prompt: string, model?: string): Promise<string> {
	const response = await client.messages.create({
		model: model ?? DEFAULT_MODEL,
		max_tokens: 512,
		messages: [{ role: "user", content: prompt }],
	});
	const text = response.content.find(
		(b): b is Anthropic.Messages.TextBlock => b.type === "text",
	);
	return text?.text ?? "";
}

// --- Helpers ---

export function matchesAny(response: string, acceptableAnswers: string[]): boolean {
	const lower = response.toLowerCase();
	return acceptableAnswers.some((a) => lower.includes(a.toLowerCase()));
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
		((group1.length - 1) * v1 + (group2.length - 1) * v2) /
			(group1.length + group2.length - 2),
	);
	if (pooledSD === 0) return 0;
	return (m2 - m1) / pooledSD;
}
