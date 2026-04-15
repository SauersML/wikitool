// QA Capability eval for the Wikipedia search tool
// Measures how much the tool improves the model's ability to answer hard questions.
// Grading uses Claude Sonnet via API with web search for verification.
// Usage: bun src/evals/qa_precise.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	extractJson,
	GRADER_MODEL,
	initEvalSession,
	pairedPermutationTest,
	parseResumeArg,
	reportStyleControlledHeadline,
	runAgent,
	runKey,
	runOrLogError,
	type StyleControlPair,
	safeGrade,
	stripCodeFences,
	WIKI_TOOL_NAME,
} from "./utils";

// --- Types ---

export interface Question {
	question: string;
	expected: string;
	domain: string;
}

export interface GradeResult {
	correct: boolean;
	quality: number;
}

// --- Constants ---

// Eval-specific task prompt (answer formatting only).
const TASK_PROMPT =
	"Provide a clear, well-reasoned answer. End with ANSWER: followed by your answer.";

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool: drop the wiki-centric SHARED_SYSTEM_PROMPT (nonsense without the
// tool) but keep TASK_PROMPT so answer-formatting still applies in both modes.
const NO_TOOL_SYSTEM_PROMPT: string | undefined = TASK_PROMPT;

export const QUESTIONS: Question[] = [
	{
		question:
			"What specific enzyme catalyzes the rate-limiting step in the mevalonate pathway, and what is its EC number?",
		expected: "HMG-CoA reductase, EC 1.1.1.34",
		domain: "Biochemistry",
	},
	{
		question:
			"In the proof of Fermat's Last Theorem, what specific modularity lifting theorem did Wiles use, and what was the key innovation in his approach to the 3-5 switch?",
		expected:
			"Used Mazur's deformation theory; the 3-5 switch bypassed issues with the residual representation at 3 by using a congruence to move to representation at 5",
		domain: "Math",
	},
	{
		question:
			"What is the exact critical temperature of the superconducting transition in MgB2, and what makes its superconductivity unusual?",
		expected:
			"39 K; it has two superconducting gaps on different Fermi surface sheets (sigma and pi bands)",
		domain: "Physics",
	},
	{
		question:
			"In the Turing machine proof of the undecidability of the halting problem, what is the specific diagonalization construction used?",
		expected:
			"Construct machine D that takes input M: runs H(M,M), if H says halt then D loops, if H says loop then D halts — D(D) creates contradiction",
		domain: "CS",
	},
	{
		question:
			"What are the specific crystal field splitting energies (in terms of Dq) for an octahedral versus tetrahedral coordination, and why is the tetrahedral splitting smaller?",
		expected:
			"Octahedral: 10Dq; Tetrahedral: 4/9 × 10Dq = 4.44Dq; smaller because fewer ligands (4 vs 6) and none point directly at d orbitals",
		domain: "Chemistry",
	},
	{
		question:
			"What was the exact sequence of events in the Dogger Bank incident of 1904, and what were the diplomatic consequences?",
		expected:
			"Russian Baltic Fleet fired on British fishing trawlers mistaking them for Japanese torpedo boats; nearly caused war between Russia and Britain; resolved by international commission",
		domain: "History",
	},
	{
		question:
			"What is the precise mechanism of action of the CRISPR-Cas9 system, including the role of the tracrRNA?",
		expected:
			"tracrRNA hybridizes with pre-crRNA for processing by RNase III; mature dual-RNA guides Cas9 to target via PAM recognition and R-loop formation; Cas9 uses RuvC and HNH domains for double-strand break",
		domain: "Biology",
	},
	{
		question:
			"In abstract algebra, what is the precise statement of the Artin-Wedderburn theorem, and what does it classify?",
		expected:
			"Every semisimple ring is isomorphic to a product of matrix rings over division rings; classifies semisimple Artinian rings",
		domain: "Math",
	},
	{
		question:
			"What are the specific conditions required for Grover's algorithm to achieve quadratic speedup, and what is the exact number of iterations needed?",
		expected:
			"Requires unstructured search; needs approximately π/4 × √N iterations for N items; requires uniform superposition initialization and an oracle",
		domain: "CS",
	},
	{
		question: "What is the Scoville rating of the Carolina Reaper pepper and who developed it?",
		expected:
			"Average 1,641,183 SHU (peak over 2.2 million); developed by Ed Currie of PuckerButt Pepper Company",
		domain: "Food Science",
	},
];

// --- Grading ---

function normalizeResponseForGrading(raw: string): {
	committed: string | null;
	full: string;
	isEmpty: boolean;
} {
	const full = stripCodeFences(raw ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const committed = extractFinalAnswer(raw ?? "");
	return { committed, full, isEmpty: full.length === 0 };
}

function buildGradePrompt(question: string, expected: string, answer: string): string {
	const { committed, full, isEmpty } = normalizeResponseForGrading(answer);
	const committedBlock = committed
		? `Model committed answer (extracted from ANSWER: line): ${committed}\n\n`
		: "";
	const responseBlock = isEmpty
		? "Model response: [empty / no answer provided]"
		: `Model full response: ${full}`;

	return `You are an expert evaluator with web search. Grade a model's answer to a technical question for factual correctness.

Use web search to verify the key technical claims. Do not rely solely on training data. The reference answer is a rubric of the key facts that must be present — it is NOT the only acceptable wording. An answer may use synonyms, different units, or additional correct detail and still be fully correct.

Judging rules:
- CORRECT = true iff the response conveys all key facts from the reference (or an equivalent set verified by search). Extra correct detail is fine. Minor wording/formatting differences are fine. A response that is mostly right but misses a key fact or contradicts a verified fact is CORRECT = false.
- A response that refuses, is empty, only describes the question, or never commits to an answer is CORRECT = false with QUALITY = 1.
- Ignore chain-of-thought that mentions the right fact in passing but then commits to a wrong final answer — grade on what the model actually concludes.
- QUALITY scale (integer 1-5): 1=wrong/refusal, 2=major gaps, 3=mostly correct, 4=correct and clear, 5=correct with well-sourced extra detail.

Question: ${question}
Reference answer (rubric): ${expected}
${committedBlock}${responseBlock}

After verifying via search, output a single JSON object on the final line in a \`\`\`json fenced block. Example:
\`\`\`json
{"correct": true, "quality": 4}
\`\`\`
Use only the keys "correct" (boolean) and "quality" (integer 1-5).`;
}

function coerceBool(v: unknown): boolean | null {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "yes" || s === "y" || s === "1" || s === "correct") return true;
		if (s === "false" || s === "no" || s === "n" || s === "0" || s === "incorrect") return false;
	}
	return null;
}

