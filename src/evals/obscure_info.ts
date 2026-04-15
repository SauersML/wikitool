// Obscure Information Retrieval eval
// Tests whether the Wikipedia search tool helps the model answer questions it
// likely cannot answer from parametric knowledge alone.
// Usage: bun src/evals/obscure_info.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	extractNumbers,
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

interface NumericQuestion {
	question: string;
	expectedAnswer: string;
	judgeType: "numeric";
	numericValue: number;
	tolerancePct: number;
}

interface StringQuestion {
	question: string;
	expectedAnswer: string;
	judgeType: "string";
	acceptableAnswers: string[];
}

export type ObscureQuestion = NumericQuestion | StringQuestion;

// --- System prompt ---

// Answer-format + refusal instructions appended to both modes.
const TASK_PROMPT =
	"Answer the question as precisely as possible. If you don't know the answer, say \"I don't know\" rather than guessing. End with ANSWER: followed by your precise answer.";

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool mode omits the wiki-centric shared sysprompt but keeps TASK_PROMPT so
// the judge can still extract "ANSWER: …".
const NO_TOOL_SYSTEM_PROMPT: string | undefined = TASK_PROMPT;

// --- Questions ---

export const QUESTIONS: ObscureQuestion[] = [
	{
		question: "What was the population of Oymyakon, Russia according to the 2010 Russian census?",
		expectedAnswer: "462",
		judgeType: "numeric",
		numericValue: 462,
		tolerancePct: 3,
	},
	{
		question:
			"What is the total area of the municipality of Castellfollit de la Roca in Catalonia, Spain, in square kilometers?",
		expectedAnswer: "0.7",
		judgeType: "numeric",
		numericValue: 0.7,
		tolerancePct: 3,
	},
	{
		question:
			"Who led the construction of the hand-carved Guoliang Tunnel through the Taihang Mountains in Henan, China?",
		expectedAnswer: "Shen Mingxin",
		judgeType: "string",
		acceptableAnswers: ["Shen Mingxin"],
	},
	{
		question:
			"What is the maximum depth below sea level, in meters, of the Eiksund Tunnel in Møre og Romsdal county, Norway?",
		expectedAnswer: "287",
		judgeType: "numeric",
		numericValue: 287,
		tolerancePct: 2,
	},
	{
		question:
			"What was the population of Kangiqsualujjuaq, an Inuit village in Nunavik, Quebec, according to the 2021 Canadian census?",
		expectedAnswer: "956",
		judgeType: "numeric",
		numericValue: 956,
		tolerancePct: 2,
	},
	{
		question:
			"Who designed the Geierlay suspension bridge in the Hunsrück region of western Germany?",
		expectedAnswer: "Hans Pfaffen",
		judgeType: "string",
		acceptableAnswers: ["Hans Pfaffen", "Pfaffen"],
	},
	{
		question:
			"What is the elevation of the highest point (Otonbu) on Aogashima island, Japan, in meters?",
		expectedAnswer: "423",
		judgeType: "numeric",
		numericValue: 423,
		tolerancePct: 2,
	},
	{
		question:
			"Who was the railroad worker who discovered a diamond at Kolmanskop in 1908, leading to the founding of the mining town in German South-West Africa?",
		expectedAnswer: "Zacharias Lewala",
		judgeType: "string",
		acceptableAnswers: ["Zacharias Lewala", "Lewala"],
	},
	{
		question:
			"What is the depth from the shaft mouth to the base of the Salina Turda salt mine in Romania, in meters?",
		expectedAnswer: "112",
		judgeType: "numeric",
		numericValue: 112,
		tolerancePct: 2,
	},
	{
		question:
			"What is the total length of the Highline179 pedestrian suspension bridge near Reutte, Austria, in meters?",
		expectedAnswer: "406",
		judgeType: "numeric",
		numericValue: 406,
		tolerancePct: 2,
	},
	{
		question:
			"Who founded the Etar Architectural-Ethnographic Complex, an open-air museum near Gabrovo in Bulgaria?",
		expectedAnswer: "Lazar Donkov",
		judgeType: "string",
		acceptableAnswers: ["Lazar Donkov", "Donkov"],
	},
	{
		question:
			"What is the elevation of Civita di Bagnoregio, the 'dying city' in the Province of Viterbo, Italy, in meters?",
		expectedAnswer: "443",
		judgeType: "numeric",
		numericValue: 443,
		tolerancePct: 2,
	},
	{
		question:
			"Who was the architect who designed Palmanova, the star-shaped fortress city in Friuli-Venezia Giulia, Italy, built in 1593?",
		expectedAnswer: "Vincenzo Scamozzi or Giulio Savorgnan",
		judgeType: "string",
		acceptableAnswers: [
			"Vincenzo Scamozzi",
			"Scamozzi",
			"Giulio Savorgnan",
			"Julius Savorgnan",
			"Savorgnan",
		],
	},
	{
		question: "What is the height of the Chamarel Waterfall in Mauritius, in meters?",
		expectedAnswer: "95",
		judgeType: "numeric",
		numericValue: 95,
		tolerancePct: 3,
	},
	{
		question:
			"Who was the British civil engineer who designed the Maunsell Forts used for defence of the Thames and Mersey estuaries during World War II?",
		expectedAnswer: "Guy Maunsell",
		judgeType: "string",
		acceptableAnswers: ["Guy Maunsell", "Guy Anson Maunsell", "Maunsell"],
	},
	{
		question: "What is the length of the Vardø Tunnel, Norway's first subsea tunnel, in meters?",
		expectedAnswer: "2890",
		judgeType: "numeric",
		numericValue: 2890,
		tolerancePct: 2,
	},
	{
		question: "What is the area of Deception Island in Antarctica, in square kilometers?",
		expectedAnswer: "79",
		judgeType: "numeric",
		numericValue: 79,
		tolerancePct: 3,
	},
	{
		question:
			"What was the population of the village of Gásadalur on Vágar, Faroe Islands, according to the 2002 population data?",
		expectedAnswer: "16",
		judgeType: "numeric",
		numericValue: 16,
		tolerancePct: 3,
	},
	{
		question:
			"What is the length of the herring factory building at Djúpavík in the Westfjords of Iceland, in meters?",
		expectedAnswer: "90",
		judgeType: "numeric",
		numericValue: 90,
		tolerancePct: 3,
	},
	{
		question:
			"After which transport driver was Kolmanskop, the ghost town in Namibia, originally named?",
		expectedAnswer: "Johnny Coleman",
		judgeType: "string",
		acceptableAnswers: ["Johnny Coleman", "Coleman"],
	},
];

