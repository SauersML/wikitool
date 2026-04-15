// HLE Sauers Benchmark
// Evaluates the Wikipedia tool on questions from Humanity's Last Exam.
// Questions load from datasets/QA bench - HLE questions.tsv.
// Usage: bun src/evals/hle_sauers.ts [questionIndex]

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
	const rows = parseTsvRows(content);
	// Skip header
	return rows.slice(1).map((fields) => {
		const [question, answer, answerType, rationale, subject, category] = fields;
		if (!question || !answer || !answerType) {
			throw new Error(`Invalid TSV row: ${fields.join("\t").slice(0, 100)}...`);
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

// Answer-format instructions appended to both the with-tool and no-tool prompts.
const TASK_PROMPT = `YOUR FINAL LINE must be exactly:
ANSWER: <your answer>

For multiple choice, give ONLY the letter, e.g. ANSWER: B
For exact match, give the precise value, e.g. ANSWER: 42

Do not write anything after the ANSWER line.`;

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool mode omits the wiki-centric shared sysprompt but keeps TASK_PROMPT so
// the judge can still extract "ANSWER: …".
const NO_TOOL_SYSTEM_PROMPT: string | undefined = TASK_PROMPT;

// --- Judging ---

/**
 * NFKC normalisation + collapse of whitespace. Handles unicode quirks the
 * model sometimes emits (non-breaking spaces, smart quotes in answers, etc.)
 * before any string-level matching.
 */
function normaliseText(s: string): string {
	return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Strip markdown emphasis/fences and trailing punctuation from an extracted
 * answer so "**B**", "`False`", and "42." all reduce to their bare value.
 */
function cleanAnswer(s: string): string {
	let out = stripCodeFences(s).trim();
	// Strip surrounding **…**, *…*, _…_, `…`, "…", '…'
	const wrappers: Array<[string, string]> = [
		["**", "**"],
		["*", "*"],
		["__", "__"],
		["_", "_"],
		["`", "`"],
		['"', '"'],
		["'", "'"],
	];
	for (const [l, r] of wrappers) {
		if (out.startsWith(l) && out.endsWith(r) && out.length >= l.length + r.length) {
			out = out.slice(l.length, out.length - r.length).trim();
		}
	}
	// Drop a single trailing sentence terminator (not ones that carry meaning like ]).
	out = out.replace(/[.!?,;:]+$/, "").trim();
	return out;
}

/**
 * Extract the conclusion portion of a response for fallback answer matching.
 * Only searches the tail so that letters/values mentioned while reasoning
 * through options don't get mistaken for the final answer. Prefers the last
 * non-empty line; falls back to a ~500-char window snapped to a line start.
 */
function responseTail(response: string): string {
	const trimmed = response.trimEnd();
	if (!trimmed) return "";
	const lastPara = trimmed.lastIndexOf("\n\n");
	if (lastPara >= 0 && trimmed.length - lastPara <= 1000) {
		return trimmed.slice(lastPara).trim();
	}
	if (trimmed.length <= 500) return trimmed;
	const window = trimmed.slice(-500);
	const firstNl = window.indexOf("\n");
	return firstNl >= 0 ? window.slice(firstNl + 1) : window;
}

/** Detect obviously-empty / refusal / upstream-error outputs so the grader
 *  short-circuits to "incorrect" without doing spurious substring matches. */
function isUnusableResponse(response: string): boolean {
	const t = response.trim();
	if (t.length === 0) return true;
	if (/^API Error\b/i.test(t)) return true;
	return false;
}

/**
 * For multipleChoice: check if the response contains the correct letter as a
 * standalone choice (e.g. "B"), not merely as part of a word.
 * For exactMatch: parse a candidate answer and compare with type-appropriate
 * rules (boolean word-boundary, numeric tolerance, set-of-letters, substring).
 */
export function judge(question: HLEQuestion, response: string): boolean {
	if (isUnusableResponse(response)) return false;
	if (question.answerType === "multipleChoice") {
		return judgeMultipleChoice(response, question.answer);
	}
	return judgeExactMatch(response, question.answer);
}

export function judgeMultipleChoice(response: string, expectedLetter: string): boolean {
	const letter = expectedLetter.trim();
	if (!letter) return false;

	// Prefer an explicit ANSWER / "the answer is" line.
	const finalAnswer = extractFinalAnswer(response);
	if (finalAnswer !== null) {
		const cleaned = cleanAnswer(finalAnswer);
		// Bare letter ("B", "(B)", "B, because…") → leading-letter check.
		if (leadingLetterIs(cleaned, letter)) return true;
		// Fall back to standalone-letter scan within the answer text.
		if (textContainsAnswerLetter(cleaned, letter)) return true;
		// Some models emit a bare letter on the final line after mentioning
		// "ANSWER:" mid-reasoning. Fall through to the tail scan below.
	}

	// No usable ANSWER line — search only the tail to avoid matching the
	// correct letter mentioned during reasoning through the options.
	const tail = responseTail(response);
	if (textContainsAnswerLetter(tail, letter)) return true;

	// Last-ditch: a pure single-letter final line (some models strip the
	// ANSWER: prefix and just emit "B" on its own line).
	const lastLine =
		tail
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.pop() ?? "";
	const bare = cleanAnswer(lastLine).replace(/^[([]|[)\]]$/g, "");
	if (bare.length === 1 && bare.toUpperCase() === letter.toUpperCase()) return true;

	return false;
}

/** Parse a "set of letters" answer like "{A, C, E, G, I}" / "A,C,E,G,I" /
 *  "A and C and E and G and I" into a canonical Set of uppercase letters.
 *  Returns null if the text doesn't look like such a set. */
function parseLetterSet(text: string): Set<string> | null {
	const t = normaliseText(text).replace(/[{}[\]()]/g, " ");
	const tokens = t.split(/[\s,;]+|\band\b/i).filter(Boolean);
	if (tokens.length === 0) return null;
	const letters = new Set<string>();
	for (const tok of tokens) {
		if (!/^[A-Za-z]$/.test(tok)) return null;
		letters.add(tok.toUpperCase());
	}
	return letters.size > 0 ? letters : null;
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

export function judgeExactMatch(response: string, expectedAnswer: string): boolean {
	const expectedRaw = expectedAnswer.trim();
	if (!expectedRaw) return false;

	const finalAnswer = extractFinalAnswer(response);
	const rawCandidate = finalAnswer ?? responseTail(response);
	const candidate = cleanAnswer(rawCandidate);
	const candidateN = normaliseText(candidate).toLowerCase();
	const expectedN = normaliseText(expectedRaw).toLowerCase();

	// 1. Set-of-letters (e.g. "{A, C, E, G, I}"). Order / bracket / spacing
	//    variations all need to pass.
	const expectedSet = expectedRaw.startsWith("{") ? parseLetterSet(expectedRaw) : null;
	if (expectedSet) {
		const candSet = parseLetterSet(candidate);
		if (candSet && setEquals(candSet, expectedSet)) return true;
		// Also try parsing the raw final answer in case cleanAnswer stripped braces.
		const rawSet = parseLetterSet(rawCandidate);
		if (rawSet && setEquals(rawSet, expectedSet)) return true;
		return false;
	}

	// 2. Boolean (True / False). Word-boundary so "False" doesn't match
	//    "Falsehood" and "True" doesn't match "construed". Also require the
	//    opposite value is NOT the one being asserted.
	if (expectedN === "true" || expectedN === "false") {
		const opposite = expectedN === "true" ? "false" : "true";
		const hasExpected = matchesAny(candidate, [expectedRaw]);
		const hasOpposite = matchesAny(candidate, [opposite]);
		if (hasExpected && !hasOpposite) return true;
		// Exact bare answer after cleaning is unambiguous.
		if (candidateN === expectedN) return true;
		return false;
	}

	// 3. Numeric answers. Integers demand exact match. Decimals come from
	//    multi-step derivations where the expected value's precision is not
	//    pinned down (e.g. expected 46.24, but a model that rounds intermediate
	//    steps differently might land on 46.2, 46, or 46.3). Accept any
	//    candidate that either (a) matches when both are rounded to any
	//    precision ≤ the expected's decimal places, or (b) lies within a 2%
	//    relative tolerance.
	const expectedNum = Number.parseFloat(expectedRaw.replaceAll(",", ""));
	if (!Number.isNaN(expectedNum) && /^-?[\d,]*\.?\d+$/.test(expectedRaw)) {
		if (candidateN === expectedN) return true;
		const numbers = extractNumbers(candidate);
		const expectedDecimals = expectedRaw.includes(".")
			? (expectedRaw.split(".")[1]?.length ?? 0)
			: 0;
		const isInteger = expectedDecimals === 0 && Number.isInteger(expectedNum);
		if (isInteger) {
			return numbers.some((n) => n === expectedNum);
		}
		const matchAtPrecision = (cand: number, decimals: number): boolean => {
			const factor = 10 ** decimals;
			return Math.round(cand * factor) === Math.round(expectedNum * factor);
		};
		const tolerance = Math.max(
			Math.abs(expectedNum) * 0.02,
			expectedNum === Math.floor(expectedNum) ? 0.5 : 1e-6,
		);
		if (
			numbers.some((n) => {
				if (Math.abs(n - expectedNum) <= tolerance) return true;
				for (let d = expectedDecimals; d >= 0; d--) {
					if (matchAtPrecision(n, d)) return true;
				}
				return false;
			})
		)
			return true;
		return false;
	}

	// 4. Generic string. Exact (normalised) match first, then word-boundary
	//    containment — safer than raw substring, which would let "False" leak
	//    into "False-positive" or "42" into "420".
	if (candidateN === expectedN) return true;
	if (matchesAny(candidate, [expectedRaw])) return true;
	return false;
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

	const prompt = `You are evaluating the quality of a model's REASONING on an exam question.
Grade the reasoning process, not whether the final letter/value happens to match.
A response can reach the right answer via wrong reasoning (low score) or reach the
wrong answer via mostly sound reasoning (mid score).

QUESTION:
${question.slice(0, 1500)}

REFERENCE RATIONALE (the correct line of reasoning):
${referenceRationale.slice(0, 2000)}

MODEL'S RESPONSE (reasoning + final answer):
${modelResponse.slice(0, 2000)}

Scale (integer 1-5):
1 = No reasoning shown, or reasoning is completely wrong/irrelevant
2 = Some reasoning but misses the key insight or has major logical errors
3 = Partially correct — gets some key points but misses important ones
4 = Mostly correct — identifies the key insight with minor gaps
5 = Excellent — correctly identifies the core logic matching the reference rationale

Respond with ONLY a single JSON object, no prose and no code fences:
{"score": <integer 1-5>, "notes": "<one short sentence>"}`;

	const raw = await gradeWithModel(prompt);
	const parsed = extractJson(raw);
	if (!parsed) throw new Error(`Failed to parse reasoning grade: ${raw.slice(0, 200)}`);
	const score = Math.round(Number(parsed.score));
	if (!Number.isFinite(score) || score < 1 || score > 5) {
		throw new Error(`Reasoning score out of range: ${parsed.score}`);
	}
	const notes = parsed.notes === undefined || parsed.notes === null ? "" : String(parsed.notes);
	return { score, notes };
}

// --- Running ---

async function runQuestion(
	q: HLEQuestion,
	index: number,
	mode: "with-tool" | "without-tool",
	log: (entry: unknown) => Promise<void>,
	serialise: <T>(fn: () => Promise<T>) => Promise<T>,
	appendRow: (row: string[]) => Promise<void>,
	progress: { done: number; total: number },
): Promise<string[]> {
	const agentOpts: Parameters<typeof runAgent>[0] = {
		system: mode === "with-tool" ? SYSTEM_PROMPT : NO_TOOL_SYSTEM_PROMPT,
		prompt: q.question,
	};

	if (mode === "with-tool") {
		const seen = createSeenContent();
		const wikiServer = createWikiMcpServer({ seen });
		agentOpts.mcpServers = { wiki: wikiServer };
		agentOpts.allowedTools = [WIKI_TOOL_NAME];
	}

	const result = await runAgent(agentOpts);

	const isCorrect = judge(q, result.answer);
	const toolQueries = result.toolCalls.map((tc) => tc.input["query"] ?? "").join("; ");

	// Grade reasoning quality against the reference rationale.
	// Wrapped in safeGrade: a malformed grader response shouldn't kill the eval.
	const reasoning = await safeGrade({
		fn: () => gradeReasoning(q.question, result.answer, q.rationale),
		fallback: { score: 0, notes: "grader failed to parse" },
		log,
		context: { eval: "hle_sauers", index, mode, grader: "gradeReasoning" },
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

	// Serialise the file writes + the console line so the streamed log/TSV/
	// stdout from concurrent jobs don't interleave bytes within a single line.
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

// --- Main ---

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

	console.log(`HLE Sauers Benchmark`);
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
		evalName: "hle_sauers",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "hle_sauers",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["with-tool", "without-tool"],
		single_index: singleIndex ?? null,
		resumed_from: resume ?? null,
	});

	// Build the (question × mode) job list and skip any pre-completed pairs.
	type Job = { q: HLEQuestion; i: number; mode: "with-tool" | "without-tool" };
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

	// Mutex serialises file/console writes so concurrent jobs don't interleave.
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

	// Style-controlled headlines (cols: 0=question, 8=model_answer, 9=is_correct, 10=reasoning_score).
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
			label: "hle_sauers: is_correct",
			pairs: buildPairs(9, (v) => (v === "true" ? 1 : 0)),
			log,
		});
		await reportStyleControlledHeadline({
			label: "hle_sauers: reasoning_score",
			pairs: buildPairs(10, (v) => Number(v) || 0),
			log,
		});
	}

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

	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported by tests.
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