function coerceQuality(v: unknown): number | null {
	let n: number | null = null;
	if (typeof v === "number" && Number.isFinite(v)) n = v;
	else if (typeof v === "string") {
		const parsed = Number.parseFloat(v.trim());
		if (Number.isFinite(parsed)) n = parsed;
	}
	if (n === null) return null;
	const rounded = Math.round(n);
	return Math.max(1, Math.min(5, rounded));
}

export function parseGradeResponse(raw: string): GradeResult {
	// Try whole-string JSON first — covers the strict "only JSON" response
	// shape that the unit tests exercise.
	try {
		const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
		const correct = coerceBool(parsed["correct"]);
		const quality = coerceQuality(parsed["quality"]);
		if (typeof parsed["correct"] === "boolean" && typeof parsed["quality"] === "number") {
			const q = parsed["quality"];
			if (!(Number.isFinite(q) && q >= 1 && q <= 5)) {
				throw new Error(`Grade quality out of range (expected integer 1-5): ${q}`);
			}
			return { correct: parsed["correct"], quality: q };
		}
		if (correct !== null && quality !== null) return { correct, quality };
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Grade quality out of range")) throw err;
		// fall through
	}

	const parsed = extractJson(raw);
	if (parsed) {
		// Preserve strict-typed path for the existing unit tests.
		if (typeof parsed["correct"] === "boolean" && typeof parsed["quality"] === "number") {
			const q = parsed["quality"];
			if (!(Number.isFinite(q) && q >= 1 && q <= 5)) {
				throw new Error(`Grade quality out of range (expected integer 1-5): ${q}`);
			}
			return { correct: parsed["correct"], quality: q };
		}
		const correct = coerceBool(parsed["correct"]);
		const quality = coerceQuality(parsed["quality"]);
		if (correct !== null && quality !== null) return { correct, quality };
	}

	throw new Error(`Failed to parse grade response: ${raw.slice(0, 200)}`);
}

