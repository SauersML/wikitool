// HLE Sauers Benchmark
// Evaluates the Wikipedia tool on questions from Humanity's Last Exam.
// Questions are loaded from datasets/QA bench - HLE questions.tsv
// Usage: bun src/evals/hle_sauers.ts [questionIndex]

import {
	DEFAULT_MODEL,
	extractFinalAnswer,
	gradeWithModel,
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
	"You are a helpful assistant taking a challenging exam. Answer each question as accurately as possible. If you have access to a search tool, use it when you think it would help.\n\nIMPORTANT: Always show your reasoning step by step before giving your final answer. Explain your thought process, what you considered, and why you chose your answer.\n\nFor multiple choice questions, reason through the options then clearly state your answer letter. For exact match questions, explain your reasoning then provide a precise answer. For multiple choice, end with ANSWER: followed by the letter. For exact match, end with ANSWER: followed by your answer.";

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

	// Try extracting from an explicit ANSWER line first
	const finalAnswer = extractFinalAnswer(response);
	if (finalAnswer !== null) {
		// Check if the extracted answer contains the expected letter as a standalone choice
		const extractedEscaped = escapeRegex(letter);
		const extractedPatterns = [
			new RegExp(`^\\s*\\(?${extractedEscaped}\\)?\\s*$`, "i"),
			new RegExp(`(?:^|[\\s(])${extractedEscaped}(?=$|[\\s.,;:!?)])`, "i"),
		];
		return extractedPatterns.some((p) => p.test(finalAnswer));
	}

	// Fall back to complex pattern matching on the full response
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

	// Try to extract a final answer line first to avoid matching incidental mentions
	const finalAnswer = extractFinalAnswer(response);
	const textToJudge = finalAnswer ?? response;

	// Direct substring match (case-insensitive)
	if (textToJudge.toLowerCase().includes(expected.toLowerCase())) {
		return true;
	}

	// For numeric answers, parse and compare with tolerance
	const expectedNum = Number.parseFloat(expected);
	if (!Number.isNaN(expectedNum)) {
		const numbers = extractNumbers(textToJudge);
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
	return matches.map((m) => Number.parseFloat(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Reasoning grading ---

export interface ReasoningGrade {
	score: number; // 1-5
	notes: string;
}

export async function gradeReasoning(
	question: string,
	modelResponse: string,
	referenceRationale: string,
): Promise<ReasoningGrade> {
	if (!referenceRationale.trim()) {
		return { score: 0, notes: "no reference rationale" };
	}

	const prompt = `You are evaluating the quality of a model's reasoning on an exam question.

QUESTION:
${question.slice(0, 1500)}

REFERENCE RATIONALE (the correct reasoning):
${referenceRationale.slice(0, 2000)}

MODEL'S RESPONSE (including its reasoning):
${modelResponse.slice(0, 2000)}

Grade the model's REASONING (not just the final answer) on a 1-5 scale:
1 = No reasoning shown, or reasoning is completely wrong/irrelevant
2 = Some reasoning but misses the key insight or has major logical errors
3 = Partially correct reasoning — gets some key points but misses important ones
4 = Mostly correct reasoning — identifies the key insight with minor gaps
5 = Excellent reasoning — correctly identifies the core logic matching the reference rationale

Respond ONLY with JSON: {"score": N, "notes": "one sentence explanation"}`;

	const raw = await gradeWithModel(prompt);
	try {
		const match = raw.match(/\{[^{}]*"score"\s*:\s*\d[^{}]*\}/);
		if (match) {
			const parsed = JSON.parse(match[0]);
			return {
				score: Math.min(5, Math.max(1, Number(parsed.score) || 1)),
				notes: String(parsed.notes ?? ""),
			};
		}
	} catch {
		// fallback
	}
	const scoreMatch = raw.match(/"score"\s*:\s*(\d)/);
	return {
		score: scoreMatch?.[1] ? Number.parseInt(scoreMatch[1], 10) : 1,
		notes: "",
	};
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
		},
		log,
	);

	const isCorrect = judge(q, result.answer);
	const toolQueries = result.toolCalls.map((tc) => tc.input["query"] ?? "").join("; ");

	// Grade reasoning quality against the reference rationale
	const reasoning = await gradeReasoning(q.question, result.answer, q.rationale);

	console.log(
		`           correct=${isCorrect} reasoning=${reasoning.score}/5 tools=${result.toolCalls.length}`,
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
		reasoningScore: String(reasoning.score),
		reasoningNotes: reasoning.notes.replace(/\t/g, " ").replace(/\n/g, " "),
		turns: String(result.turns),
		inputTokens: String(result.inputTokens),
		outputTokens: String(result.outputTokens),
		durationMs: String(Math.round(result.durationMs)),
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
		"reasoning_score",
		"reasoning_notes",
		"turns",
		"input_tokens",
		"output_tokens",
		"duration_ms",
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
				result.reasoningScore,
				result.reasoningNotes,
				result.turns,
				result.inputTokens,
				result.outputTokens,
				result.durationMs,
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

	const meanReasoning = (subset: string[][]) => {
		const scores = subset.map((r) => Number(r[10])).filter((n) => n > 0);
		return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
	};

	console.log(
		`  With tool:    ${correctWith}/${withToolRows.length} correct (${((correctWith / withToolRows.length) * 100).toFixed(1)}%)  reasoning: ${meanReasoning(withToolRows).toFixed(1)}/5`,
	);
	console.log(
		`  Without tool: ${correctWithout}/${withoutToolRows.length} correct (${((correctWithout / withoutToolRows.length) * 100).toFixed(1)}%)  reasoning: ${meanReasoning(withoutToolRows).toFixed(1)}/5`,
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
	const totalInput = rows.reduce((sum, r) => sum + Number(r[13]), 0);
	const totalOutput = rows.reduce((sum, r) => sum + Number(r[14]), 0);
	console.log(`\n  Total tokens: ${totalInput} input, ${totalOutput} output`);

	const tsvPath = await writeTsvResults("hle_sauers", headers, rows);
	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

main();
