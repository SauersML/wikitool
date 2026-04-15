// Wiki Trivia eval
// Tests the Wikipedia search tool using questions from the HuggingFace
// dataset willcb/wiki-trivia-questions. A representative subset of ~25
// questions spanning diverse topics and difficulty levels.
// Usage: bun src/evals/wiki_trivia.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	extractJson,
	GRADER_MODEL,
	gradeWithModel,
	initEvalSession,
	matchesAny,
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

export interface TriviaQuestion {
	question: string;
	answer: string;
	acceptableAnswers: string[];
	topic: string;
	/** Index in the original HuggingFace dataset (willcb/wiki-trivia-questions) */
	datasetIndex: number;
}

// --- System prompt ---

// Eval-specific task prompt (answer formatting only).
const TASK_PROMPT = "End with ANSWER: followed by your answer.";

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool: drop the wiki-centric SHARED_SYSTEM_PROMPT (nonsense without the tool)
// but keep TASK_PROMPT so answer formatting still applies.
const NO_TOOL_SYSTEM_PROMPT = TASK_PROMPT;

// --- Questions ---
// Curated from willcb/wiki-trivia-questions (2261 total rows).
// Selected to cover: history, science, geography, entertainment, sports,
// literature, music, technology, and culture — mixing easy, medium, and hard.

