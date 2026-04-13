// HLE Sauers Benchmark
// Evaluates the Wikipedia tool on questions from Humanity's Last Exam.
// Questions are loaded from datasets/QA bench - HLE questions.tsv
// Usage: bun src/evals/hle_sauers.ts [questionIndex]

import {
	DEFAULT_MODEL,
	defaultToolHandler,
	initLog,
	runAgentLoop,
	WIKI_TOOL,
	writeTsvResults,
} from "./utils";

// --- Types ---

export interface HLEQuestion {
	question: string;
	answer: string;
	answerType: "multipleChoice" | "exactMatch";
	rationale: string;
	subject: string;
	category: string;
}

// --- Loading ---

function parseTsv(content: string): HLEQuestion[] {
	const lines = content
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.filter((line) => line.trim().length > 0);

	// Skip header
	const dataLines = lines.slice(1);

	return dataLines.map((line) => {
		const [question, answer, answerType, rationale, subject, category] = line.split("\t");
		if (!question || !answer || !answerType) {
			throw new Error(`Invalid TSV row: ${line.slice(0, 100)}...`);
		}
		if (answerType !== "multipleChoice" && answerType !== "exactMatch") {
			throw new Error(`Invalid answer_type: "${answerType}"`);
		}
		return {
			question,
			answer,
			answerType,
			rationale: rationale ?? "",
			subject: subject ?? "",
			category: category ?? "",
		};
	});
}

const tsvPath = `${import.meta.dir}/../../datasets/QA bench - HLE questions.tsv`;
const tsvContent = await Bun.file(tsvPath).text();
export const QUESTIONS: HLEQuestion[] = parseTsv(tsvContent);

// --- System prompt ---

export const SYSTEM_PROMPT =
	"You are a helpful assistant taking a challenging exam. Answer each question as accurately as possible. If you have access to a search tool, use it when you think it would help. For multiple choice questions, clearly state your answer letter. For exact match questions, provide a precise answer.";

// --- Judging ---

/**
 * For multipleChoice: check if the response contains the correct letter as a
 * standalone choice (e.g. "B"), not merely as part of a word. We look for the
 * letter preceded and followed by a word boundary or common delimiters.
 *
 * For exactMatch: check if the response contains the expected answer string.
 * For numeric answers, also try parsing and comparing with a small tolerance.
 */
export function judge(question: HLEQuestion, response: string): boolean {
	if (question.answerType === "multipleChoice") {
		return judgeMultipleChoice(response, question.answer);
	}
	return judgeExactMatch(response, question.answer);
}

export function judgeMultipleChoice(response: string, expectedLetter: string): boolean {
	const letter = expectedLetter.trim();
	const escaped = escapeRegex(letter);

	// Strategy: look for patterns that indicate the model chose this answer.
	// We check multiple common answer-indicating patterns.
	const patterns = [
		// "answer is X", "answer: X", "answer is (X)"
		new RegExp(`answer\\s+is\\s*:?\\s*\\(?${escaped}\\)?`, "i"),
		// "Answer: X" or "answer:X"
		new RegExp(`answer\\s*:\\s*\\(?${escaped}\\)?(?=$|[\\s.,;:!?)])`, "i"),
		// "(X)" as a standalone choice
		new RegExp(`\\(${escaped}\\)`, "i"),
		// "option X" or "choice X"
		new RegExp(`(?:option|choice)\\s+${escaped}(?=$|[\\s.,;:!?)])`, "i"),
		// "X." or "X," or "X)" at start of line (common for listing the answer)
		new RegExp(`^\\s*${escaped}[.,;:)]`, "m"),
		// "select X" or "choose X" or "go with X" or "pick X"
		new RegExp(`(?:select|choose|go\\s+with|pick)\\s+${escaped}(?=$|[\\s.,;:!?)])`, "i"),
		// "is X." or "is X," at end of sentence
		new RegExp(`is\\s+${escaped}(?=$|[\\s.,;:!?)])`, "i"),
		// Bold/emphasized answer: **X** or *X*
		new RegExp(`\\*\\*${escaped}\\*\\*|\\*${escaped}\\*`),
		// "X is correct" or "X is the correct" or "X is the answer"
		new RegExp(`(?:^|[\\s(])${escaped}\\s+is\\s+(?:the\\s+)?(?:correct|answer)`, "im"),
		// Letter at end of response (last non-whitespace chars)
		new RegExp(`${escaped}[.!)?]*\\s*$`, "m"),
	];

	return patterns.some((p) => p.test(response));
}

export function judgeExactMatch(response: string, expectedAnswer: string): boolean {
	const expected = expectedAnswer.trim();

	// Direct substring match (case-insensitive)
	if (response.toLowerCase().includes(expected.toLowerCase())) {
		return true;
	}

	// For numeric answers, parse and compare with tolerance
	const expectedNum = Number.parseFloat(expected);
	if (!Number.isNaN(expectedNum)) {
		const numbers = extractNumbers(response);
		const tolerance = Math.abs(expectedNum) * 0.02; // 2% tolerance
		if (numbers.some((n) => Math.abs(n - expectedNum) <= tolerance)) {
			return true;
		}
	}

	return false;
}

