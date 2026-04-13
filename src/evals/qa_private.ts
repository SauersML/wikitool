// QA Private Benchmark
// Evaluates the Wikipedia tool on private QA questions.
// Questions are loaded from datasets/QA bench - Private questions.tsv
// Usage: bun src/evals/qa_private.ts [questionIndex]

import {
	DEFAULT_MODEL,
	extractFinalAnswer,
	gradeWithModel,
	initLog,
	pairedPermutationTest,
	runAgentLoop,
	WIKI_TOOL,
	writeTsvResults,
} from "./utils";

// --- Types ---

export interface PrivateQuestion {
	question: string;
	answer: string;
	answerType: "multipleChoice" | "exactMatch";
	rationale: string;
	subject: string;
	category: string;
}

// --- System prompt ---

export const SYSTEM_PROMPT =
	"You are a helpful assistant taking a challenging exam. Answer each question as accurately as possible. If you have access to a search tool, use it when you think it would help.\n\nIMPORTANT: Always show your reasoning step by step before giving your final answer. Explain your thought process, what you considered, and why you chose your answer.\n\nFor multiple choice questions, reason through the options then clearly state your answer letter. For exact match questions, explain your reasoning then provide a precise answer. For multiple choice, end with ANSWER: followed by the letter. For exact match, end with ANSWER: followed by your answer.";

// --- Load questions from TSV ---

function parseTsv(content: string): PrivateQuestion[] {
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	// Skip header row
	const dataLines = lines.slice(1);
	return dataLines.map((line) => {
		const fields = line.split("\t");
		return {
			question: fields[0] ?? "",
			answer: fields[1] ?? "",
			answerType: (fields[2] ?? "") as "multipleChoice" | "exactMatch",
			rationale: fields[3] ?? "",
			subject: fields[4] ?? "",
			category: fields[5] ?? "",
		};
	});
}

const tsvPath = `${import.meta.dir}/../../datasets/QA bench - Private questions.tsv`;
const tsvContent = await Bun.file(tsvPath).text();
export const QUESTIONS: PrivateQuestion[] = parseTsv(tsvContent);

// --- Judging ---

/**
 * Extract the conclusion portion of a response for fallback answer matching.
 * Only searches the tail so that letters/values mentioned while reasoning
 * through options don't get mistaken for the final answer.
 */
function responseTail(response: string): string {
	const lastPara = response.lastIndexOf("\n\n");
	if (lastPara >= 0 && response.length - lastPara <= 1000) {
		return response.slice(lastPara);
	}
	return response.slice(-500);
}

export function judgeMultipleChoice(response: string, expectedAnswer: string): boolean {
	// Try extracting from an explicit ANSWER line first
	const finalAnswer = extractFinalAnswer(response);
	if (finalAnswer !== null) {
		// For compound answers like "C, C, C, E, A", do exact string matching on extracted answer
		if (expectedAnswer.includes(",")) {
			return finalAnswer.includes(expectedAnswer);
		}
		// For single-letter answers, check the extracted answer
		const escaped = expectedAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const extractedPatterns = [
			new RegExp(`^\\s*\\(?${escaped}\\)?\\s*$`, "i"),
			new RegExp(`(?:^|[\\s(])${escaped}(?=$|[\\s.,;:!?)])`, "i"),
		];
		return extractedPatterns.some((p) => p.test(finalAnswer));
	}

	// No explicit ANSWER: line found. Search only the tail of the response
	// to avoid matching the correct letter mentioned during reasoning.
	const tail = responseTail(response);

	// For compound answers like "C, C, C, E, A", do exact string matching.
	if (expectedAnswer.includes(",")) {
		return tail.includes(expectedAnswer);
	}
	// For single-letter answers, check for standalone letter (not part of a word).
	const escaped = expectedAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(?:^|\\b|\\s|\\()${escaped}(?:\\b|\\s|\\.|,|\\)|$)`, "i");
	return regex.test(tail);
}

export function judgeExactMatch(response: string, expectedAnswer: string): boolean {
	// Try to extract a final answer line first to avoid matching incidental mentions
	const finalAnswer = extractFinalAnswer(response);
	const textToJudge = finalAnswer ?? responseTail(response);

	// For complex answers with braces, brackets, or commas, do exact string matching
	if (
		expectedAnswer.includes("{") ||
		expectedAnswer.includes("[") ||
		expectedAnswer.includes(",")
	) {
		return textToJudge.includes(expectedAnswer);
	}

	// For simple string answers, check containment (case-insensitive)
	if (textToJudge.toLowerCase().includes(expectedAnswer.toLowerCase())) {
		return true;
	}

	// For numeric answers, try parsing and comparing with tolerance
	const expectedNum = Number.parseFloat(expectedAnswer);
	if (!Number.isNaN(expectedNum)) {
		const numMatches = textToJudge.match(/[\d,]+\.?\d*/g);
		if (numMatches) {
			const numbers = numMatches
				.map((m) => Number.parseFloat(m.replace(/,/g, "")))
				.filter((n) => !Number.isNaN(n));
			// Allow a small tolerance for numeric comparison
			return numbers.some((n) => Math.abs(n - expectedNum) <= Math.abs(expectedNum) * 0.01);
		}
	}

	return false;
}

// --- Reasoning grading ---

export interface ReasoningGrade {
	score: number;
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
	const match = raw.match(/\{[^{}]*"score"\s*:\s*\d[^{}]*\}/);
	if (!match) throw new Error(`Failed to parse reasoning grade: ${raw.slice(0, 200)}`);
	const parsed = JSON.parse(match[0]);
	const score = Number(parsed.score);
	if (score < 1 || score > 5) throw new Error(`Reasoning score out of range: ${score}`);
	return { score, notes: String(parsed.notes) };
}

export function judge(question: PrivateQuestion, response: string): boolean {
	if (question.answerType === "multipleChoice") {
		return judgeMultipleChoice(response, question.answer);
	}
	return judgeExactMatch(response, question.answer);
}

// --- Main ---

async function runQuestion(
	q: PrivateQuestion,
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

	console.log(`QA Private Benchmark`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log(`Modes: with-tool, without-tool\n`);

	const { log, path: logPath } = await initLog("qa_private");

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

	const perm = pairedPermutationTest(
		withToolRows.map((r) => (r[9] === "true" ? 1 : 0)),
		withoutToolRows.map((r) => (r[9] === "true" ? 1 : 0)),
	);
	console.log(`  Permutation test: diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`);

	// Breakdown by category
	const categories = [...new Set(QUESTIONS.map((q) => q.category))];
	console.log(`\n  Category breakdown:`);
	for (const cat of categories) {
		const catWithTool = withToolRows.filter((r) => r[4] === cat && r[9] === "true").length;
		const catWithToolTotal = withToolRows.filter((r) => r[4] === cat).length;
		const catWithoutTool = withoutToolRows.filter((r) => r[4] === cat && r[9] === "true").length;
		const catWithoutToolTotal = withoutToolRows.filter((r) => r[4] === cat).length;
		console.log(
			`    ${cat.padEnd(20)} with-tool: ${catWithTool}/${catWithToolTotal}  without-tool: ${catWithoutTool}/${catWithoutToolTotal}`,
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

	const tsvPath = await writeTsvResults("qa_private", headers, rows);
	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported
const isMainModule =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("qa_private.ts");

if (isMainModule && !process.env["BUN_TEST"]) {
	main();
}