export const QUESTIONS: TriviaQuestion[] = [
	{
		question:
			"What is the name of the problem that uses SVD to compute the optimal rotation aligning one set of points with another, often used in molecular structure comparison?",
		answer: "Kabsch algorithm / Orthogonal Procrustes problem",
		acceptableAnswers: [
			"Kabsch algorithm",
			"Kabsch",
			"Orthogonal Procrustes",
			"Procrustes problem",
			"Procrustes",
		],
		topic: "Computational Biology",
		datasetIndex: 522,
	},
	{
		question:
			"What was the original name of Adobe Premiere before being acquired and renamed by Adobe?",
		answer: "ReelTime",
		acceptableAnswers: ["ReelTime", "Reel Time"],
		topic: "Technology",
		datasetIndex: 550,
	},
	{
		question:
			"Which tunnel is the only land access to Whittier, Alaska, and is the longest combined rail and highway tunnel in North America?",
		answer: "Anton Anderson Memorial Tunnel",
		acceptableAnswers: ["Anton Anderson Memorial Tunnel", "Anton Anderson", "Whittier Tunnel"],
		topic: "Infrastructure",
		datasetIndex: 556,
	},
	{
		question:
			"Name the particle filtering method published in 1993 that applies Monte Carlo resampling algorithms in Bayesian statistical inference.",
		answer: "Bootstrap filter",
		acceptableAnswers: ["Bootstrap filter"],
		topic: "Statistics",
		datasetIndex: 590,
	},
	{
		question: "Which alien species takes over Earth in the film 'Landscape with Invisible Hand'?",
		answer: "Vuvv",
		acceptableAnswers: ["Vuvv"],
		topic: "Film",
		datasetIndex: 535,
	},
	{
		question:
			"Which culture is traditionally associated with the origin of the Celtic language in central Europe around 1200 BC?",
		answer: "Urnfield culture",
		acceptableAnswers: ["Urnfield culture", "Urnfield"],
		topic: "Archaeology",
		datasetIndex: 809,
	},
	{
		question:
			"Which English-born Australian serial killer was known as 'The Baby Farming Murderess' and executed in 1894?",
		answer: "Frances Knorr",
		acceptableAnswers: ["Frances Knorr", "Knorr"],
		topic: "Crime History",
		datasetIndex: 813,
	},
	{
		question:
			"Which nematode species is a simultaneous hermaphrodite that primarily reproduces by self-fertilization?",
		answer: "Caenorhabditis elegans",
		acceptableAnswers: ["Caenorhabditis elegans", "C. elegans"],
		topic: "Biology",
		datasetIndex: 817,
	},
	{
		question:
			"Which Indo-Greek king issued coinage around 180 BCE bearing images related to Vāsudeva-Krishna?",
		answer: "Agathocles",
		acceptableAnswers: ["Agathocles"],
		topic: "Ancient History",
		datasetIndex: 858,
	},
	{
		question:
			"What is the name of the magnesium alloy historically used by German military aircraft during World War II?",
		answer: "Elektron",
		acceptableAnswers: ["Elektron"],
		topic: "Materials Science",
		datasetIndex: 1568,
	},
	{
		question:
			"What is the name of the explosive reactive armour system used on the T-80U tank variant?",
		answer: "Kontakt-5",
		acceptableAnswers: ["Kontakt-5", "Kontakt 5"],
		topic: "Military Technology",
		datasetIndex: 1574,
	},
	{
		question:
			"Which GPS-guided extended range rocket was introduced in 2005 for the M270 MLRS system?",
		answer: "GMLRS",
		acceptableAnswers: ["GMLRS", "Guided MLRS"],
		topic: "Military Technology",
		datasetIndex: 1534,
	},
	{
		question:
			"Who was the leader of the Student Revolutionary Directorate that attempted the 1957 Presidential Palace attack in Cuba?",
		answer: "José Antonio Echeverría",
		acceptableAnswers: ["José Antonio Echeverría", "Echeverría", "Echeverria"],
		topic: "History",
		datasetIndex: 1537,
	},
	{
		question:
			"Which sculptor supervised the sculptural decoration of the Parthenon and created the statue of Athena Parthenos?",
		answer: "Phidias",
		acceptableAnswers: ["Phidias", "Pheidias"],
		topic: "Ancient Art",
		datasetIndex: 2037,
	},
	{
		question:
			"What is the name of the indigenous people believed to have been the Patagons described by Magellan's expedition?",
		answer: "Tehuelche",
		acceptableAnswers: ["Tehuelche"],
		topic: "Anthropology",
		datasetIndex: 1581,
	},
	{
		question:
			"What pigment is responsible for the white markings on the European garden spider Araneus diadematus?",
		answer: "Guanine",
		acceptableAnswers: ["Guanine"],
		topic: "Biology",
		datasetIndex: 1561,
	},
	{
		question: "Which river marks the division between the Northern and Southern Levant?",
		answer: "Litani River",
		acceptableAnswers: ["Litani River", "Litani"],
		topic: "Geography",
		datasetIndex: 1580,
	},
	{
		question:
			"What was the name of the gold coin introduced in 1663 that was initially worth 20 shillings?",
		answer: "Guinea",
		acceptableAnswers: ["Guinea"],
		topic: "Numismatics",
		datasetIndex: 1572,
	},
	{
		question:
			"Which Argentine serial killer was known as 'The Death Angel' and was still serving a life sentence as of 2023?",
		answer: "Robledo Puch",
		acceptableAnswers: ["Robledo Puch", "Carlos Robledo Puch"],
		topic: "Crime History",
		datasetIndex: 1010,
	},
	{
		question:
			"Which mathematician first introduced the idea of a worldwide system of time zones in 1858?",
		answer: "Quirico Filopanti",
		acceptableAnswers: ["Quirico Filopanti", "Filopanti", "Giuseppe Barilli"],
		topic: "Science/History",
		datasetIndex: 1520,
	},
	{
		question: "Which act formally dissolved the East India Company in 1874?",
		answer: "India Stock Dividend Redemption Act 1873",
		acceptableAnswers: [
			"India Stock Dividend Redemption Act",
			"East India Stock Dividend Redemption Act",
		],
		topic: "History",
		datasetIndex: 1006,
	},
	{
		question:
			"Which German general was appointed commander of the Berlin Defence Area on 23 April 1945?",
		answer: "Helmuth Weidling",
		acceptableAnswers: ["Helmuth Weidling", "Weidling"],
		topic: "Military History",
		datasetIndex: 514,
	},
	{
		question:
			"Which historian and ethnologist conducted investigations of the Utsuro-bune story in 1925?",
		answer: "Yanagita Kunio",
		acceptableAnswers: ["Yanagita Kunio", "Yanagita", "Kunio Yanagita"],
		topic: "Japanese History",
		datasetIndex: 1050,
	},
	{
		question: "What is the highest mountain on Okinawa Island?",
		answer: "Mount Yonaha",
		acceptableAnswers: ["Mount Yonaha", "Yonaha", "Yonaha-dake"],
		topic: "Geography",
		datasetIndex: 811,
	},
	{
		question: "Which process is primarily used in China to produce magnesium metal?",
		answer: "Pidgeon process",
		acceptableAnswers: ["Pidgeon process", "Pidgeon"],
		topic: "Chemistry",
		datasetIndex: 2090,
	},
];

