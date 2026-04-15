// QA Private Benchmark
// Evaluates the Wikipedia tool on private QA questions.
// Questions are loaded from datasets/QA bench - Private questions.tsv
// Usage: bun src/evals/qa_private.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	extractJson,
	extractNumbers,
	gradeWithModel,
	initEvalSession,
	leadingLetterIs,
	matchesAny,
	pairedPermutationTest,
	parseResumeArg,
	parseTsvRows,
	reportStyleControlledHeadline,
	runAgent,
	runKey,
	type StyleControlPair,
	safeGrade,
	stripCodeFences,
	textContainsAnswerLetter,
	WIKI_TOOL_NAME,
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

// Eval-specific task prompt — answer format only. Avoids "challenging exam"
// framing, which primes the model toward excessive caution.
const TASK_PROMPT = `YOUR FINAL LINE must be exactly:
ANSWER: <your answer>

For multiple choice, give ONLY the letter, e.g. ANSWER: B
For exact match, give the precise value, e.g. ANSWER: 42

Do not write anything after the ANSWER line.`;

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool: drop the wiki-centric SHARED_SYSTEM_PROMPT (nonsense without the
// tool) but keep TASK_PROMPT so the answer-formatting instruction applies in
// both modes — needed for the judge to extract "ANSWER: …".
const NO_TOOL_SYSTEM_PROMPT: string | undefined = TASK_PROMPT;

// --- Load questions from TSV ---

function parseTsv(content: string): PrivateQuestion[] {
	const rows = parseTsvRows(content);
	// Skip header row
	return rows.slice(1).map((fields) => ({
		question: fields[0] ?? "",
		answer: fields[1] ?? "",
		answerType: (fields[2] ?? "") as "multipleChoice" | "exactMatch",
		rationale: fields[3] ?? "",
		subject: fields[4] ?? "",
		category: fields[5] ?? "",
	}));
}

const tsvPath = `${import.meta.dir}/../../datasets/QA bench - Private questions.tsv`;
const tsvContent = await Bun.file(tsvPath).text();
export const QUESTIONS: PrivateQuestion[] = parseTsv(tsvContent);

// --- Judging ---

/**
 * Normalise unicode/whitespace noise before parsing/matching. Models frequently
 * emit NBSPs, smart quotes, and zero-width joiners around the final answer.
 */
function normaliseResponse(response: string): string {
	return stripCodeFences(response)
		.replace(/[\u00A0\u2007\u202F]/g, " ")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[\u2018\u2019\u201B\u2032]/g, "'")
		.replace(/[\u201C\u201D\u201F\u2033]/g, '"')
		.replace(/\r\n?/g, "\n");
}

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

/** Collapse runs of whitespace — compound answers like "C, C, C, E, A" vs
 *  "C,C,C,E,A" or "{1, 2, 3, 5}" vs "{1,2,3,5}" should match modulo spacing. */
function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, "").toLowerCase();
}

/** True for expected answers that are structurally complex (set/tuple/list/Q&A).
 *  These need verbatim-ish matching — loose word-boundary containment would
 *  accept partial sequences. */
function isStructuralAnswer(expected: string): boolean {
	return /[{}[\]]/.test(expected) || expected.includes(",") || /:\s/.test(expected);
}

export function judgeMultipleChoice(response: string, expectedAnswer: string): boolean {
	const clean = normaliseResponse(response);
	if (!clean.trim()) return false;

	// Try extracting from an explicit ANSWER line first
	const finalAnswer = extractFinalAnswer(clean);
	if (finalAnswer !== null) {
		// Compound answers like "C, C, C, E, A": compare ignoring whitespace so
		// "C,C,C,E,A" also matches. Guard against the extracted answer being a
		// much larger sentence that merely contains the sequence.
		if (isStructuralAnswer(expectedAnswer)) {
			return collapseWhitespace(finalAnswer).includes(collapseWhitespace(expectedAnswer));
		}
		// For single-letter answers: prefer the leading letter of the extracted text.
		// "ANSWER: B" → B, "ANSWER: (B)" → B, "ANSWER: B, because..." → B.
		if (leadingLetterIs(finalAnswer, expectedAnswer)) return true;
		// No clear leading letter — check for standalone letter anywhere in extracted text
		return textContainsAnswerLetter(finalAnswer, expectedAnswer);
	}

	// No explicit ANSWER: line found. Search only the tail of the response
	// to avoid matching the correct letter mentioned during reasoning.
	const tail = responseTail(clean);

	if (isStructuralAnswer(expectedAnswer)) {
		return collapseWhitespace(tail).includes(collapseWhitespace(expectedAnswer));
	}
	// For single-letter answers, use string-based answer detection.
	return textContainsAnswerLetter(tail, expectedAnswer);
}

