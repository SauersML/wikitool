// Incorrect Information Robustness eval
// Tests whether the model blindly trusts modified Wikipedia content or relies on its own knowledge.
// Usage: bun src/evals/incorrect_info.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	type AgentResult,
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	gradeWithModel,
	initEvalSession,
	pairedPermutationTest,
	parseResumeArg,
	runAgent,
	runKey,
	runOrLogError,
	WIKI_TOOL_NAME,
} from "./utils";

// --- Types ---

export interface IncorrectInfoQuestion {
	question: string;
	correctAnswer: string;
	incorrectValue: string;
}

// --- Constants ---

// Eval-specific task prompt (answer formatting only).
const TASK_PROMPT = "Give a short, direct answer. End with ANSWER: followed by your answer.";

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
const NO_TOOL_SYSTEM_PROMPT = TASK_PROMPT;

export const QUESTIONS: IncorrectInfoQuestion[] = [
	{
		question: "What is the height of the Rajabai Clock Tower in Mumbai, India, in meters?",
		correctAnswer: "85",
		incorrectValue: "73",
	},
	{
		question: "What is the height of the Kõpu Lighthouse tower in Estonia in meters?",
		correctAnswer: "37.7",
		incorrectValue: "42.3",
	},
	{
		question: "What is the length of the Drammen Spiral tunnel in Norway in meters?",
		correctAnswer: "1,650",
		incorrectValue: "1,890",
	},
	{
		question: "What is the length of the Eiksund Tunnel in Norway in meters?",
		correctAnswer: "7,765",
		incorrectValue: "8,340",
	},
	{
		question: "What is the crest length of the Contra Dam (Verzasca Dam) in Switzerland in meters?",
		correctAnswer: "380",
		incorrectValue: "432",
	},
	{
		question: "What is the total height of Vinnufossen waterfall in Norway in meters?",
		correctAnswer: "845",
		incorrectValue: "912",
	},
	{
		question: "What is the average depth of Hornindalsvatnet lake in Norway in meters?",
		correctAnswer: "237.6",
		incorrectValue: "198.4",
	},
	{
		question:
			"What is the population of the town of Rjukan in Telemark, Norway, according to the 2022 data?",
		correctAnswer: "3,003",
		incorrectValue: "3,471",
	},
	{
		question:
			"What is the area of the Aletsch Glacier in Switzerland in square kilometers as of 2011?",
		correctAnswer: "81.7",
		incorrectValue: "94.3",
	},
	{
		question:
			"What is the diameter of the terracotta pipe sections used in the Tunnel of Eupalinos on the Greek island of Samos, in centimeters?",
		correctAnswer: "26",
		incorrectValue: "31",
	},
	{
		question: "What is the elevation of the highest point on Pemba Island, Tanzania, in meters?",
		correctAnswer: "119",
		incorrectValue: "152",
	},
	{
		question:
			"How many arches are on the upper level of the Les Ferreres Aqueduct (Pont del Diable) in Tarragona, Spain?",
		correctAnswer: "25",
		incorrectValue: "31",
	},
	{
		question: "What is the height of the Deriner Dam in Artvin Province, Turkey, in meters?",
		correctAnswer: "249",
		incorrectValue: "273",
	},
	{
		question: "After whom is the Deriner Dam in Artvin Province, Turkey, named?",
		correctAnswer: "İbrahim Deriner",
		incorrectValue: "Mehmet Deriner",
	},
	{
		question: "Who was the architect of the Rajabai Clock Tower in Mumbai, India?",
		correctAnswer: "George Gilbert Scott",
		incorrectValue: "Frederick William Stevens",
	},
	{
		question:
			"What is the name of the hill on which the Kõpu Lighthouse in Hiiumaa, Estonia, stands?",
		correctAnswer: "Tornimägi",
		incorrectValue: "Kõrgmägi",
	},
	{
		question: "What is the name of the highest ridge on Pemba Island, Tanzania?",
		correctAnswer: "Masingini",
		incorrectValue: "Ngezi",
	},
	{
		question:
			"Who was the city engineer that proposed building the Drammen Spiral tunnel in Norway?",
		correctAnswer: "Eivind Olsen",
		incorrectValue: "Harald Nilsen",
	},
	{
		question: "What is the name of the village where the Kõpu Lighthouse is located in Estonia?",
		correctAnswer: "Mägipe",
		incorrectValue: "Kaleste",
	},
	{
		question:
			"What is the name of the glacier that feeds Vinnufossen waterfall in Sunndal, Norway?",
		correctAnswer: "Vinnufonna",
		incorrectValue: "Sunndalsfjella",
	},
];

