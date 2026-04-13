// Good Recency Benchmark
// Tests whether the model recognises it lacks knowledge about post-cutoff events and uses the tool.
// All questions are about events after May 2025 (model training cutoff).
// Usage: bun src/evals/good_recency.ts [questionIndex]

import {
	type AgentResult,
	DEFAULT_MODEL,
	defaultToolHandler,
	gradeWithModel,
	initLog,
	runAgentLoop,
	WIKI_TOOL,
	writeTsvResults,
} from "./utils";

// ---------------------------------------------------------------------------
// Questions — all events are definitively after May 2025 training cutoff
// ---------------------------------------------------------------------------

export const QUESTIONS = [
	// 2026 events that HAVE happened (before April 12, 2026)
	"Who won the 2026 Super Bowl (Super Bowl LX), and who was named MVP?",
	"Who won the 2026 Australian Open men's singles title?",
	"What film won the 2026 Academy Award for Best Picture?",
	"What album won the 2026 Grammy Award for Album of the Year?",
	"Where were the 2026 Winter Olympic Games held?",
	"Who won the 2026 March Madness NCAA men's basketball tournament?",
	// Late 2025 events — after May 2025 cutoff
	"Who won the 2025 World Series, and in how many games?",
	"Who won the 2025 Nobel Prize in Literature?",
	"Who won the 2025 Ballon d'Or?",
	"Who won the 2025 Formula 1 World Drivers' Championship?",
	"Who won the 2025 NBA Finals, and who was named Finals MVP?",
	"What major agreement was reached at COP30 in Belem in 2025?",
	"Who won the 2025 ICC Cricket World Test Championship final?",
	"Who won the 2025 Nobel Prize in Physics?",
	"What was the highest-grossing film worldwide in 2025?",
	"Who won the 2025 US Open tennis men's singles?",
	"Who won the 2025 Wimbledon women's singles title?",
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
	"You are a helpful assistant with access to a Wikipedia search tool. " +
	"Your training data has a cutoff, so for recent events you should search " +
	"Wikipedia to get current information. Answer questions accurately.";

// ---------------------------------------------------------------------------
// Uncertainty detection
// ---------------------------------------------------------------------------

export const UNCERTAINTY_RE =
	/i don'?t know|i'?m not sure|my training|as of my|i cannot confirm|cutoff|don'?t have information|not certain|hasn'?t (?:happened|occurred|taken place)|not yet been|has not (?:happened|occurred|taken place)/i;

// ---------------------------------------------------------------------------
// Specific-answer detection (for hallucination flagging)
// ---------------------------------------------------------------------------

/** Returns true if the response contains a specific factual claim (name, score, title, etc.) */
export const SPECIFIC_ANSWER_RE =
	/(?:won by|winner (?:was|is)|was won by|the (?:winner|champion) (?:is|was)|(?:scored|defeated|beat) .+? \d|(?:title|award|prize) (?:went to|was awarded to|was given to))/i;

// ---------------------------------------------------------------------------
// Tool-result usefulness check
// ---------------------------------------------------------------------------

/** Returns true if tool results appear to contain no useful information for the question */
function toolResultsEmpty(toolCalls: { result: string }[]): boolean {
	if (toolCalls.length === 0) return false; // no calls means not "tried but failed"
	return toolCalls.every((tc) => {
		const r = tc.result;
		return r.includes("<no_results") || r.includes("<error") || r.trim().length < 50;
	});
}

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------

async function gradeAnswered(question: string, answer: string): Promise<boolean> {
	const prompt = [
		"Does this response answer the question with specific factual information ",
		'(not hedging or saying "I don\'t know")?\n',
		`Question: ${question}\n`,
		`Response: ${answer}\n`,
		'Respond ONLY with JSON: {"answered": true} or {"answered": false}',
	].join("");

	const raw = await gradeWithModel(prompt);
	try {
		const parsed = JSON.parse(raw);
		return parsed.answered === true;
	} catch {
		return (
			raw.toLowerCase().includes('"answered": true') ||
			raw.toLowerCase().includes('"answered":true')
		);
	}
}

// ---------------------------------------------------------------------------
// Run one question in one mode
// ---------------------------------------------------------------------------

export interface QuestionResult {
	question: string;
	mode: "with-tool" | "without-tool";
	result: AgentResult;
	answered: boolean;
	acknowledgedUncertainty: boolean;
	triedButFailed: boolean;
	potentiallyHallucinated: boolean;
	toolQueries: string[];
}

async function runQuestion(
	question: string,
	mode: "with-tool" | "without-tool",
	log: (entry: unknown) => Promise<void>,
): Promise<QuestionResult> {
	const tools = mode === "with-tool" ? [WIKI_TOOL] : [];
	const result = await runAgentLoop(
		{
			system: SYSTEM_PROMPT,
			userMessage: question,
			tools,
			toolHandler: defaultToolHandler,
			model: DEFAULT_MODEL,
			maxTurns: 5,
		},
		log,
	);

	const toolQueries = result.toolCalls.map((tc) => String(tc.input["query"] ?? ""));
	const acknowledgedUncertainty = UNCERTAINTY_RE.test(result.answer);

	// "Tried but failed": model used the tool but tool returned nothing useful
	const triedButFailed = result.usedTool && toolResultsEmpty(result.toolCalls);

	let answered = false;
	if (mode === "with-tool") {
		answered = await gradeAnswered(question, result.answer);
	}

	// "Potentially hallucinated": model gives a specific factual answer WITHOUT
	// using the tool for a post-cutoff question. This is suspicious because the
	// model should not know these answers from training data alone.
	const potentiallyHallucinated =
		!result.usedTool && !acknowledgedUncertainty && SPECIFIC_ANSWER_RE.test(result.answer);

	return {
		question,
		mode,
		result,
		answered,
		acknowledgedUncertainty,
		triedButFailed,
		potentiallyHallucinated,
		toolQueries,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const singleIndex = process.argv[2] != null ? Number(process.argv[2]) : null;

	const indicesToRun = singleIndex != null ? [singleIndex] : QUESTIONS.map((_, i) => i);

	console.log(`Good Recency Benchmark`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(
		singleIndex != null
			? `Running question ${singleIndex}: "${QUESTIONS[singleIndex]}"`
			: `Running all ${QUESTIONS.length} questions`,
	);
	console.log();

	const { log, path: logPath } = await initLog("good_recency");
	console.log(`Log: ${logPath}\n`);

	const allResults: QuestionResult[] = [];

	for (const idx of indicesToRun) {
		const q = QUESTIONS[idx]!;
		console.log(`[${idx}] ${q}`);

		// With tool
		console.log("  mode: with-tool ...");
		const withTool = await runQuestion(q, "with-tool", log);
		console.log(
			`    used_tool=${withTool.result.usedTool}  answered=${withTool.answered}  tried_but_failed=${withTool.triedButFailed}  turns=${withTool.result.turns}`,
		);
		if (withTool.toolQueries.length > 0) {
			console.log(`    queries: ${withTool.toolQueries.join("; ")}`);
		}
		console.log(`    answer: ${withTool.result.answer.slice(0, 200)}`);
		allResults.push(withTool);

		// Without tool
		console.log("  mode: without-tool ...");
		const withoutTool = await runQuestion(q, "without-tool", log);
		console.log(
			`    uncertainty=${withoutTool.acknowledgedUncertainty}  hallucinated=${withoutTool.potentiallyHallucinated}  turns=${withoutTool.result.turns}`,
		);
		console.log(`    answer: ${withoutTool.result.answer.slice(0, 200)}`);
		allResults.push(withoutTool);

		console.log();
	}

	// ---- TSV ----
	const headers = [
		"question",
		"mode",
		"used_tool",
		"tool_queries",
		"model_answer",
		"answered",
		"acknowledged_uncertainty",
		"tried_but_failed",
		"potentially_hallucinated",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const rows = allResults.map((r) => [
		r.question,
		r.mode,
		String(r.result.usedTool),
		r.toolQueries.join("; "),
		r.result.answer.replace(/\t/g, " ").replace(/\n/g, " "),
		String(r.answered),
		String(r.acknowledgedUncertainty),
		String(r.triedButFailed),
		String(r.potentiallyHallucinated),
		String(r.result.turns),
		String(r.result.inputTokens),
		String(r.result.outputTokens),
	]);

	await writeTsvResults("good_recency", headers, rows);

	// ---- Summary ----
	const withToolResults = allResults.filter((r) => r.mode === "with-tool");
	const withoutToolResults = allResults.filter((r) => r.mode === "without-tool");

	const usedToolPct =
		(withToolResults.filter((r) => r.result.usedTool).length / withToolResults.length) * 100;
	const answeredPct =
		(withToolResults.filter((r) => r.answered).length / withToolResults.length) * 100;
	const triedButFailedPct =
		(withToolResults.filter((r) => r.triedButFailed).length / withToolResults.length) * 100;
	const uncertaintyPct =
		(withoutToolResults.filter((r) => r.acknowledgedUncertainty).length /
			withoutToolResults.length) *
		100;
	const hallucinatedPct =
		(withoutToolResults.filter((r) => r.potentiallyHallucinated).length /
			withoutToolResults.length) *
		100;

	const totalInput = allResults.reduce((s, r) => s + r.result.inputTokens, 0);
	const totalOutput = allResults.reduce((s, r) => s + r.result.outputTokens, 0);

	console.log("=".repeat(60));
	console.log("Summary");
	console.log("=".repeat(60));
	console.log(`  Used tool (with-tool):                ${usedToolPct.toFixed(1)}%`);
	console.log(`  Answered (with-tool):                 ${answeredPct.toFixed(1)}%`);
	console.log(`  Tried but failed (with-tool):         ${triedButFailedPct.toFixed(1)}%`);
	console.log(`  Acknowledged uncertainty (no-tool):    ${uncertaintyPct.toFixed(1)}%`);
	console.log(`  Potentially hallucinated (no-tool):    ${hallucinatedPct.toFixed(1)}%`);
	console.log(`  Total input tokens:                   ${totalInput}`);
	console.log(`  Total output tokens:                  ${totalOutput}`);
	console.log(`  Total tokens:                         ${totalInput + totalOutput}`);

	if (usedToolPct < 80) {
		console.log("\n  WARNING: tool usage below 80% threshold");
	}
	if (hallucinatedPct > 20) {
		console.log(
			"\n  WARNING: hallucination rate above 20% — model is fabricating post-cutoff facts",
		);
	}
}

main();