export function judgeExactMatch(response: string, expectedAnswer: string): boolean {
	const clean = normaliseResponse(response);
	if (!clean.trim()) return false;

	// Try to extract a final answer line first to avoid matching incidental mentions
	const finalAnswer = extractFinalAnswer(clean);
	const textToJudge = finalAnswer ?? responseTail(clean);

	// Structural answers (sets, lists, compound Q&A) — compare with whitespace
	// collapsed so `{1,2,3,5}` matches `{1, 2, 3, 5}`. Substring (not word-
	// boundary) match is correct here: the structural punctuation itself acts
	// as a boundary.
	if (isStructuralAnswer(expectedAnswer)) {
		return collapseWhitespace(textToJudge).includes(collapseWhitespace(expectedAnswer));
	}

	// Purely numeric expected answer — require exact numeric equality (or tight
	// tolerance for floats). Word-boundary string match happens below for
	// answers like "14" so "140" / "14th" won't spuriously match.
	const expectedNum = Number.parseFloat(expectedAnswer);
	const expectedIsNumber =
		!Number.isNaN(expectedNum) && /^-?\d+(?:\.\d+)?$/.test(expectedAnswer.trim());
	if (expectedIsNumber) {
		const numbers = extractNumbers(textToJudge);
		if (Number.isInteger(expectedNum)) {
			if (numbers.some((n) => n === expectedNum)) return true;
		} else {
			const tol = Math.max(
				Math.abs(expectedNum) * 0.02,
				expectedNum === Math.floor(expectedNum) ? 0.5 : 1e-6,
			);
			if (numbers.some((n) => Math.abs(n - expectedNum) <= tol)) return true;
		}
		return false;
	}

	// String answers — word-boundary containment (case-insensitive) so
	// "lexicon" matches "Lexicon." but not "lexicons" / "lexicography".
	return matchesAny(textToJudge, [expectedAnswer]);
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

	const prompt = `You are grading the QUALITY of a model's reasoning on an exam question. Judge logical soundness, not surface similarity to the reference.

QUESTION:
${question.slice(0, 1500)}

REFERENCE RATIONALE (one correct derivation; other valid derivations are equally acceptable):
${referenceRationale.slice(0, 2000)}

MODEL'S RESPONSE (may include tool-call transcripts as well as reasoning):
${modelResponse.slice(0, 4000)}

Grading rubric (1-5):
1 = No reasoning, refusal, or reasoning that is wrong/irrelevant to the question.
2 = Some relevant reasoning but a major logical error or missing the key insight.
3 = Partially correct — identifies some key facts/steps but misses important ones or makes a material error.
4 = Mostly correct — sound reasoning with minor gaps or unjustified leaps.
5 = Fully correct reasoning that justifies the answer, whether or not it mirrors the reference wording. An independent derivation that reaches the right conclusion for the right reasons deserves 5.

Do NOT penalise differences in style, length, or phrasing. Do NOT reward surface copying of the reference if the logic is absent. If the model refused or produced no reasoning, score 1.

Respond with ONLY a JSON object on the final line: {"score": N, "notes": "one sentence explanation"}`;

	const raw = await gradeWithModel(prompt);
	const parsed = extractJson(raw);
	if (!parsed) throw new Error(`Failed to parse reasoning grade: ${raw.slice(0, 200)}`);
	const rawScore = Number(parsed.score);
	if (!Number.isFinite(rawScore)) throw new Error(`Reasoning score not numeric: ${parsed.score}`);
	const score = Math.round(rawScore);
	if (score < 1 || score > 5) throw new Error(`Reasoning score out of range: ${rawScore}`);
	return { score, notes: String(parsed.notes ?? "") };
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
	serialise: <T>(fn: () => Promise<T>) => Promise<T>,
	appendRow: (row: string[]) => Promise<void>,
	progress: { done: number; total: number },
): Promise<string[]> {
	const agentOpts: Parameters<typeof runAgent>[0] =
		mode === "with-tool"
			? {
					system: SYSTEM_PROMPT,
					prompt: q.question,
					mcpServers: { wiki: createWikiMcpServer({ seen: createSeenContent() }) },
					allowedTools: [WIKI_TOOL_NAME],
				}
			: {
					system: NO_TOOL_SYSTEM_PROMPT,
					prompt: q.question,
				};

	const result = await runAgent(agentOpts);

	const isCorrect = judge(q, result.answer);
	const toolQueries = result.toolCalls.map((tc) => tc.input["query"] ?? "").join("; ");

	// Grader wrapped in safeGrade — a malformed grader response shouldn't kill the eval.
	const reasoning = await safeGrade({
		fn: () => gradeReasoning(q.question, result.answer, q.rationale),
		fallback: { score: 0, notes: "grader failed to parse" },
		log,
		context: { eval: "qa_private", index, mode, grader: "gradeReasoning" },
	});

	const row: string[] = [
		q.question.slice(0, 80),
		q.answer,
		q.answerType,
		q.subject,
		q.category,
		mode,
		String(result.usedTool),
		toolQueries,
		result.answer,
		String(isCorrect),
		String(reasoning.score),
		reasoning.notes,
		String(result.turns),
		String(result.inputTokens),
		String(result.outputTokens),
		String(Math.round(result.durationMs)),
	];

	await serialise(async () => {
		await log(
			buildRunLogEntry({
				index,
				mode,
				question: q.question,
				expected: q.answer,
				agentResult: result,
				verdict: {
					correct: isCorrect,
					reasoning_score: reasoning.score,
					reasoning_notes: reasoning.notes,
					answer_type: q.answerType,
				},
				extra: { subject: q.subject, category: q.category },
				tsvRow: row,
			}),
		);
		await appendRow(row);
		progress.done++;
		console.log(
			`[${progress.done}/${progress.total}] [${index}][${mode}] correct=${isCorrect} reasoning=${reasoning.score}/5 tools=${result.toolCalls.length} — "${q.question.slice(0, 50)}..."`,
		);
	});

	return row;
}