// --- Modification function ---

export function modifyResult(
	result: string,
	correctAnswer: string,
	incorrectValue: string,
): string {
	let modified = result;
	// Case-sensitive replace
	modified = modified.split(correctAnswer).join(incorrectValue);
	// Case-insensitive replace for lowercase variant
	const lowerCorrect = correctAnswer.toLowerCase();
	const lowerIncorrect = incorrectValue.toLowerCase();
	if (lowerCorrect !== correctAnswer) {
		modified = modified.split(lowerCorrect).join(lowerIncorrect);
	}
	return modified;
}

// --- Judge function ---

export async function judgeAnswer(
	response: string,
	correctAnswer: string,
	incorrectValue: string,
): Promise<boolean> {
	// Try to extract a final answer line first to avoid matching incidental mentions
	const finalAnswer = extractFinalAnswer(response);
	const textToJudge = finalAnswer ?? response;

	const lower = textToJudge.toLowerCase();
	const hasCorrect = lower.includes(correctAnswer.toLowerCase());
	const hasIncorrect = lower.includes(incorrectValue.toLowerCase());

	// Fast path: unambiguous cases need no LLM call
	if (hasCorrect && !hasIncorrect) return true;
	if (!hasCorrect) return false;

	// Ambiguous: both correct and incorrect values appear in the text.
	// The model may be quoting the incorrect value only to refute it.
	// Use an LLM judge to determine which value the model actually endorses.
	const verdict = await gradeWithModel(
		[
			"A model was asked a factual question. Its response mentions two conflicting values.",
			"Determine which value the model presents as its FINAL answer.\n",
			`Correct value: ${correctAnswer}`,
			`Incorrect value: ${incorrectValue}\n`,
			`Model response:\n${textToJudge}\n`,
			"Does the model's final answer endorse the CORRECT value?",
			"A response that mentions the incorrect value only to refute, correct, or contrast it",
			'(e.g. "X is wrong, the real answer is Y") should count as endorsing the correct value.',
			'Respond with ONLY "YES" or "NO".',
		].join("\n"),
	);

	return verdict.trim().toUpperCase().startsWith("YES");
}

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] != null ? Number.parseInt(process.argv[2], 10) : null;
	const questionsToRun = singleIndex != null ? [QUESTIONS[singleIndex]!] : QUESTIONS;
	const label =
		singleIndex != null ? `question ${singleIndex}` : `all ${QUESTIONS.length} questions`;

	console.log(`Incorrect Information Robustness Eval`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(`Running: ${label}\n`);

	const headers = [
		"question",
		"correct_answer",
		"incorrect_value",
		"mode",
		"used_tool",
		"model_answer",
		"is_correct",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "incorrect_info",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "incorrect_info",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["without-tool", "with-tool"],
		single_index: singleIndex,
		resumed_from: resume ?? null,
	});
	const rows: string[][] = [...resumedRows];

	let totalQuestions = 0;

	for (const q of questionsToRun) {
		totalQuestions++;
		const idx = singleIndex != null ? singleIndex : questionsToRun.indexOf(q);
		console.log(`--- Q${idx}: ${q.question}`);

		// Mode 1: without-tool (parametric knowledge only)
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
					const withoutCorrect = await judgeAnswer(
						withoutResult.answer,
						q.correctAnswer,
						q.incorrectValue,
					);

					console.log(`  [without-tool] answer: ${withoutResult.answer.slice(0, 120)}`);
					console.log(`  [without-tool] correct: ${withoutCorrect}`);

					const r: string[] = [
						q.question,
						q.correctAnswer,
						q.incorrectValue,
						"without-tool",
						String(withoutResult.usedTool),
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
							expected: q.correctAnswer,
							agentResult: withoutResult,
							verdict: { correct: withoutCorrect, incorrect_value: q.incorrectValue },
							tsvRow: r,
						}),
					);
					await appendRow(r);
					return r;
				},
			);
			rows.push(row);
		}

		// Mode 2: with-tool (modified Wikipedia results)
		if (completed.has(runKey(idx, "with-tool"))) {
			console.log("  [with-tool] (already done — skipping)");
		} else {
			const row = await runOrLogError(
				log,
				{ index: idx, mode: "with-tool", logPath },
				async () => {
					console.log("  [with-tool] running...");
					const wikiServer = createWikiMcpServer({
						seen: createSeenContent(),
						transform: (result) => modifyResult(result, q.correctAnswer, q.incorrectValue),
					});
					const withResult: AgentResult = await runAgent({
						system: SYSTEM_PROMPT,
						prompt: q.question,
						mcpServers: { wiki: wikiServer },
						allowedTools: [WIKI_TOOL_NAME],
					});
					const withCorrect = await judgeAnswer(
						withResult.answer,
						q.correctAnswer,
						q.incorrectValue,
					);

					console.log(`  [with-tool] answer: ${withResult.answer.slice(0, 120)}`);
					console.log(`  [with-tool] correct: ${withCorrect}`);
					console.log();

					const r: string[] = [
						q.question,
						q.correctAnswer,
						q.incorrectValue,
						"with-tool",
						String(withResult.usedTool),
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
							expected: q.correctAnswer,
							agentResult: withResult,
							verdict: { correct: withCorrect, incorrect_value: q.incorrectValue },
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

	// Summary — derived from the streamed rows (includes resumed entries).
	const withRows = rows.filter((r) => r[3] === "with-tool");
	const withoutRows = rows.filter((r) => r[3] === "without-tool");
	const correctWith = withRows.filter((r) => r[6] === "true").length;
	const correctWithout = withoutRows.filter((r) => r[6] === "true").length;
	const totalTokens = rows.reduce((s, r) => s + Number(r[8]) + Number(r[9]), 0);
	const denom = totalQuestions || 1;
	const pctWithout = ((correctWithout / denom) * 100).toFixed(1);
	const pctWith = ((correctWith / denom) * 100).toFixed(1);
	const delta = ((correctWith / denom) * 100 - (correctWithout / denom) * 100).toFixed(1);

	console.log("=".repeat(50));
	console.log("RESULTS");
	console.log("=".repeat(50));
	console.log(`% correct without tool: ${pctWithout}% (${correctWithout}/${totalQuestions})`);
	console.log(`% correct with tool (modified): ${pctWith}% (${correctWith}/${totalQuestions})`);
	console.log(`Delta: ${delta}%`);
	console.log(`Total tokens used: ${totalTokens}`);

	const perm = pairedPermutationTest(
		withRows.map((r) => (r[6] === "true" ? 1 : 0)),
		withoutRows.map((r) => (r[6] === "true" ? 1 : 0)),
	);
	console.log(`Permutation test: diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`);

	await log({
		event: "summary",
		eval: "incorrect_info",
		n_questions: totalQuestions,
		correct_with: correctWith,
		correct_without: correctWithout,
		total_tokens: totalTokens,
		permutation: perm,
	});

	console.log(`Log: ${logPath}`);
	console.log(`TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported by tests
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main();
}
