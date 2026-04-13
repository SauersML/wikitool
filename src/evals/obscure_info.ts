// Obscure Information Retrieval eval
// Tests whether the Wikipedia search tool helps the model answer questions it
// likely cannot answer from parametric knowledge alone.
// Usage: bun src/evals/obscure_info.ts [questionIndex]

import {
	DEFAULT_MODEL,
	defaultToolHandler,
	initLog,
	matchesAny,
	runAgentLoop,
	WIKI_TOOL,
	writeTsvResults,
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

export const SYSTEM_PROMPT =
	"You are a helpful assistant. Answer the question as precisely as possible. If you have access to a search tool, use it. If you don't know the answer, say \"I don't know\" rather than guessing. " +
	"End with ANSWER: followed by your precise answer.";

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
		expectedAnswer: "Vincenzo Scamozzi",
		judgeType: "string",
		acceptableAnswers: ["Vincenzo Scamozzi", "Scamozzi"],
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

export function extractNumbers(text: string): number[] {
	const matches = text.match(/[\d,]+\.?\d*/g);
	if (!matches) return [];
	return matches.map((m) => Number.parseFloat(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
}

export function judgeNumeric(response: string, expected: number, tolerancePct: number): boolean {
	const numbers = extractNumbers(response);
	const tolerance = expected * (tolerancePct / 100);
	return numbers.some((n) => Math.abs(n - expected) <= tolerance);
}

export function judge(question: ObscureQuestion, response: string): boolean {
	if (question.judgeType === "numeric") {
		return judgeNumeric(response, question.numericValue, question.tolerancePct);
	}
	return matchesAny(response, question.acceptableAnswers);
}

// --- Main ---

async function runQuestion(
	q: ObscureQuestion,
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
		question: q.question,
		expectedAnswer: q.expectedAnswer,
		judgeType: q.judgeType,
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

	const { log, path: logPath } = await initLog("obscure_info");

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

	const rows: string[][] = [];

	for (const { q, i } of questionsToRun) {
		for (const mode of ["with-tool", "without-tool"] as const) {
			const result = await runQuestion(q, i, mode, log);
			rows.push([
				result.question,
				result.expectedAnswer,
				result.judgeType,
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

	const tsvPath = await writeTsvResults("obscure_info", headers, rows);
	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

main();
