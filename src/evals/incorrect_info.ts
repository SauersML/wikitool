// Incorrect Information Robustness eval
// Tests whether the model blindly trusts modified Wikipedia content or relies on its own knowledge.
// Usage: bun src/evals/incorrect_info.ts [questionIndex]

import {
	type AgentResult,
	DEFAULT_MODEL,
	defaultToolHandler,
	initLog,
	runAgentLoop,
	writeTsvResults,
} from "./utils";

// --- Types ---

export interface IncorrectInfoQuestion {
	question: string;
	correctAnswer: string;
	incorrectValue: string;
}

// --- Constants ---

export const SYSTEM_PROMPT =
	"You are a helpful assistant that answers factual questions accurately and concisely. " +
	"You have access to a Wikipedia search tool. Use it if you think it will help, but always " +
	"use your best judgment about the accuracy of information you find. Give a short, direct answer.";

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
		question: "Who was the engineer that designed the Vajont Dam in Italy?",
		correctAnswer: "Carlo Semenza",
		incorrectValue: "Luigi Semenza",
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

/** Check whether a string looks numeric (digits, commas, dots, optional minus). */
function isNumericAnswer(s: string): boolean {
	return /^-?[\d,]+\.?\d*$/.test(s.trim());
}

export function judgeAnswer(
	response: string,
	correctAnswer: string,
	incorrectValue: string,
	mode: "without-tool" | "with-tool",
): boolean {
	const lower = response.toLowerCase();
	const hasCorrect = lower.includes(correctAnswer.toLowerCase());
	const hasIncorrect = lower.includes(incorrectValue.toLowerCase());

	if (isNumericAnswer(correctAnswer)) {
		// Strict numeric check: correct value must appear AND incorrect must NOT,
		// regardless of mode. This prevents "close enough" answers from passing.
		return hasCorrect && !hasIncorrect;
	}

	if (mode === "without-tool") {
		return hasCorrect;
	}
	// with-tool: correct answer must appear AND incorrect must NOT
	return hasCorrect && !hasIncorrect;
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

	const { log } = await initLog("incorrect_info");
	const rows: string[][] = [];

	let correctWithout = 0;
	let correctWith = 0;
	let totalTokens = 0;
	let totalQuestions = 0;

	for (const q of questionsToRun) {
		totalQuestions++;
		console.log(
			`--- Q${singleIndex != null ? singleIndex : questionsToRun.indexOf(q)}: ${q.question}`,
		);

		// Mode 1: without-tool (parametric knowledge only)
		console.log("  [without-tool] running...");
		const withoutResult: AgentResult = await runAgentLoop(
			{
				system: SYSTEM_PROMPT,
				userMessage: q.question,
				tools: [],
			},
			log,
		);
		const withoutCorrect = judgeAnswer(
			withoutResult.answer,
			q.correctAnswer,
			q.incorrectValue,
			"without-tool",
		);
		if (withoutCorrect) correctWithout++;
		totalTokens += withoutResult.inputTokens + withoutResult.outputTokens;

		console.log(`  [without-tool] answer: ${withoutResult.answer.slice(0, 120)}`);
		console.log(`  [without-tool] correct: ${withoutCorrect}`);

		rows.push([
			q.question,
			q.correctAnswer,
			q.incorrectValue,
			"without-tool",
			String(withoutResult.usedTool),
			withoutResult.answer.replace(/\t/g, " ").replace(/\n/g, " "),
			String(withoutCorrect),
			String(withoutResult.turns),
			String(withoutResult.inputTokens),
			String(withoutResult.outputTokens),
		]);

		// Mode 2: with-tool (modified Wikipedia results)
		console.log("  [with-tool] running...");
		const withResult: AgentResult = await runAgentLoop(
			{
				system: SYSTEM_PROMPT,
				userMessage: q.question,
				toolHandler: async (name: string, input: Record<string, unknown>) => {
					const result = await defaultToolHandler(name, input);
					return modifyResult(result, q.correctAnswer, q.incorrectValue);
				},
			},
			log,
		);
		const withCorrect = judgeAnswer(
			withResult.answer,
			q.correctAnswer,
			q.incorrectValue,
			"with-tool",
		);
		if (withCorrect) correctWith++;
		totalTokens += withResult.inputTokens + withResult.outputTokens;

		console.log(`  [with-tool] answer: ${withResult.answer.slice(0, 120)}`);
		console.log(`  [with-tool] correct: ${withCorrect}`);
		console.log();

		rows.push([
			q.question,
			q.correctAnswer,
			q.incorrectValue,
			"with-tool",
			String(withResult.usedTool),
			withResult.answer.replace(/\t/g, " ").replace(/\n/g, " "),
			String(withCorrect),
			String(withResult.turns),
			String(withResult.inputTokens),
			String(withResult.outputTokens),
		]);
	}

	// Write TSV
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
	await writeTsvResults("incorrect_info", headers, rows);

	// Summary
	const pctWithout = ((correctWithout / totalQuestions) * 100).toFixed(1);
	const pctWith = ((correctWith / totalQuestions) * 100).toFixed(1);
	const delta = (
		(correctWith / totalQuestions) * 100 -
		(correctWithout / totalQuestions) * 100
	).toFixed(1);

	console.log("=".repeat(50));
	console.log("RESULTS");
	console.log("=".repeat(50));
	console.log(`% correct without tool: ${pctWithout}% (${correctWithout}/${totalQuestions})`);
	console.log(`% correct with tool (modified): ${pctWith}% (${correctWith}/${totalQuestions})`);
	console.log(`Delta: ${delta}%`);
	console.log(`Total tokens used: ${totalTokens}`);
}

// Only run when executed directly, not when imported by tests
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main();
}
