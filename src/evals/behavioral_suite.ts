// Behavioral suite — simulates diverse users with complex tasks to study how
// Haiku uses the Wikipedia tool. Not a correctness benchmark; a behavioral trace.
// Usage: bun src/evals/behavioral_suite.ts [taskIndex]
//   - no arg: run all tasks sequentially
//   - integer arg: run just that task (0-based)

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from "../tool/prompt";
import { createSeenContent, searchWikipedia } from "../tool/search";
import {
	DEFAULT_MODEL,
	initEvalSession,
	parseResumeArg,
	runAgent,
	runKey,
	runOrLogError,
	WIKI_TOOL_NAME,
} from "./utils";

// No eval-specific task framing — this suite studies natural behavior.
const SYSTEM_PROMPT = SHARED_SYSTEM_PROMPT;

interface Task {
	id: string;
	label: string;
	userRequest: string;
}

const TASKS: Task[] = [
	{
		id: "conflict_antikythera",
		label: "Conflicting-info reconciliation",
		userRequest:
			"I've read that the Antikythera mechanism is from the 1st century BC and can predict solar eclipses. But a friend insists it's actually from the 2nd century AD and only tracks planetary positions, not eclipses. Which account is right, and how do we know?",
	},
	{
		id: "density_ranking",
		label: "Multi-entity quantitative ranking",
		userRequest:
			"Rank Monaco, Singapore, Macau, and Vatican City by population density, highest to lowest. Give the actual figures, and tell me whether Vatican City is a fair apples-to-apples comparison.",
	},
	{
		id: "disambig_in_context",
		label: "Intra-query disambiguation",
		userRequest:
			"Tell me about the Battle of Warsaw — specifically the 1920 one, not the 1939 invasion. Who were the key commanders on each side and why is it historically significant?",
	},
	{
		id: "tech_crdt",
		label: "Layered technical explanation",
		userRequest:
			"Explain what a CRDT is, how the G-counter variant differs from the PN-counter, and name a real-world production system that uses CRDTs.",
	},
	{
		id: "multihop_nobel",
		label: "Cross-article reasoning (list to individual)",
		userRequest:
			"Which currently living Nobel laureate in Literature was born earliest? Tell me the country of birth and the year they won the prize.",
	},
	{
		id: "transliteration_caocao",
		label: "Transliteration + historiography split",
		userRequest:
			"Tell me about Cao Cao from the Three Kingdoms period. What was his actual role in the collapse of the Han, and how does his historical portrayal differ from his portrayal in Romance of the Three Kingdoms?",
	},
	{
		id: "debunk_einstein",
		label: "Debunking a popular myth",
		userRequest:
			"My grandfather swears Einstein failed math as a kid. Is this true? If it's a myth, where did it come from?",
	},
	{
		id: "temporal_war_decls",
		label: "Temporal precision across presidencies",
		userRequest:
			"Has any U.S. President ever signed a formal declaration of war on the same calendar day (same month and day) as a predecessor had? If so, name the dates and the wars.",
	},
];

interface CallRecord {
	query: string;
	resultPreview: string;
	resultLen: number;
	durationMs: number;
}

function createLoggingWikiServer(sink: CallRecord[]) {
	const seen = createSeenContent();
	const wikiTool = tool(
		TOOL_NAME,
		TOOL_DESCRIPTION,
		{ query: z.string() },
		async (args) => {
			const start = Date.now();
			const result = await searchWikipedia(args.query, seen);
			sink.push({
				query: args.query,
				resultPreview: result.slice(0, 400),
				resultLen: result.length,
				durationMs: Date.now() - start,
			});
			return { content: [{ type: "text" as const, text: result }] };
		},
		{ annotations: { readOnlyHint: true } },
	);
	return createSdkMcpServer({ name: "wiki", tools: [wikiTool] });
}

