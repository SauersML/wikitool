// QA Capability eval for the Wikipedia search tool
// Measures how much the tool improves the model's ability to answer hard questions.
// Grading uses Claude Sonnet via headless CLI with web search for verification.
// Usage: bun src/evals/qa_precise.ts [questionIndex]

import { DEFAULT_MODEL, initLog, runAgentLoop, WIKI_TOOL, writeTsvResults } from "./utils";

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

export const SYSTEM_PROMPT =
	"You are a helpful assistant that answers questions thoroughly and accurately. You have access to a Wikipedia search tool. Use it when you think looking up information would help you give a better answer. Provide a clear, well-reasoned answer. " +
	"End with ANSWER: followed by your answer.";

export const QUESTIONS: Question[] = [
	{
		question:
			"What specific enzyme catalyzes the committed step in the mevalonate pathway, and what is its EC number?",
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
			"Octahedral: 10Dq; Tetrahedral: 4/9 × 10Dq = 4.44Dq; smaller because no ligands point directly at d orbitals",
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

function buildGradePrompt(question: string, expected: string, answer: string): string {
	return `You are Claude Sonnet, an expert evaluator with web search capabilities. Your job is to grade a model's answer for factual correctness.

IMPORTANT: Before judging, use web search to verify the key technical claims in both the reference answer and the model's response. Do not rely solely on your training data — actually look up the facts to confirm them.

Given a question, a reference answer, and a model's response, evaluate:
1. CORRECT: Does the response contain the key facts? Verify these facts via web search before judging. (yes/no)
2. QUALITY: Rate the response quality from 1-5 (1=wrong, 2=major gaps, 3=mostly correct, 4=correct and clear, 5=excellent with verified details)

Question: ${question}
Reference answer: ${expected}
Model response: ${answer}

After verifying the facts via search, respond ONLY with JSON: {"correct": true, "quality": 4}`;
}

export function parseGradeResponse(raw: string): GradeResult {
	// Try parsing as JSON first
	try {
		const parsed = JSON.parse(raw.trim());
		if (typeof parsed.correct === "boolean" && typeof parsed.quality === "number") {
			return { correct: parsed.correct, quality: parsed.quality };
		}
	} catch {
		// Fall through to regex fallback
	}

	// Try extracting JSON object from the string
	const jsonMatch = raw.match(/\{[^}]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (typeof parsed.correct === "boolean" && typeof parsed.quality === "number") {
				return { correct: parsed.correct, quality: parsed.quality };
			}
		} catch {
			// Fall through to regex fallback
		}
	}

	// Regex fallback
	const correctMatch = raw.match(/"correct"\s*:\s*(true|false)/);
	const qualityMatch = raw.match(/"quality"\s*:\s*(\d)/);

	const correct = correctMatch?.[1] === "true";
	const quality = qualityMatch?.[1] ? Number.parseInt(qualityMatch[1], 10) : 1;

	return { correct, quality };
}

// --- Grading via Sonnet CLI ---

async function gradeWithSonnet(prompt: string): Promise<string> {
	const result = await Bun.$`echo ${prompt} | claude -p --model sonnet`.text();
	return result.trim();
}

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] ? Number.parseInt(process.argv[2], 10) : undefined;
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

	const { log } = await initLog("qa_precise");

	const rows: string[][] = [];
	const withToolResults: { correct: boolean; quality: number }[] = [];
	const withoutToolResults: { correct: boolean; quality: number }[] = [];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	for (let i = 0; i < questionsToRun.length; i++) {
		const q = questionsToRun[i]!;
		const qIndex = startIndex + i;
		console.log(`[${qIndex}] ${q.domain}: ${q.question.slice(0, 70)}...`);

		// --- With tool ---
		console.log("  Running WITH tool...");
		const withTool = await runAgentLoop(
			{
				system: SYSTEM_PROMPT,
				userMessage: q.question,
				tools: [WIKI_TOOL],
			},
			log,
		);

		const toolQueries = withTool.toolCalls
			.map((tc) => (tc.input["query"] as string) ?? "")
			.join("; ");

		const withGradePrompt = buildGradePrompt(q.question, q.expected, withTool.answer);
		const withGradeRaw = await gradeWithSonnet(withGradePrompt);
		const withGrade = parseGradeResponse(withGradeRaw);
		withToolResults.push(withGrade);
		totalInputTokens += withTool.inputTokens;
		totalOutputTokens += withTool.outputTokens;

		console.log(
			`  WITH tool:    correct=${withGrade.correct} quality=${withGrade.quality} turns=${withTool.turns} tool_used=${withTool.usedTool}`,
		);

		rows.push([
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
		]);

		// --- Without tool ---
		console.log("  Running WITHOUT tool...");
		const withoutTool = await runAgentLoop(
			{
				system: SYSTEM_PROMPT,
				userMessage: q.question,
				tools: [],
			},
			log,
		);

		const withoutGradePrompt = buildGradePrompt(q.question, q.expected, withoutTool.answer);
		const withoutGradeRaw = await gradeWithSonnet(withoutGradePrompt);
		const withoutGrade = parseGradeResponse(withoutGradeRaw);
		withoutToolResults.push(withoutGrade);
		totalInputTokens += withoutTool.inputTokens;
		totalOutputTokens += withoutTool.outputTokens;

		console.log(
			`  WITHOUT tool:  correct=${withoutGrade.correct} quality=${withoutGrade.quality} turns=${withoutTool.turns}`,
		);
		console.log("");

		rows.push([
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
		]);
	}

	// --- Write TSV ---
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
	await writeTsvResults("qa_precise", headers, rows);

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
}

// Only run when executed directly, not when imported
const isMainModule =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("qa_precise.ts");

if (isMainModule && !process.env["BUN_TEST"]) {
	main();
}
