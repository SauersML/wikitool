// Wiki Trivia eval
// Tests the Wikipedia search tool using questions from the HuggingFace
// dataset willcb/wiki-trivia-questions. A representative subset of ~25
// questions spanning diverse topics and difficulty levels.
// Usage: bun src/evals/wiki_trivia.ts [questionIndex]

import {
	DEFAULT_MODEL,
	extractFinalAnswer,
	initLog,
	matchesAny,
	runAgentLoop,
	WIKI_TOOL,
	writeTsvResults,
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

export const SYSTEM_PROMPT =
	"You are a helpful trivia assistant. Answer the question as concisely and accurately as possible. If you have access to a search tool, use it when you are not confident. If you don't know the answer, say \"I don't know\" rather than guessing. " +
	"End with ANSWER: followed by your answer.";

// --- Questions ---
// Curated from willcb/wiki-trivia-questions (2261 total rows).
// Selected to cover: history, science, geography, entertainment, sports,
// literature, music, technology, and culture — mixing easy, medium, and hard.

export const QUESTIONS: TriviaQuestion[] = [
	{
		question:
			"What is the name of the problem that uses SVD to compute the optimal rotation aligning one set of points with another, often used in molecular structure comparison?",
		answer: "Kabsch algorithm",
		acceptableAnswers: ["Kabsch algorithm", "Kabsch"],
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
		acceptableAnswers: ["Bootstrap filter", "bootstrap filter"],
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
		acceptableAnswers: ["Guanine", "guanine"],
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
		acceptableAnswers: ["Guinea", "guinea"],
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

export function judge(question: TriviaQuestion, response: string): boolean {
	// Try to extract a final answer line first to avoid matching incidental mentions
	const finalAnswer = extractFinalAnswer(response);
	const textToJudge = finalAnswer ?? response;

	return matchesAny(textToJudge, question.acceptableAnswers);
}

// --- Main ---

async function runQuestion(
	q: TriviaQuestion,
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

	console.log(
		`           answer="${result.answer.slice(0, 80)}" correct=${isCorrect} tools=${result.toolCalls.length}`,
	);

	return {
		question: q.question,
		expectedAnswer: q.answer,
		topic: q.topic,
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

	console.log(`Wiki Trivia Eval`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		`Questions: ${questionsToRun.length}${singleIndex !== undefined ? ` (index ${singleIndex})` : ""}`,
	);
	console.log(`Modes: with-tool, without-tool\n`);

	const { log, path: logPath } = await initLog("wiki_trivia");

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

	const rows: string[][] = [];

	for (const { q, i } of questionsToRun) {
		for (const mode of ["with-tool", "without-tool"] as const) {
			const result = await runQuestion(q, i, mode, log);
			rows.push([
				result.question,
				result.expectedAnswer,
				result.topic,
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

	const tsvPath = await writeTsvResults("wiki_trivia", headers, rows);
	console.log(`  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

main();