async function runOne(
	task: Task,
	taskIndex: number,
	log: (entry: unknown) => Promise<void>,
	appendRow: (row: string[]) => Promise<void>,
): Promise<string[]> {
	const calls: CallRecord[] = [];
	const mcp = createLoggingWikiServer(calls);

	const start = Date.now();
	console.log(`\n--- [${task.id}] ${task.label} ---`);
	console.log(`USER: ${task.userRequest}`);

	const result = await runAgent({
		prompt: task.userRequest,
		system: SYSTEM_PROMPT,
		mcpServers: { wiki: mcp },
		allowedTools: [WIKI_TOOL_NAME],
		maxTurns: 15,
	});
	const wallMs = Date.now() - start;

	console.log(
		`  turns=${result.turns} calls=${calls.length} in=${result.inputTokens} out=${result.outputTokens} cost=$${result.costUsd.toFixed(4)} wall=${wallMs}ms`,
	);
	for (const [i, c] of calls.entries()) {
		console.log(`  q${i + 1}: ${c.query}`);
		console.log(`      -> ${c.resultPreview.replaceAll("\n", " ").slice(0, 140)}...`);
	}
	console.log(`  ANSWER: ${result.answer.slice(0, 200).replaceAll("\n", " ")}...`);

	const row: string[] = [
		task.id,
		task.label,
		String(calls.length),
		calls.map((c) => c.query).join(" | "),
		String(result.turns),
		String(result.inputTokens),
		String(result.outputTokens),
		result.costUsd.toFixed(5),
		String(wallMs),
		result.answer.slice(0, 200),
	];

	await log({
		event: "run",
		timestamp: new Date().toISOString(),
		index: taskIndex,
		task,
		calls,
		result: {
			answer: result.answer,
			turns: result.turns,
			assistantTexts: result.assistantTexts,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			costUsd: result.costUsd,
			durationMs: result.durationMs,
			sessionId: result.sessionId,
			toolCallsFromRunAgent: result.toolCalls,
		},
		wallMs,
		tsv_row: row.map(String),
	});
	await appendRow(row);
	return row;
}

async function main() {
	const headers = [
		"id",
		"label",
		"tool_calls",
		"queries",
		"turns",
		"input_tokens",
		"output_tokens",
		"cost_usd",
		"wall_ms",
		"answer_preview",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "behavioral_suite",
		headers,
		resume,
	});
	console.log(`Log: ${logPath}`);
	console.log(`Model: ${DEFAULT_MODEL}`);

	const arg = process.argv[2];
	const tasksToRun =
		arg !== undefined && !arg.startsWith("--")
			? [TASKS[Number.parseInt(arg, 10)]].filter((t): t is Task => !!t)
			: TASKS;
	console.log(`Tasks: ${tasksToRun.length} / ${TASKS.length}\n`);

	await log({
		event: "start",
		eval: "behavioral_suite",
		model: DEFAULT_MODEL,
		n_tasks: tasksToRun.length,
		resumed_from: resume ?? null,
	});

	const rows: string[][] = [...resumedRows];

	for (const task of tasksToRun) {
		const taskIndex = TASKS.findIndex((t) => t.id === task.id);
		if (completed.has(runKey(taskIndex))) {
			console.log(`\n--- [${task.id}] (already done — skipping)`);
			continue;
		}
		const row = await runOrLogError(log, { index: taskIndex, logPath }, () =>
			runOne(task, taskIndex, log, appendRow),
		);
		rows.push(row);
	}

	const totalIn = rows.reduce((s, r) => s + Number(r[5]), 0);
	const totalOut = rows.reduce((s, r) => s + Number(r[6]), 0);
	const totalCost = rows.reduce((s, r) => s + Number(r[7]), 0);

	console.log("\n=".repeat(50));
	console.log("SUMMARY");
	console.log("=".repeat(50));
	console.log(`  Tasks:  ${rows.length}`);
	console.log(`  Tokens: ${totalIn} in, ${totalOut} out`);
	console.log(`  Cost:   $${totalCost.toFixed(4)}`);
	console.log(`  Log:    ${logPath}`);
	console.log(`  TSV:    ${tsvPath}`);

	await log({
		event: "summary",
		eval: "behavioral_suite",
		n_tasks: rows.length,
		total_input_tokens: totalIn,
		total_output_tokens: totalOut,
		total_cost_usd: totalCost,
	});
}

const isMainModule = import.meta.path === Bun.main;
if (isMainModule) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
