// Unnecessary Tool Use eval
// Tests whether the model wastes tokens calling Wikipedia for questions it obviously knows.
// Usage: bun src/evals/unnecessary_tool.ts [questionIndex]

import {
	type AgentResult,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	initLog,
	matchesAny,
	pairedPermutationTest,
	runAgent,
	WIKI_TOOL_NAME,
	writeTsvResults,
} from "./utils";

// --- Types ---

export interface UnnecessaryToolQuestion {
	question: string;
	acceptableAnswers: string[];
}

// --- Constants ---

export const SYSTEM_PROMPT =
	"You are a helpful assistant. Answer questions directly and efficiently. " +
	"You have access to a Wikipedia search tool, but you should only use it " +
	"when you genuinely need to look something up. For common knowledge questions, " +
	"just answer directly.";

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

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] != null ? Number.parseInt(process.argv[2], 10) : null;
	const questionsToRun = singleIndex != null ? [QUESTIONS[singleIndex]!] : QUESTIONS;
	const label =
		singleIndex != null ? `question ${singleIndex}` : `all ${QUESTIONS.length} questions`;

	console.log("Unnecessary Tool Use Eval");
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(`Running: ${label}\n`);

	await initLog("unnecessary_tool");
	const rows: string[][] = [];

	let withToolUsedCount = 0;
	let withToolCorrect = 0;
	let withoutToolCorrect = 0;
	let totalQuestions = 0;

	const withToolTokens: number[] = [];
	const withoutToolTokens: number[] = [];
	let totalTokens = 0;

	for (const q of questionsToRun) {
		totalQuestions++;
		const idx = singleIndex != null ? singleIndex : questionsToRun.indexOf(q);
		console.log(`--- Q${idx}: ${q.question}`);
		console.log(`    expected: ${q.acceptableAnswers.join(", ")}`);

		// Mode 1: with-tool
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
		const withCorrect = matchesAny(withResult.answer, q.acceptableAnswers);

		if (withResult.usedTool) withToolUsedCount++;
		if (withCorrect) withToolCorrect++;
		const withTotalTokens = withResult.inputTokens + withResult.outputTokens;
		withToolTokens.push(withTotalTokens);
		totalTokens += withTotalTokens;

		console.log(`  [with-tool] answer: ${withResult.answer.slice(0, 120)}`);
		console.log(`  [with-tool] used_tool: ${withResult.usedTool}`);
		console.log(`  [with-tool] correct: ${withCorrect}`);

		rows.push([
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
		]);

		// Mode 2: without-tool
		console.log("  [without-tool] running...");
		const withoutResult: AgentResult = await runAgent({
			system: SYSTEM_PROMPT,
			prompt: q.question,
		});

		const withoutCorrect = matchesAny(withoutResult.answer, q.acceptableAnswers);
		if (withoutCorrect) withoutToolCorrect++;
		const withoutTotalTokens = withoutResult.inputTokens + withoutResult.outputTokens;
		withoutToolTokens.push(withoutTotalTokens);
		totalTokens += withoutTotalTokens;

		console.log(`  [without-tool] answer: ${withoutResult.answer.slice(0, 120)}`);
		console.log(`  [without-tool] correct: ${withoutCorrect}`);
		console.log();

		rows.push([
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
		]);
	}

	// Write TSV
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
	await writeTsvResults("unnecessary_tool", headers, rows);

	// Summary
	const pctUsedTool = ((withToolUsedCount / totalQuestions) * 100).toFixed(1);
	const pctCorrectWith = ((withToolCorrect / totalQuestions) * 100).toFixed(1);
	const pctCorrectWithout = ((withoutToolCorrect / totalQuestions) * 100).toFixed(1);

	const meanWithTokens = withToolTokens.reduce((a, b) => a + b, 0) / withToolTokens.length;
	const meanWithoutTokens = withoutToolTokens.reduce((a, b) => a + b, 0) / withoutToolTokens.length;

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
}

main();