export function extractNumbers(text: string): number[] {
	const matches = text.match(/[\d,]+\.?\d*/g);
	if (!matches) return [];
	return matches
		.map((m) => Number.parseFloat(m.replace(/,/g, "")))
		.filter((n) => !Number.isNaN(n));
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Running ---

async function runQuestion(
	q: HLEQuestion,
	index: number,
	mode: "with-tool" | "without-tool",
	log: (entry: unknown) => Promise<void>,
) {
	const tools = mode === "with-tool" ? [WIKI_TOOL] : [];

	console.log(`  [${index}] ${mode.padEnd(12)} "${q.question.slice(0, 60)}..."`);

	const result = await runAgentLoop(
		{
			system: SYSTEM_PROMPT,
			userMessage: q.question,
			tools,
			...(mode === "with-tool" ? { toolHandler: defaultToolHandler } : {}),
		},
		log,
	);

	const isCorrect = judge(q, result.answer);
	const toolQueries = result.toolCalls.map((tc) => tc.input["query"] ?? "").join("; ");

	console.log(
		`           answer="${result.answer.slice(0, 80)}" correct=${isCorrect} tools=${result.toolCalls.length}`,
	);

	return {
		question: q.question.slice(0, 80),
		answer: q.answer,
		answerType: q.answerType,
		subject: q.subject,
		category: q.category,
		mode,
		usedTool: String(result.usedTool),
		toolQueries,
		modelAnswer: result.answer.replace(/\t/g, " ").replace(/\n/g, " "),
		isCorrect: String(isCorrect),
		turns: String(result.turns),
		inputTokens: String(result.inputTokens),
		outputTokens: String(result.outputTokens),
	};
}

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] ? Number.parseInt(process.argv[2], 10) : undefined;
	const questionsToRun =
		singleIndex !== undefined
			? [{ q: QUESTIONS[singleIndex]!, i: singleIndex }]
			: QUESTIONS.map((q, i) => ({ q, i }));

	if (singleIndex !== undefined && !QUESTIONS[singleIndex]) {
		console.error(`Invalid question index: ${singleIndex}. Must be 0-${QUESTIONS.length - 1}.`);
		process.exit(1);
	}

	console.log(`HLE Sauers Benchmark`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log(`Modes: with-tool, without-tool\n`);

	const { log, path: logPath } = await initLog("hle_sauers");

	const headers = [
		"question",
		"answer",
		"answer_type",
		"subject",
		"category",
		"mode",
		"used_tool",
		"tool_queries",
		"model_answer",
		"is_correct",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const rows: string[][] = [];

	for (const { q, i } of questionsToRun) {
		for (const mode of ["with-tool", "without-tool"] as const) {
			const result = await runQuestion(q, i, mode, log);
			rows.push([
				result.question,
				result.answer,
				result.answerType,
				result.subject,
				result.category,
				result.mode,
				result.usedTool,
				result.toolQueries,
				result.modelAnswer,
				result.isCorrect,
				result.turns,
				result.inputTokens,
				result.outputTokens,
			]);
		}
	}

	// --- Summary ---
	console.log(`\n${"─".repeat(60)}`);
	console.log("Summary\n");

	const withToolRows = rows.filter((r) => r[5] === "with-tool");
	const withoutToolRows = rows.filter((r) => r[5] === "without-tool");

	const correctWith = withToolRows.filter((r) => r[9] === "true").length;
	const correctWithout = withoutToolRows.filter((r) => r[9] === "true").length;

	console.log(
		`  With tool:    ${correctWith}/${withToolRows.length} correct (${((correctWith / withToolRows.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Without tool: ${correctWithout}/${withoutToolRows.length} correct (${((correctWithout / withoutToolRows.length) * 100).toFixed(1)}%)`,
	);

	// Breakdown by category
	const categories = [...new Set(QUESTIONS.map((q) => q.category))];
	console.log(`\n  Category breakdown:`);
	for (const cat of categories) {
		const catWithTool = withToolRows.filter((r) => r[4] === cat);
		const catWithoutTool = withoutToolRows.filter((r) => r[4] === cat);
		const catCorrectWith = catWithTool.filter((r) => r[9] === "true").length;
		const catCorrectWithout = catWithoutTool.filter((r) => r[9] === "true").length;
		console.log(
			`    ${cat.padEnd(25)} with-tool: ${catCorrectWith}/${catWithTool.length}  without-tool: ${catCorrectWithout}/${catWithoutTool.length}`,
		);
	}

	// Per-question table
	console.log(`\n  ${"Question".padEnd(65)} ${"With".padEnd(7)} Without`);
	console.log(`  ${"─".repeat(65)} ${"─".repeat(7)} ${"─".repeat(7)}`);
	for (const { q } of questionsToRun) {
		const wt = withToolRows.find((r) => r[0] === q.question.slice(0, 80));
		const wo = withoutToolRows.find((r) => r[0] === q.question.slice(0, 80));
		const short = q.question.slice(0, 63).padEnd(65);
		console.log(
			`  ${short} ${(wt?.[9] === "true" ? "Y" : "N").padEnd(7)} ${wo?.[9] === "true" ? "Y" : "N"}`,
		);
	}

	// Token totals
	const totalInput = rows.reduce((sum, r) => sum + Number(r[11]), 0);
	const totalOutput = rows.reduce((sum, r) => sum + Number(r[12]), 0);
	console.log(`\n  Total tokens: ${totalInput} input, ${totalOutput} output`);

	const tsvPath = await writeTsvResults("hle_sauers", headers, rows);
	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

main();