// Cheap shortcut: an empty / trivially-short / explicit-refusal answer is
// always wrong. Skip the web-search grader (which would otherwise waste
// tokens and occasionally hallucinate a "correct" verdict from rubric leakage).
const REFUSAL_PATTERNS = [
	"i cannot",
	"i can't",
	"i am unable",
	"i'm unable",
	"i do not have",
	"i don't have",
	"cannot answer",
	"can't answer",
	"no answer",
];

export function shortCircuitGrade(answer: string): GradeResult | null {
	const s = (answer ?? "").trim();
	if (s.length === 0) return { correct: false, quality: 1 };
	const lower = s.toLowerCase();
	if (s.length < 20 && REFUSAL_PATTERNS.some((p) => lower.includes(p))) {
		return { correct: false, quality: 1 };
	}
	return null;
}

// --- Grading via Sonnet API + web search ---

async function gradeWithSonnet(prompt: string): Promise<string> {
	const result = await runAgent({
		system:
			"You are an expert evaluator. Use web search and/or the Wikipedia tool to verify facts before grading.",
		prompt,
		builtinTools: ["WebSearch"],
		mcpServers: { wiki: createWikiMcpServer() },
		allowedTools: ["WebSearch", WIKI_TOOL_NAME],
		model: GRADER_MODEL,
		maxTurns: 10,
	});
	return result.answer.trim();
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
			i++;
			continue;
		}
		positional.push(a);
	}
	const singleIndex = positional[0] !== undefined ? Number.parseInt(positional[0], 10) : undefined;
	const questionsToRun = singleIndex !== undefined ? [QUESTIONS[singleIndex]!] : QUESTIONS;
	const startIndex = singleIndex ?? 0;

	if (singleIndex !== undefined && !QUESTIONS[singleIndex]) {
		console.error(`Invalid question index: ${singleIndex}. Must be 0-${QUESTIONS.length - 1}.`);
		process.exit(1);
	}

	console.log("QA Capability Eval");
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log("");

	const headers = [
		"question",
		"domain",
		"mode",
		"used_tool",
		"tool_queries",
		"model_answer",
		"correct",
		"quality_score",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "qa_precise",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "qa_precise",
		model: DEFAULT_MODEL,
		grader: GRADER_MODEL,
		n_questions: questionsToRun.length,
		modes: ["with_tool", "without_tool"],
		single_index: singleIndex ?? null,
		resumed_from: resume ?? null,
	});
	const rows: string[][] = [...resumedRows];
	const withToolResults: { correct: boolean; quality: number }[] = [];
	const withoutToolResults: { correct: boolean; quality: number }[] = [];

	// Rehydrate score arrays from resumed rows so the summary reflects prior work.
	for (const r of resumedRows) {
		const mode = r[2];
		const correct = r[6] === "true";
		const quality = Number(r[7]);
		if (mode === "with_tool") withToolResults.push({ correct, quality });
		else if (mode === "without_tool") withoutToolResults.push({ correct, quality });
	}

	for (let i = 0; i < questionsToRun.length; i++) {
		const q = questionsToRun[i]!;
		const qIndex = startIndex + i;
		console.log(`[${qIndex}] ${q.domain}: ${q.question.slice(0, 70)}...`);

		// --- With tool ---
		if (completed.has(runKey(qIndex, "with_tool"))) {
			console.log("  WITH tool: (already done — skipping)");
		} else {
			const row = await runOrLogError(
				log,
				{ index: qIndex, mode: "with_tool", logPath },
				async () => {
					console.log("  Running WITH tool...");
					const wikiServer = createWikiMcpServer({ seen: createSeenContent() });
					const withTool = await runAgent({
						system: SYSTEM_PROMPT,
						prompt: q.question,
						mcpServers: { wiki: wikiServer },
						allowedTools: [WIKI_TOOL_NAME],
					});

					const toolQueries = withTool.toolCalls
						.map((tc) => (tc.input["query"] as string) ?? "")
						.join("; ");

					const withShort = shortCircuitGrade(withTool.answer);
					const withGradeRaw = withShort
						? JSON.stringify(withShort)
						: await gradeWithSonnet(buildGradePrompt(q.question, q.expected, withTool.answer));
					const withGrade = await safeGrade({
						fn: async () => parseGradeResponse(withGradeRaw),
						fallback: { correct: false, quality: 0 },
						log,
						context: {
							eval: "qa_precise",
							index: qIndex,
							mode: "with_tool",
							grader: "parseGradeResponse",
						},
					});
					withToolResults.push(withGrade);

					console.log(
						`  WITH tool:    correct=${withGrade.correct} quality=${withGrade.quality} turns=${withTool.turns} tool_used=${withTool.usedTool}`,
					);

					const r: string[] = [
						q.question.slice(0, 80),
						q.domain,
						"with_tool",
						String(withTool.usedTool),
						toolQueries,
						withTool.answer.slice(0, 200),
						String(withGrade.correct),
						String(withGrade.quality),
						String(withTool.turns),
						String(withTool.inputTokens),
						String(withTool.outputTokens),
					];
					await log(
						buildRunLogEntry({
							index: qIndex,
							mode: "with_tool",
							question: q.question,
							expected: q.expected,
							agentResult: withTool,
							verdict: {
								correct: withGrade.correct,
								quality: withGrade.quality,
								grade_raw: withGradeRaw,
							},
							extra: { domain: q.domain },
							tsvRow: r,
						}),
					);
					await appendRow(r);
					return r;
				},
			);
			rows.push(row);
		}

		// --- Without tool ---
		if (completed.has(runKey(qIndex, "without_tool"))) {
			console.log("  WITHOUT tool: (already done — skipping)");
		} else {
			const row = await runOrLogError(
				log,
				{ index: qIndex, mode: "without_tool", logPath },
				async () => {
					console.log("  Running WITHOUT tool...");
					const withoutTool = await runAgent({
						system: NO_TOOL_SYSTEM_PROMPT,
						prompt: q.question,
					});

					const withoutShort = shortCircuitGrade(withoutTool.answer);
					const withoutGradeRaw = withoutShort
						? JSON.stringify(withoutShort)
						: await gradeWithSonnet(buildGradePrompt(q.question, q.expected, withoutTool.answer));
					const withoutGrade = await safeGrade({
						fn: async () => parseGradeResponse(withoutGradeRaw),
						fallback: { correct: false, quality: 0 },
						log,
						context: {
							eval: "qa_precise",
							index: qIndex,
							mode: "without_tool",
							grader: "parseGradeResponse",
						},
					});
					withoutToolResults.push(withoutGrade);

					console.log(
						`  WITHOUT tool:  correct=${withoutGrade.correct} quality=${withoutGrade.quality} turns=${withoutTool.turns}`,
					);
					console.log("");

					const r: string[] = [
						q.question.slice(0, 80),
						q.domain,
						"without_tool",
						"false",
						"",
						withoutTool.answer.slice(0, 200),
						String(withoutGrade.correct),
						String(withoutGrade.quality),
						String(withoutTool.turns),
						String(withoutTool.inputTokens),
						String(withoutTool.outputTokens),
					];
					await log(
						buildRunLogEntry({
							index: qIndex,
							mode: "without_tool",
							question: q.question,
							expected: q.expected,
							agentResult: withoutTool,
							verdict: {
								correct: withoutGrade.correct,
								quality: withoutGrade.quality,
								grade_raw: withoutGradeRaw,
							},
							extra: { domain: q.domain },
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

	const totalInputTokens = rows.reduce((s, r) => s + Number(r[9]), 0);
	const totalOutputTokens = rows.reduce((s, r) => s + Number(r[10]), 0);

	// --- Summary ---
	const withCorrectPct =
		(withToolResults.filter((r) => r.correct).length / withToolResults.length) * 100;
	const withoutCorrectPct =
		(withoutToolResults.filter((r) => r.correct).length / withoutToolResults.length) * 100;
	const withMeanQuality =
		withToolResults.reduce((sum, r) => sum + r.quality, 0) / withToolResults.length;
	const withoutMeanQuality =
		withoutToolResults.reduce((sum, r) => sum + r.quality, 0) / withoutToolResults.length;

	console.log("=".repeat(50));
	console.log("SUMMARY");
	console.log("=".repeat(50));
	console.log(
		`  With tool:    ${withCorrectPct.toFixed(0)}% correct, mean quality ${withMeanQuality.toFixed(2)}`,
	);
	console.log(
		`  Without tool: ${withoutCorrectPct.toFixed(0)}% correct, mean quality ${withoutMeanQuality.toFixed(2)}`,
	);
	console.log(`  Total tokens: ${totalInputTokens} input, ${totalOutputTokens} output`);

	const permCorrect = pairedPermutationTest(
		withToolResults.map((r) => (r.correct ? 1 : 0)),
		withoutToolResults.map((r) => (r.correct ? 1 : 0)),
	);
	const permQuality = pairedPermutationTest(
		withToolResults.map((r) => r.quality),
		withoutToolResults.map((r) => r.quality),
	);
	console.log(
		`  Permutation test (correct): diff=${permCorrect.diff.toFixed(3)}, p=${permCorrect.p.toFixed(4)}`,
	);
	console.log(
		`  Permutation test (quality): diff=${permQuality.diff.toFixed(3)}, p=${permQuality.p.toFixed(4)}`,
	);

	// Style-controlled headlines (cols: 0=question, 5=model_answer, 6=correct, 7=quality_score).
	{
		const wRows = rows.filter((r) => r[2] === "with_tool");
		const nRows = rows.filter((r) => r[2] === "without_tool");
		const buildPairs = (scoreCol: number, toNumber: (v: string) => number): StyleControlPair[] => {
			const out: StyleControlPair[] = [];
			for (const wt of wRows) {
				const wo = nRows.find((r) => r[0] === wt[0]);
				if (!wo) continue;
				out.push({
					withScore: toNumber(wt[scoreCol] ?? ""),
					noScore: toNumber(wo[scoreCol] ?? ""),
					withText: wt[5] ?? "",
					noText: wo[5] ?? "",
				});
			}
			return out;
		};
		await reportStyleControlledHeadline({
			label: "qa_precise: correct",
			pairs: buildPairs(6, (v) => (v === "true" ? 1 : 0)),
			log,
		});
		await reportStyleControlledHeadline({
			label: "qa_precise: quality_score",
			pairs: buildPairs(7, (v) => Number(v) || 0),
			log,
		});
	}

	await log({
		event: "summary",
		eval: "qa_precise",
		with_tool: {
			correct: withToolResults.filter((r) => r.correct).length,
			mean_quality: withMeanQuality,
			total: withToolResults.length,
		},
		without_tool: {
			correct: withoutToolResults.filter((r) => r.correct).length,
			mean_quality: withoutMeanQuality,
			total: withoutToolResults.length,
		},
		total_tokens: { input: totalInputTokens, output: totalOutputTokens },
		permutation_correct: permCorrect,
		permutation_quality: permQuality,
	});

	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported
const isMainModule =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("qa_precise.ts");

if (isMainModule && !process.env["BUN_TEST"]) {
	main();
}