async function main() {
	// Strip --flag NAME pairs (e.g. `--resume <path>`) before scanning for the
	// optional positional question index.
	const args = process.argv.slice(2);
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			i++; // also consume the flag's value
			continue;
		}
		positional.push(a);
	}
	const singleIndex = positional[0] !== undefined ? Number.parseInt(positional[0], 10) : undefined;
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

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "qa_private",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "qa_private",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["with-tool", "without-tool"],
		single_index: singleIndex ?? null,
		resumed_from: resume ?? null,
	});

	// Build the (question × mode) job list, skipping anything pre-completed.
	type Job = { q: PrivateQuestion; i: number; mode: "with-tool" | "without-tool" };
	const allJobs: Job[] = [];
	for (const { q, i } of questionsToRun) {
		for (const mode of ["with-tool", "without-tool"] as const) {
			allJobs.push({ q, i, mode });
		}
	}
	const jobs = allJobs.filter(({ i, mode }) => !completed.has(runKey(i, mode)));
	const skipped = allJobs.length - jobs.length;
	if (skipped > 0) console.log(`Skipping ${skipped} already-completed runs from prior session.\n`);
	console.log(`Launching ${jobs.length} jobs in parallel...\n`);

	let writeMutex: Promise<unknown> = Promise.resolve();
	const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
		const out = writeMutex.then(fn);
		writeMutex = out.then(
			() => undefined,
			() => undefined,
		);
		return out;
	};
	const progress = { done: 0, total: jobs.length };

	const rows: string[][] = [...resumedRows];

	const settled = await Promise.allSettled(
		jobs.map(({ q, i, mode }) =>
			runQuestion(q, i, mode, log, serialise, appendRow, progress).catch(async (err) => {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				console.error(`\n[FAIL] [${i}][${mode}]: ${message}`);
				await serialise(() =>
					log({
						event: "error",
						timestamp: new Date().toISOString(),
						index: i,
						mode,
						error: message,
						...(stack ? { stack } : {}),
					}),
				);
				throw err;
			}),
		),
	);

	for (const r of settled) {
		if (r.status === "fulfilled") rows.push(r.value);
	}
	const failed = settled.filter((r) => r.status === "rejected").length;
	if (failed > 0)
		console.log(`\n${failed}/${jobs.length} jobs failed (logged); resume with --resume ${logPath}`);

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

	// Style-controlled headlines for both LLM-graded outcomes (reasoning_score
	// is Sonnet-judged; is_correct is deterministic but reported alongside for
	// completeness). Cols: 0=question, 8=model_answer, 9=is_correct, 10=reasoning_score.
	{
		const buildPairs = (scoreCol: number, toNumber: (v: string) => number): StyleControlPair[] => {
			const out: StyleControlPair[] = [];
			for (const wt of withToolRows) {
				const wo = withoutToolRows.find((r) => r[0] === wt[0]);
				if (!wo) continue;
				out.push({
					withScore: toNumber(wt[scoreCol] ?? ""),
					noScore: toNumber(wo[scoreCol] ?? ""),
					withText: wt[8] ?? "",
					noText: wo[8] ?? "",
				});
			}
			return out;
		};
		await reportStyleControlledHeadline({
			label: "qa_private: is_correct",
			pairs: buildPairs(9, (v) => (v === "true" ? 1 : 0)),
			log,
		});
		await reportStyleControlledHeadline({
			label: "qa_private: reasoning_score",
			pairs: buildPairs(10, (v) => Number(v) || 0),
			log,
		});
	}

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

	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported
const isMainModule =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("qa_private.ts");

if (isMainModule && !process.env["BUN_TEST"]) {
	main();
}
