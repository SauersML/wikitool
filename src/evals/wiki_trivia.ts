// Wiki Trivia eval
// Tests the Wikipedia search tool using questions from the HuggingFace
// dataset willcb/wiki-trivia-questions. A representative subset of ~25
// questions spanning diverse topics and difficulty levels.
// Usage: bun src/evals/wiki_trivia.ts [questionIndex]

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
	"You are a helpful trivia assistant. Answer the question as concisely and accurately as possible. If you have access to a search tool, use it when you are not confident. If you don't know the answer, say \"I don't know\" rather than guessing.";

// --- Questions ---
// Curated from willcb/wiki-trivia-questions (2261 total rows).
// Selected to cover: history, science, geography, entertainment, sports,
// literature, music, technology, and culture — mixing easy, medium, and hard.

export const QUESTIONS: TriviaQuestion[] = [
	// --- Easy (model likely knows without tool) ---
	{
		question: "Which network broadcasts the show Bob's Burgers?",
		answer: "Fox Broadcasting Company",
		acceptableAnswers: ["Fox", "Fox Broadcasting", "Fox Broadcasting Company"],
		topic: "Television",
		datasetIndex: 5,
	},
	{
		question:
			"Which actor voiced the character Rooster, the Welsh Sheepdog, in The Secret Life of Pets 2?",
		answer: "Harrison Ford",
		acceptableAnswers: ["Harrison Ford"],
		topic: "Film",
		datasetIndex: 14,
	},
	{
		question: "Who directed the 1997 science fiction film The Fifth Element?",
		answer: "Luc Besson",
		acceptableAnswers: ["Luc Besson", "Besson"],
		topic: "Film",
		datasetIndex: 83,
	},
	{
		question: "Which rapper made his film debut starring as Jimmy Smith Jr. in 8 Mile?",
		answer: "Eminem",
		acceptableAnswers: ["Eminem", "Marshall Mathers", "Slim Shady"],
		topic: "Music/Film",
		datasetIndex: 531,
	},
	{
		question: "Who was the 15th President of the United States?",
		answer: "James Buchanan",
		acceptableAnswers: ["James Buchanan", "Buchanan"],
		topic: "History",
		datasetIndex: 1024,
	},

	// --- Medium (model may or may not know) ---
	{
		question: "Who were the two architects responsible for the design of the Parthenon?",
		answer: "Iktinos and Callicrates",
		acceptableAnswers: ["Iktinos", "Callicrates", "Ictinus", "Kallikrates"],
		topic: "Architecture",
		datasetIndex: 24,
	},
	{
		question:
			"Which Russian composer was a member of the group known as The Five and is famous for the orchestral suite Scheherazade?",
		answer: "Nikolai Rimsky-Korsakov",
		acceptableAnswers: ["Rimsky-Korsakov", "Nikolai Rimsky-Korsakov"],
		topic: "Music",
		datasetIndex: 42,
	},
	{
		question:
			"Which treaty in 1689 was the first formal agreement between China and a European power?",
		answer: "Treaty of Nerchinsk",
		acceptableAnswers: ["Treaty of Nerchinsk", "Nerchinsk"],
		topic: "History",
		datasetIndex: 507,
	},
	{
		question:
			"Which explorer's expedition first fully explored the Atlantic coast of Patagonia in 1520?",
		answer: "Ferdinand Magellan",
		acceptableAnswers: ["Ferdinand Magellan", "Magellan", "Fernão de Magalhães"],
		topic: "Exploration",
		datasetIndex: 542,
	},
	{
		question: "In what year did construction of the Parthenon begin?",
		answer: "447 BC",
		acceptableAnswers: ["447", "447 BC", "447 BCE"],
		topic: "History",
		datasetIndex: 2021,
	},
	{
		question: "Which Cambodian king coined the term 'Khmer Rouge' in the 1960s?",
		answer: "Norodom Sihanouk",
		acceptableAnswers: ["Norodom Sihanouk", "Sihanouk"],
		topic: "History",
		datasetIndex: 65,
	},
	{
		question: "Which astronomer first formally described the Andromeda Galaxy around the year 964?",
		answer: "al-Rahman al-Sufi",
		acceptableAnswers: [
			"al-Sufi",
			"Abd al-Rahman al-Sufi",
			"al-Rahman al-Sufi",
			"Al Sufi",
			"Abd al-Rahman",
		],
		topic: "Astronomy",
		datasetIndex: 520,
	},
	{
		question: "What is the state sports car of Kentucky?",
		answer: "Chevrolet Corvette",
		acceptableAnswers: ["Chevrolet Corvette", "Corvette"],
		topic: "Culture",
		datasetIndex: 530,
	},

	// --- Hard (model probably needs tool) ---
	{
		question: "What is the meaning of the term 'Utsuro-bune' in Japanese?",
		answer: "Hollow ship",
		acceptableAnswers: ["Hollow ship", "hollow boat"],
		topic: "Japanese folklore",
		datasetIndex: 0,
	},
	{
		question: "Which two brothers are credited with the isolation of tungsten as a metal in 1783?",
		answer: "Juan José and Fausto Elhuyar",
		acceptableAnswers: ["Elhuyar", "Juan José", "Fausto Elhuyar", "d'Elhuyar"],
		topic: "Chemistry",
		datasetIndex: 6,
	},
	{
		question: "What does the name 'Aldi' stand for in German?",
		answer: "Albrecht Discount",
		acceptableAnswers: ["Albrecht Discount"],
		topic: "Business",
		datasetIndex: 43,
	},
	{
		question: "What is the Hexagrammum Mysticum an example of in Blaise Pascal's 1639 work?",
		answer: "Hexagrammum Mysticum",
		acceptableAnswers: [
			"Hexagrammum Mysticum",
			"hexagrammum mysticum",
			"mystic hexagram",
			"Pascal's theorem",
		],
		topic: "Mathematics",
		datasetIndex: 48,
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
		question:
			"Which historian and ethnologist conducted investigations of the Utsuro-bune story in 1925?",
		answer: "Yanagita Kunio",
		acceptableAnswers: ["Yanagita Kunio", "Yanagita", "Kunio Yanagita"],
		topic: "Japanese History",
		datasetIndex: 1050,
	},
	{
		question:
			"What is the name of the radioactive green glass formed from the desert sand melted by the Trinity nuclear test?",
		answer: "Trinitite",
		acceptableAnswers: ["Trinitite"],
		topic: "Science",
		datasetIndex: 2052,
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
			"What was the codename used for the PlayStation Vita before its official announcement?",
		answer: "Next Generation Portable",
		acceptableAnswers: ["Next Generation Portable", "NGP"],
		topic: "Technology",
		datasetIndex: 44,
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
			"Which scientist experimentally verified Einstein's explanation of Brownian motion in 1908?",
		answer: "Jean Baptiste Perrin",
		acceptableAnswers: ["Jean Baptiste Perrin", "Perrin", "Jean Perrin"],
		topic: "Physics",
		datasetIndex: 2029,
	},
	{
		question:
			"What was the name of the yacht that Fidel Castro and his followers used to invade Cuba in 1956?",
		answer: "Granma",
		acceptableAnswers: ["Granma"],
		topic: "History",
		datasetIndex: 1502,
	},
];

// --- Judging ---

export function judge(question: TriviaQuestion, response: string): boolean {
	return matchesAny(response, question.acceptableAnswers);
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