// --- Judging ---

// Non-commitment / refusal phrases. If the final-answer line is essentially one
// of these, the model did not commit to an answer and we must not match.
const REFUSAL_PATTERNS = [
	"i don't know",
	"i do not know",
	"i'm not sure",
	"i am not sure",
	"not sure",
	"unknown",
	"unable to determine",
	"cannot determine",
	"can't determine",
	"no information",
	"n/a",
	"unclear",
	"insufficient information",
];

function normalizeAnswer(text: string): string {
	// Strip code fences, markdown bold/italic/backticks, trailing punctuation,
	// and collapse whitespace. Unicode-normalize so curly quotes / NBSPs behave.
	let s = stripCodeFences(text).normalize("NFKC");
	s = s.replace(/\*+/g, "").replace(/`+/g, "").replace(/_+/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	// Strip a single pair of wrapping quotes.
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1).trim();
	}
	return s;
}

function isRefusal(text: string): boolean {
	const lower = text.toLowerCase().trim();
	if (!lower) return true;
	return REFUSAL_PATTERNS.some(
		(p) =>
			lower === p || lower.startsWith(`${p}.`) || lower.startsWith(`${p},`) || lower === `${p}.`,
	);
}

export function judgeNumeric(response: string, expected: number, tolerancePct: number): boolean {
	const numbers = extractNumbers(response);
	const tolerance = expected * (tolerancePct / 100);
	return numbers.some((n) => Math.abs(n - expected) <= tolerance);
}

export function judge(question: ObscureQuestion, response: string): boolean {
	// Strict policy: require an explicit final-answer line. Falling back to the
	// full response causes false positives — models routinely mention the
	// correct string mid-reasoning while ultimately refusing, and years / tool
	// artifacts in the transcript can land within numeric tolerance.
	const rawFinal = extractFinalAnswer(response);
	if (rawFinal === null) return false;

	const finalAnswer = normalizeAnswer(rawFinal);
	if (!finalAnswer || isRefusal(finalAnswer)) return false;

	if (question.judgeType === "numeric") {
		return judgeNumeric(finalAnswer, question.numericValue, question.tolerancePct);
	}
	return matchesAny(finalAnswer, question.acceptableAnswers);
}

// --- Main ---

async function runQuestion(
	q: ObscureQuestion,
	index: number,
	mode: "with-tool" | "without-tool",
	log: (entry: unknown) => Promise<void>,
	appendRow: (row: string[]) => Promise<void>,
): Promise<string[]> {
	console.log(`  [${index}] ${mode.padEnd(12)} "${q.question.slice(0, 60)}..."`);

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

	console.log(
		`           answer="${result.answer.slice(0, 80)}" correct=${isCorrect} tools=${result.toolCalls.length}`,
	);

	const row: string[] = [
		q.question,
		q.expectedAnswer,
		q.judgeType,
		mode,
		String(result.usedTool),
		toolQueries,
		result.answer,
		String(isCorrect),
		String(result.turns),
		String(result.inputTokens),
		String(result.outputTokens),
	];

	await log(
		buildRunLogEntry({
			index,
			mode,
			question: q.question,
			expected: q.expectedAnswer,
			agentResult: result,
			verdict: {
				correct: isCorrect,
				judge_type: q.judgeType,
				...(q.judgeType === "numeric"
					? { numeric_value: q.numericValue, tolerance_pct: q.tolerancePct }
					: { acceptable_answers: q.acceptableAnswers }),
			},
			tsvRow: row,
		}),
	);
	await appendRow(row);

	return row;
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

	console.log(`Obscure Information Retrieval Eval`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log(`Modes: with-tool, without-tool\n`);

	const headers = [
		"question",
		"expected_answer",
		"judge_type",
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
		evalName: "obscure_info",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "obscure_info",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["with-tool", "without-tool"],
		single_index: singleIndex ?? null,
		resumed_from: resume ?? null,
	});

	const rows: string[][] = [...resumedRows];

	for (const { q, i } of questionsToRun) {
		for (const mode of ["with-tool", "without-tool"] as const) {
			const key = runKey(i, mode);
			if (completed.has(key)) {
				console.log(`  [${i}] ${mode.padEnd(12)} (already done — skipping)`);
				continue;
			}
			const row = await runOrLogError(log, { index: i, mode, logPath }, () =>
				runQuestion(q, i, mode, log, appendRow),
			);
			rows.push(row);
		}
	}

	// --- Summary ---
	console.log(`\n${"─".repeat(60)}`);
	console.log("Summary\n");

	const withToolRows = rows.filter((r) => r[3] === "with-tool");
	const withoutToolRows = rows.filter((r) => r[3] === "without-tool");

	const correctWith = withToolRows.filter((r) => r[7] === "true").length;
	const correctWithout = withoutToolRows.filter((r) => r[7] === "true").length;

	console.log(
		`  With tool:    ${correctWith}/${withToolRows.length} correct (${((correctWith / withToolRows.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`  Without tool: ${correctWithout}/${withoutToolRows.length} correct (${((correctWithout / withoutToolRows.length) * 100).toFixed(1)}%)`,
	);

	const perm = pairedPermutationTest(
		withToolRows.map((r) => (r[7] === "true" ? 1 : 0)),
		withoutToolRows.map((r) => (r[7] === "true" ? 1 : 0)),
	);
	console.log(`  Permutation test: diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`);

	await log({
		event: "summary",
		eval: "obscure_info",
		with_tool: { correct: correctWith, total: withToolRows.length },
		without_tool: { correct: correctWithout, total: withoutToolRows.length },
		permutation: perm,
	});

	// Per-question table
	console.log(`\n  ${"Question".padEnd(65)} ${"With".padEnd(7)} Without`);
	console.log(`  ${"─".repeat(65)} ${"─".repeat(7)} ${"─".repeat(7)}`);
	for (const { q } of questionsToRun) {
		const wt = withToolRows.find((r) => r[0] === q.question);
		const wo = withoutToolRows.find((r) => r[0] === q.question);
		const short = q.question.slice(0, 63).padEnd(65);
		console.log(
			`  ${short} ${(wt?.[7] === "true" ? "Y" : "N").padEnd(7)} ${wo?.[7] === "true" ? "Y" : "N"}`,
		);
	}

	// Token totals
	const totalInput = rows.reduce((sum, r) => sum + Number(r[9]), 0);
	const totalOutput = rows.reduce((sum, r) => sum + Number(r[10]), 0);
	console.log(`\n  Total tokens: ${totalInput} input, ${totalOutput} output`);

	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported by tests.
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
