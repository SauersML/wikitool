// Unnecessary Tool Use eval
// Tests whether the model wastes tokens calling Wikipedia for questions it obviously knows.
// Usage: bun src/evals/unnecessary_tool.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	type AgentResult,
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	initEvalSession,
	matchesAny,
	pairedPermutationTest,
	parseResumeArg,
	runAgent,
	runKey,
	runOrLogError,
	stripCodeFences,
	WIKI_TOOL_NAME,
} from "./utils";

// --- Types ---

export interface UnnecessaryToolQuestion {
	question: string;
	acceptableAnswers: string[];
}

// --- Constants ---

// Eval-specific task prompt (minimal — no tool guidance).
const TASK_PROMPT = "";

export const SYSTEM_PROMPT = TASK_PROMPT
	? `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`
	: SHARED_SYSTEM_PROMPT;
// No-tool: NO system prompt. The production sysprompt is wiki-centric and
// would be nonsense without the tool.
const NO_TOOL_SYSTEM_PROMPT: string | undefined = undefined;

export const QUESTIONS: UnnecessaryToolQuestion[] = [
	{
		question: "What is 2 + 2?",
		acceptableAnswers: ["4", "four"],
	},
	{
		question: "How many days are in a week?",
		acceptableAnswers: ["7", "seven"],
	},
	{
		question: "What color is the sky on a clear day?",
		acceptableAnswers: ["blue"],
	},
	{
		question: "What is the opposite of hot?",
		acceptableAnswers: ["cold"],
	},
	{
		question: "How many sides does a triangle have?",
		acceptableAnswers: ["3", "three"],
	},
	{
		question: "What is the capital of France?",
		acceptableAnswers: ["paris"],
	},
	{
		question: "Who wrote the Harry Potter series?",
		acceptableAnswers: ["j.k. rowling", "jk rowling", "rowling", "j. k. rowling"],
	},
	{
		question: "What year did World War II end?",
		acceptableAnswers: ["1945"],
	},
	{
		question: "What is the chemical formula for table salt?",
		acceptableAnswers: ["nacl"],
	},
	{
		question: "How many continents are there?",
		acceptableAnswers: ["7", "seven"],
	},
];

// --- Grading ---

// Refusals / non-answers that must never count as correct even if an
// acceptableAnswer happens to be a substring of the surrounding prose.
const REFUSAL_PATTERNS = [
	"i cannot",
	"i can't",
	"i'm unable",
	"i am unable",
	"i don't know",
	"i do not know",
	"unable to answer",
	"cannot answer",
];

function normalize(s: string): string {
	// NBSP + other unicode whitespace → regular space; collapse runs.
	return s.replaceAll(/\s+/gu, " ").trim();
}

function isRefusal(text: string): boolean {
	const t = text.toLowerCase();
	return REFUSAL_PATTERNS.some((p) => t.includes(p));
}

/**
 * Grade a short-trivia response. Prefer the explicitly-committed final answer
 * (reduces FPs from mid-reasoning mentions like "some might say 3, but…");
 * fall back to full-response word-boundary matching for plain one-line answers
 * that never use an ANSWER: prefix.
 */