// --- Judging ---

// Strip diacritics and normalize punctuation/whitespace so "Echeverría" matches
// "Echeverria", "Kontakt-5" matches "Kontakt 5", "C. elegans" matches "C elegans".
// Keeps ASCII letters/digits; everything else collapses to a single space.
function normalize(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function normalizedContains(haystack: string, needle: string): boolean {
	const h = ` ${normalize(haystack)} `;
	const n = normalize(needle);
	if (!n) return false;
	return h.includes(` ${n} `);
}

function matchesAnyNormalized(text: string, acceptableAnswers: string[]): boolean {
	return acceptableAnswers.some((a) => normalizedContains(text, a));
}

// Cheap refusal / non-commit detection — avoids paying for an LLM grader on
// clear "I don't know" responses.
function looksLikeRefusal(text: string): boolean {
	const t = text.trim().toLowerCase();
	if (t.length === 0) return true;
	const phrases = [
		"i don't know",
		"i do not know",
		"i'm not sure",
		"i am not sure",
		"cannot determine",
		"can't determine",
		"unable to determine",
		"unable to answer",
		"no information",
		"insufficient information",
	];
	return phrases.some((p) => t.includes(p));
}

function extractCandidate(response: string): string {
	const finalAnswer = extractFinalAnswer(response);
	const raw = finalAnswer ?? response;
	return stripCodeFences(raw);
}

function buildGradePrompt(
	question: string,
	canonicalAnswer: string,
	acceptableAnswers: string[],
	candidate: string,
	fullResponse: string,
): string {
	return `You are grading a single trivia question for factual correctness.

Question: ${question}
Canonical reference answer: ${canonicalAnswer}
Other acceptable phrasings: ${acceptableAnswers.join(" | ")}

The model's final answer (after "ANSWER:" if present):
<<<
${candidate}
>>>

The model's full response (for context only; do NOT credit mid-reasoning mentions that the model did not commit to):
<<<
${fullResponse}
>>>

Grade "correct" = true only if the model's committed final answer is factually the same entity as the reference (allowing for transliteration, diacritic, abbreviation, word-order, and naming-variant differences — e.g. "C. elegans" = "Caenorhabditis elegans"; "Pheidias" = "Phidias"; "Jose Echeverria" = "José Antonio Echeverría"). Mark false if the model refused, hedged without committing, named a different entity, or only mentioned the correct answer in passing while committing to a wrong one.

Respond ONLY with JSON: {"correct": true} or {"correct": false}.`;
}

function parseGradeJson(raw: string): boolean {
	const stripped = stripCodeFences(raw).trim();
	try {
		const parsed = JSON.parse(stripped) as { correct?: unknown };
		if (typeof parsed.correct === "boolean") return parsed.correct;
	} catch {
		// fall through to extractJson
	}
	const obj = extractJson(raw);
	if (obj && typeof obj.correct === "boolean") return obj.correct;
	throw new Error(`Failed to parse grade response: ${raw.slice(0, 200)}`);
}

export async function judge(
	question: TriviaQuestion,
	response: string,
	opts?: {
		log?: (entry: unknown) => Promise<void>;
		index?: number;
		mode?: string;
		/** Skip the LLM-grader fallback (used by unit tests to avoid network calls). */
		disableGrader?: boolean;
	},
): Promise<boolean> {
	const candidate = extractCandidate(response);
	const textToJudge = candidate || response;

	// Fast path: exact word-boundary substring against curated acceptable list.
	if (matchesAny(textToJudge, question.acceptableAnswers)) return true;
	// Normalized path: diacritic/punctuation-insensitive.
	if (matchesAnyNormalized(textToJudge, question.acceptableAnswers)) return true;

	// No commit → don't waste a grader call.
	if (looksLikeRefusal(candidate)) return false;

	if (opts?.disableGrader) return false;

	// LLM grader fallback: catches paraphrases/alias forms not enumerated in
	// acceptableAnswers. `safeGrade` converts grader failures into a `false`
	// so a malformed grader response can't inflate scores.
	return await safeGrade({
		fn: async () => {
			const prompt = buildGradePrompt(
				question.question,
				question.answer,
				question.acceptableAnswers,
				candidate,
				response,
			);
			const raw = await gradeWithModel(prompt, GRADER_MODEL);
			return parseGradeJson(raw);
		},
		fallback: false,
		log: opts?.log,
		context: {
			eval: "wiki_trivia",
			index: opts?.index ?? -1,
			mode: opts?.mode,
			grader: "wiki_trivia_llm",
		},
	});
}

// --- Main ---

async function runQuestion(
	q: TriviaQuestion,
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

	const isCorrect = await judge(q, result.answer, { log, index, mode });
	const toolQueries = result.toolCalls.map((tc) => tc.input["query"] ?? "").join("; ");

	console.log(
		`           answer="${result.answer.slice(0, 80)}" correct=${isCorrect} tools=${result.toolCalls.length}`,
	);

	const row: string[] = [
		q.question,
		q.answer,
		q.topic,
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
			expected: q.acceptableAnswers,
			agentResult: result,
			verdict: { correct: isCorrect, canonical_expected: q.answer, topic: q.topic },
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

	console.log(`Wiki Trivia Eval`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log(`Modes: with-tool, without-tool\n`);

	const headers = [
		"question",
		"expected_answer",
		"topic",
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
		evalName: "wiki_trivia",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "wiki_trivia",
		model: DEFAULT_MODEL,
		grader: GRADER_MODEL,
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

	// Style-controlled headline: the wiki sysprompt's anti-markdown clause is
	// only delivered to with-tool, so an LLM grader that prefers structured
	// prose can produce a spurious mode effect. Print residuals after
	// controlling for ΔHeaders/ΔBullets/ΔBold/ΔLength so the confound is
	// visible alongside the raw number. Cols: 0=question, 6=model_answer, 7=is_correct.
	{
		const stylePairs: StyleControlPair[] = [];
		for (const wt of withToolRows) {
			const wo = withoutToolRows.find((r) => r[0] === wt[0]);
			if (!wo) continue;
			stylePairs.push({
				withScore: wt[7] === "true" ? 1 : 0,
				noScore: wo[7] === "true" ? 1 : 0,
				withText: wt[6] ?? "",
				noText: wo[6] ?? "",
			});
		}
		await reportStyleControlledHeadline({
			label: "wiki_trivia: is_correct",
			pairs: stylePairs,
			log,
		});
	}

	await log({
		event: "summary",
		eval: "wiki_trivia",
		with_tool: { correct: correctWith, total: withToolRows.length },
		without_tool: { correct: correctWithout, total: withoutToolRows.length },
		permutation: perm,
	});

	// Per-question table
	console.log(`\n  ${"Question".padEnd(65)} ${"Topic".padEnd(18)} ${"With".padEnd(7)} Without`);
	console.log(`  ${"─".repeat(65)} ${"─".repeat(18)} ${"─".repeat(7)} ${"─".repeat(7)}`);
	for (const { q } of questionsToRun) {
		const wt = withToolRows.find((r) => r[0] === q.question);
		const wo = withoutToolRows.find((r) => r[0] === q.question);
		const short = q.question.slice(0, 63).padEnd(65);
		const topic = q.topic.slice(0, 16).padEnd(18);
		console.log(
			`  ${short} ${topic} ${(wt?.[7] === "true" ? "Y" : "N").padEnd(7)} ${wo?.[7] === "true" ? "Y" : "N"}`,
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