function gradeAnswer(raw: string, acceptable: string[]): boolean {
	const cleaned = normalize(stripCodeFences(raw ?? ""));
	if (!cleaned) return false;
	if (isRefusal(cleaned) && !matchesAny(cleaned, acceptable)) return false;

	const final = extractFinalAnswer(cleaned);
	if (final) {
		// Strip wrapping punctuation/markdown from the committed answer line.
		const stripped = final.replace(/^[\s"'`*_([]+|[\s"'`*_.!?,;:)\]]+$/g, "");
		if (stripped && matchesAny(stripped, acceptable)) return true;
		// Committed to something that doesn't contain any acceptable answer:
		// trust the commitment to avoid FPs from earlier mid-reasoning mentions.
		if (stripped) return false;
	}
	return matchesAny(cleaned, acceptable);
}

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] != null ? Number.parseInt(process.argv[2], 10) : null;
	const questionsToRun = singleIndex != null ? [QUESTIONS[singleIndex]!] : QUESTIONS;
	const label =
		singleIndex != null ? `question ${singleIndex}` : `all ${QUESTIONS.length} questions`;

	console.log("Unnecessary Tool Use Eval");
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(`Running: ${label}\n`);

	const headers = [
		"question",
		"expected_answer",
		"mode",
		"used_tool",
		"tool_queries",
		"model_answer",
		"is_correct",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "unnecessary_tool",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "unnecessary_tool",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["with-tool", "without-tool"],
		single_index: singleIndex,
		resumed_from: resume ?? null,
	});
	const rows: string[][] = [...resumedRows];

	let totalQuestions = 0;

	for (const q of questionsToRun) {
		totalQuestions++;
		const idx = singleIndex != null ? singleIndex : questionsToRun.indexOf(q);
		console.log(`--- Q${idx}: ${q.question}`);
		console.log(`    expected: ${q.acceptableAnswers.join(", ")}`);

		// Mode 1: with-tool
		if (completed.has(runKey(idx, "with-tool"))) {
			console.log("  [with-tool] (already done — skipping)");
		} else {
			const row = await runOrLogError(log, { index: idx, mode: "with-tool", logPath }, async () => {
				console.log("  [with-tool] running...");
				const seen = createSeenContent();
				const wikiServer = createWikiMcpServer({ seen });
				const withResult: AgentResult = await runAgent({
					system: SYSTEM_PROMPT,
					prompt: q.question,
					mcpServers: { wiki: wikiServer },
					allowedTools: [WIKI_TOOL_NAME],
				});

				const toolQueries = withResult.toolCalls
					.map((tc) => (tc.input["query"] as string) ?? "")
					.join("; ");
				const withCorrect = gradeAnswer(withResult.answer, q.acceptableAnswers);

				console.log(`  [with-tool] answer: ${withResult.answer.slice(0, 120)}`);
				console.log(`  [with-tool] used_tool: ${withResult.usedTool}`);
				console.log(`  [with-tool] correct: ${withCorrect}`);

				const r: string[] = [
					q.question,
					q.acceptableAnswers.join(", "),
					"with-tool",
					String(withResult.usedTool),
					toolQueries,
					withResult.answer,
					String(withCorrect),
					String(withResult.turns),
					String(withResult.inputTokens),
					String(withResult.outputTokens),
				];
				await log(
					buildRunLogEntry({
						index: idx,
						mode: "with-tool",
						question: q.question,
						expected: q.acceptableAnswers,
						agentResult: withResult,
						verdict: { correct: withCorrect, used_tool: withResult.usedTool },
						tsvRow: r,
					}),
				);
				await appendRow(r);
				return r;
			});
			rows.push(row);
		}

		// Mode 2: without-tool
		if (completed.has(runKey(idx, "without-tool"))) {
			console.log("  [without-tool] (already done — skipping)");
		} else {
			const row = await runOrLogError(
				log,
				{ index: idx, mode: "without-tool", logPath },
				async () => {
					console.log("  [without-tool] running...");
					const withoutResult: AgentResult = await runAgent({
						system: NO_TOOL_SYSTEM_PROMPT,
						prompt: q.question,
					});

					const withoutCorrect = gradeAnswer(withoutResult.answer, q.acceptableAnswers);

					console.log(`  [without-tool] answer: ${withoutResult.answer.slice(0, 120)}`);
					console.log(`  [without-tool] correct: ${withoutCorrect}`);
					console.log();

					const r: string[] = [
						q.question,
						q.acceptableAnswers.join(", "),
						"without-tool",
						String(withoutResult.usedTool),
						"",
						withoutResult.answer,
						String(withoutCorrect),
						String(withoutResult.turns),
						String(withoutResult.inputTokens),
						String(withoutResult.outputTokens),
					];
					await log(
						buildRunLogEntry({
							index: idx,
							mode: "without-tool",
							question: q.question,
							expected: q.acceptableAnswers,
							agentResult: withoutResult,
							verdict: { correct: withoutCorrect },
							tsvRow: r,
						}),
					);
					await appendRow(r);
					return r;
				},
			);
			rows.push(row);
		}
	}

	// Summary — derived from the streamed TSV rows so resume + partial work is reflected.
	const withToolRowsForSummary = rows.filter((r) => r[2] === "with-tool");
	const withoutToolRowsForSummary = rows.filter((r) => r[2] === "without-tool");
	const withToolUsedCount = withToolRowsForSummary.filter((r) => r[3] === "true").length;
	const withToolCorrect = withToolRowsForSummary.filter((r) => r[6] === "true").length;
	const withoutToolCorrect = withoutToolRowsForSummary.filter((r) => r[6] === "true").length;
	const withToolTokens = withToolRowsForSummary.map((r) => Number(r[8]) + Number(r[9]));
	const withoutToolTokens = withoutToolRowsForSummary.map((r) => Number(r[8]) + Number(r[9]));
	const totalTokens = [...withToolTokens, ...withoutToolTokens].reduce((a, b) => a + b, 0);

	const pctUsedTool = ((withToolUsedCount / totalQuestions) * 100).toFixed(1);
	const pctCorrectWith = ((withToolCorrect / totalQuestions) * 100).toFixed(1);
	const pctCorrectWithout = ((withoutToolCorrect / totalQuestions) * 100).toFixed(1);

	const meanWithTokens = withToolTokens.length
		? withToolTokens.reduce((a, b) => a + b, 0) / withToolTokens.length
		: 0;
	const meanWithoutTokens = withoutToolTokens.length
		? withoutToolTokens.reduce((a, b) => a + b, 0) / withoutToolTokens.length
		: 0;

	console.log("=".repeat(60));
	console.log("RESULTS");
	console.log("=".repeat(60));
	console.log(`Tool usage rate: ${pctUsedTool}% (${withToolUsedCount}/${totalQuestions})`);
	console.log(`Accuracy (with-tool): ${pctCorrectWith}% (${withToolCorrect}/${totalQuestions})`);
	console.log(
		`Accuracy (without-tool): ${pctCorrectWithout}% (${withoutToolCorrect}/${totalQuestions})`,
	);
	console.log(`Mean tokens (with-tool): ${meanWithTokens.toFixed(0)}`);
	console.log(`Mean tokens (without-tool): ${meanWithoutTokens.toFixed(0)}`);
	console.log(`Token overhead: ${((meanWithTokens / meanWithoutTokens - 1) * 100).toFixed(1)}%`);
	console.log(`Total tokens used: ${totalTokens}`);

	const withCorr = rows.filter((r) => r[2] === "with-tool").map((r) => (r[6] === "true" ? 1 : 0));
	const withoutCorr = rows
		.filter((r) => r[2] === "without-tool")
		.map((r) => (r[6] === "true" ? 1 : 0));
	const perm = pairedPermutationTest(withCorr, withoutCorr);
	console.log(`Permutation test: diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`);

	await log({
		event: "summary",
		eval: "unnecessary_tool",
		n_questions: totalQuestions,
		with_tool_used: withToolUsedCount,
		with_tool_correct: withToolCorrect,
		without_tool_correct: withoutToolCorrect,
		mean_with_tokens: meanWithTokens,
		mean_without_tokens: meanWithoutTokens,
		total_tokens: totalTokens,
		permutation: perm,
	});

	console.log(`Log: ${logPath}`);
	console.log(`TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported by tests.
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
