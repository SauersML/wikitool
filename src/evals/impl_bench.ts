// Implementation Benchmark — uses Agent SDK with local Bash/Write/Read tools
//
// Flow per algorithm:
//   1. Sonnet implements the algorithm (with or without wiki tool) using local file + bash tools
//   2. Opus evaluates: reads the code, runs it locally, grades on rubric
//
// Usage:
//   bun run src/evals/impl_bench.ts                       — print usage info
//   bun run src/evals/impl_bench.ts run <index>           — with tool (default)
//   bun run src/evals/impl_bench.ts run <index> --no-tool — without tool
//   bun run src/evals/impl_bench.ts all                   — run all 20 in both modes

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WIKI_TOOL_NAME,
	createSeenContent,
	createWikiMcpServer,
	extractJson,
	initLog,
	pairedPermutationTest,
	runAgent,
	writeTsvResults,
} from "./utils";

// --- Types ---

export interface AlgorithmQuestion {
	name: string;
	article: string;
	prompt: string;
}

export interface GradeResult {
	correctness: number;
	helpfulness: number;
	elegance: number;
	completion: number;
	ran_successfully: boolean;
	notes: string;
}

export interface RunResult {
	algorithm: string;
	mode: string;
	code: string;
	turns: number;
	usedTool: boolean;
	inputTokens: number;
	outputTokens: number;
}

// --- Constants ---

const IMPL_MODEL = "claude-haiku-4-5-20251001";
const EVAL_MODEL = "claude-opus-4-6";

export const QUESTIONS: AlgorithmQuestion[] = [
	{
		name: "Aho-Corasick string matching",
		article: "Aho\u2013Corasick algorithm",
		prompt:
			"Implement the Aho-Corasick string matching algorithm in Python. Include building the automaton from a set of pattern strings and searching a text for all occurrences of any pattern.",
	},
	{
		name: "Edmonds-Karp maximum flow",
		article: "Edmonds\u2013Karp algorithm",
		prompt:
			"Implement the Edmonds-Karp maximum flow algorithm in Python. Use BFS to find augmenting paths. Support adding edges and computing max flow between a source and sink.",
	},
	{
		name: "Tarjan's strongly connected components",
		article: "Tarjan\u2019s strongly connected components algorithm",
		prompt:
			"Implement Tarjan's algorithm for finding all strongly connected components in a directed graph in Python.",
	},
	{
		name: "Bentley-Ottmann sweep line",
		article: "Bentley\u2013Ottmann algorithm",
		prompt:
			"Implement the Bentley-Ottmann sweep line algorithm for finding all intersection points among a set of line segments in Python.",
	},
	{
		name: "Cooley-Tukey FFT (radix-2)",
		article: "Cooley\u2013Tukey FFT algorithm",
		prompt:
			"Implement the Cooley-Tukey radix-2 FFT algorithm in Python. Include both the forward and inverse transforms.",
	},
	{
		name: "Knuth-Morris-Pratt string matching",
		article: "Knuth\u2013Morris\u2013Pratt algorithm",
		prompt:
			"Implement the Knuth-Morris-Pratt (KMP) string matching algorithm in Python. Include building the failure function and searching for a pattern in a text.",
	},
	{
		name: "Red-black tree with insert and delete",
		article: "Red\u2013black tree",
		prompt:
			"Implement a red-black tree in Python with insert and delete operations, including all rotation and rebalancing logic.",
	},
	{
		name: "A* search with consistent heuristic",
		article: "A* search algorithm",
		prompt:
			"Implement the A* search algorithm in Python with support for a consistent (monotone) heuristic. Include the open/closed set management and path reconstruction.",
	},
	{
		name: "Hopcroft-Karp bipartite matching",
		article: "Hopcroft\u2013Karp algorithm",
		prompt: "Implement the Hopcroft-Karp algorithm for maximum bipartite matching in Python.",
	},
	{
		name: "Suffix array construction (SA-IS)",
		article: "SA-IS",
		prompt:
			"Implement the SA-IS (Suffix Array Induced Sorting) algorithm for linear-time suffix array construction in Python.",
	},
	{
		name: "Dinic's blocking flow algorithm",
		article: "Dinic\u2019s algorithm",
		prompt:
			"Implement Dinic's blocking flow algorithm for maximum flow in Python. Include the BFS level graph construction and DFS blocking flow.",
	},
	{
		name: "Burrows-Wheeler transform and inverse",
		article: "Burrows\u2013Wheeler transform",
		prompt: "Implement the Burrows-Wheeler transform and its inverse in Python.",
	},
	{
		name: "Treap with split and merge",
		article: "Treap",
		prompt:
			"Implement a treap (tree + heap) data structure in Python with split and merge operations, plus insert, delete, and search.",
	},
	{
		name: "Hungarian algorithm for assignment",
		article: "Hungarian algorithm",
		prompt:
			"Implement the Hungarian algorithm (Kuhn-Munkres) for the assignment problem in Python. Handle both minimization and maximization.",
	},
	{
		name: "Rabin-Karp with rolling hash",
		article: "Rabin\u2013Karp algorithm",
		prompt:
			"Implement the Rabin-Karp string matching algorithm with rolling hash in Python. Handle hash collisions correctly.",
	},
	{
		name: "Floyd-Warshall all-pairs shortest path",
		article: "Floyd\u2013Warshall algorithm",
		prompt:
			"Implement the Floyd-Warshall all-pairs shortest path algorithm in Python. Include path reconstruction.",
	},
	{
		name: "Earley parser",
		article: "Earley parser",
		prompt:
			"Implement an Earley parser in Python. Support defining a context-free grammar and parsing an input string, returning whether it is accepted.",
	},
	{
		name: "Fenwick tree (binary indexed tree)",
		article: "Fenwick tree",
		prompt:
			"Implement a Fenwick tree (binary indexed tree) in Python with point update and prefix sum query. Also include range sum query.",
	},
	{
		name: "Miller-Rabin primality test",
		article: "Miller\u2013Rabin primality test",
		prompt:
			"Implement the Miller-Rabin primality test in Python. Include a deterministic version for numbers up to certain bounds and a probabilistic version with configurable rounds.",
	},
	{
		name: "LZW compression",
		article: "Lempel\u2013Ziv\u2013Welch",
		prompt:
			"Implement LZW compression and decompression in Python. Handle the dictionary initialization, encoding, and decoding.",
	},
];

// --- Helpers ---

function sanitizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+$/, "");
}

/** Find the last ```python (or any ```) code block in a string. */
function lastCodeBlock(text: string): string | null {
	let lastPython: string | null = null;
	let lastAny: string | null = null;
	let searchFrom = 0;

	while (true) {
		const fenceStart = text.indexOf("```", searchFrom);
		if (fenceStart === -1) break;

		// Find end of the opening fence line
		const lineEnd = text.indexOf("\n", fenceStart);
		if (lineEnd === -1) break;

		const fenceTag = text.slice(fenceStart + 3, lineEnd).trim();

		// Find closing ```
		const fenceClose = text.indexOf("\n```", lineEnd);
		if (fenceClose === -1) {
			searchFrom = lineEnd;
			continue;
		}

		const content = text.slice(lineEnd + 1, fenceClose).trim();
		if (fenceTag === "python") lastPython = content;
		else if (fenceTag === "") lastAny = content;

		searchFrom = fenceClose + 4;
	}

	return lastPython ?? lastAny;
}

/**
 * Extract Python code from the agent result.
 * Scans the final answer then all assistant text blocks for the last fenced code block.
 */
function extractCode(answer: string, assistantTexts: string[]): string {
	const fromAnswer = lastCodeBlock(answer);
	if (fromAnswer) return fromAnswer;

	for (let i = assistantTexts.length - 1; i >= 0; i--) {
		const code = lastCodeBlock(assistantTexts[i]!);
		if (code) return code;
	}

	return answer;
}

// --- Implementation step (Sonnet via Agent SDK + Bash/Write) ---

async function implement(index: number, useTool: boolean): Promise<RunResult> {
	const q = QUESTIONS[index]!;
	const mode = useTool ? "with-tool" : "no-tool";
	const workDir = await mkdtemp(join(tmpdir(), `impl-${sanitizeName(q.name)}-`));

	const prompt = [
		q.prompt,
		"",
		`Create a single file called \`${sanitizeName(q.name)}.py\` with your complete implementation.`,
		"Include a test/demo in an `if __name__ == '__main__':` block that exercises the main functionality and prints results.",
		"Write the file, then run it to make sure it works without errors.",
		"",
		"IMPORTANT: After you are done, output the complete final Python code in your response as a single ```python fenced code block.",
	].join("\n");

	console.log(`\n[${index}] ${q.name} (${mode})`);
	console.log(`  Launching Sonnet...`);

	const builtinTools = ["Write", "Bash"];
	const allowedTools = ["Write", "Bash"];
	const mcpServers: Record<string, ReturnType<typeof createWikiMcpServer>> = {};

	if (useTool) {
		mcpServers.wiki = createWikiMcpServer({ seen: createSeenContent() });
		allowedTools.push(WIKI_TOOL_NAME);
	}

	const result = await runAgent({
		prompt,
		model: IMPL_MODEL,
		builtinTools,
		allowedTools,
		mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
		cwd: workDir,
		maxTurns: 50,
	});

	const code = extractCode(result.answer, result.assistantTexts);

	console.log(`  Sonnet done: ${result.turns} turns, tool_used=${result.usedTool}`);

	// Save logs — full conversation, not just final answer
	const logDir = `${import.meta.dir}/../../logs`;
	await mkdir(logDir, { recursive: true });
	const fullLog = JSON.stringify({
		algorithm: q.name,
		mode,
		turns: result.turns,
		usedTool: result.usedTool,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		durationMs: result.durationMs,
		costUsd: result.costUsd,
		toolCalls: result.toolCalls,
		assistantTexts: result.assistantTexts,
		answer: result.answer,
	}, null, 2);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_sonnet.json`, fullLog);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_code.py`, code);

	return {
		algorithm: q.name,
		mode,
		code,
		turns: result.turns,
		usedTool: result.usedTool,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
	};
}

// --- Evaluation step (Opus via Agent SDK + Read/Write/Bash) ---

async function evaluate(index: number, code: string, mode: string): Promise<GradeResult> {
	const q = QUESTIONS[index]!;
	const workDir = await mkdtemp(join(tmpdir(), `eval-${sanitizeName(q.name)}-`));
	const pyFile = `${sanitizeName(q.name)}.py`;

	// Write the code to the eval directory so Opus can read and run it
	await Bun.write(join(workDir, pyFile), code);

	const prompt = [
		`You are evaluating a Python implementation of ${q.name}.`,
		"",
		`1. Read the file \`${pyFile}\` in the current directory.`,
		`2. Run it with \`python3 ${pyFile}\` and observe the output.`,
		"3. If it fails, note the error. Try to understand what went wrong.",
		"4. Write a few additional test cases and run them to verify correctness.",
		"5. Grade the implementation on this rubric (1-10 each):",
		"   - CORRECTNESS: Does it implement the algorithm correctly? Would it produce correct results on all valid inputs?",
		"   - HELPFULNESS: Good docstrings, comments, examples? Clean, usable API?",
		"   - ELEGANCE: Well-structured, Pythonic, avoids unnecessary complexity?",
		"   - COMPLETION: Is the implementation complete? Edge cases handled?",
		"",
		"After your analysis, output EXACTLY this JSON block as the LAST thing in your response:",
		"```json",
		'{"correctness": N, "helpfulness": N, "elegance": N, "completion": N, "ran_successfully": true/false, "notes": "brief explanation"}',
		"```",
	].join("\n");

	console.log(`  Launching Opus evaluator...`);

	const result = await runAgent({
		prompt,
		model: EVAL_MODEL,
		builtinTools: ["Read", "Write", "Bash"],
		allowedTools: ["Read", "Write", "Bash"],
		cwd: workDir,
		maxTurns: 50,
	});

	// Save Opus log — full conversation
	const logDir = `${import.meta.dir}/../../logs`;
	const fullLog = JSON.stringify({
		algorithm: q.name,
		mode,
		turns: result.turns,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		durationMs: result.durationMs,
		costUsd: result.costUsd,
		toolCalls: result.toolCalls,
		assistantTexts: result.assistantTexts,
		answer: result.answer,
	}, null, 2);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_opus.json`, fullLog);

	console.log(`  Opus done: ${result.turns} turns`);

	return parseGradeFromOutput(result.answer);
}

// --- Grade parsing ---

export function parseGradeFromOutput(output: string): GradeResult {
	const parsed = extractJson(output);
	if (!parsed || !("correctness" in parsed))
		throw new Error(`No grade JSON found in output (${output.length} chars)`);
	const correctness = Number(parsed.correctness);
	const helpfulness = Number(parsed.helpfulness);
	const elegance = Number(parsed.elegance);
	const completion = Number(parsed.completion);
	if ([correctness, helpfulness, elegance, completion].some((n) => Number.isNaN(n))) {
		throw new Error(`Grade JSON has non-numeric fields: ${JSON.stringify(parsed).slice(0, 200)}`);
	}
	return {
		correctness,
		helpfulness,
		elegance,
		completion,
		ran_successfully: parsed.ran_successfully === true,
		notes: String(parsed.notes),
	};
}

// --- Run single algorithm end-to-end ---

async function runOne(
	index: number,
	useTool: boolean,
): Promise<{ run: RunResult; grade: GradeResult }> {
	const implResult = await implement(index, useTool);
	const gradeResult = await evaluate(index, implResult.code, implResult.mode);

	const total =
		gradeResult.correctness +
		gradeResult.helpfulness +
		gradeResult.elegance +
		gradeResult.completion;

	console.log(
		`  Grade: correctness=${gradeResult.correctness} helpfulness=${gradeResult.helpfulness} elegance=${gradeResult.elegance} completion=${gradeResult.completion} total=${total}/40`,
	);
	console.log(`  Ran successfully: ${gradeResult.ran_successfully}`);
	if (gradeResult.notes) console.log(`  Notes: ${gradeResult.notes}`);

	return { run: implResult, grade: gradeResult };
}

// --- Run all ---

async function runAll(): Promise<void> {
	console.log("Implementation Benchmark — Agent SDK + local Bash/Write/Read");
	console.log(`Implement: ${IMPL_MODEL} | Evaluate: ${EVAL_MODEL}`);
	console.log(`Algorithms: ${QUESTIONS.length}`);
	console.log(`Modes: with-tool, no-tool`);
	console.log("");

	const { log, path: logPath } = await initLog("impl_bench");
	console.log(`Log: ${logPath}\n`);

	const rows: string[][] = [];

	for (let i = 0; i < QUESTIONS.length; i++) {
		const q = QUESTIONS[i]!;
		console.log(`\n${"=".repeat(60)}`);
		console.log(`[${i}] ${q.name}`);
		console.log("=".repeat(60));

		for (const useTool of [true, false]) {
			const { run, grade: g } = await runOne(i, useTool);
			const total = g.correctness + g.helpfulness + g.elegance + g.completion;

			await log({
				timestamp: new Date().toISOString(),
				index: i,
				algorithm: q.name,
				mode: run.mode,
				grade: g,
				total,
			});

			rows.push([
				q.name,
				run.mode,
				String(g.correctness),
				String(g.helpfulness),
				String(g.elegance),
				String(g.completion),
				String(total),
				String(g.ran_successfully),
				g.notes,
			]);
		}
	}

	const headers = [
		"algorithm",
		"mode",
		"correctness",
		"helpfulness",
		"elegance",
		"completion",
		"total_score",
		"ran_successfully",
		"notes",
	];
	await writeTsvResults("impl_bench", headers, rows);

	// Summary
	console.log(`\n${"=".repeat(60)}`);
	console.log("SUMMARY");
	console.log("=".repeat(60));

	const withTool = rows.filter((r) => r[1] === "with-tool");
	const noTool = rows.filter((r) => r[1] === "no-tool");
	const mean = (subset: string[][], col: number) =>
		subset.reduce((sum, r) => sum + Number(r[col]), 0) / subset.length;

	console.log(
		`  With tool:  mean score ${mean(withTool, 6).toFixed(1)}/40, ran ok ${withTool.filter((r) => r[7] === "true").length}/${withTool.length}`,
	);
	console.log(
		`  No tool:    mean score ${mean(noTool, 6).toFixed(1)}/40, ran ok ${noTool.filter((r) => r[7] === "true").length}/${noTool.length}`,
	);

	const withScores: number[] = [];
	const noScores: number[] = [];
	for (const wt of withTool) {
		const nt = noTool.find((r) => r[0] === wt[0]);
		if (nt) {
			withScores.push(Number(wt[6]));
			noScores.push(Number(nt[6]));
		}
	}
	if (withScores.length > 1) {
		const perm = pairedPermutationTest(withScores, noScores);
		console.log(
			`  Permutation test (n=${withScores.length}): diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`,
		);
	}
}

// --- CLI ---

function printUsage() {
	console.log("Implementation Benchmark — Agent SDK + local Bash/Write/Read");
	console.log("");
	console.log("  Sonnet implements algorithms using local file and bash tools.");
	console.log("  Opus evaluates: reads code, runs it, writes tests, grades on rubric.");
	console.log("");
	console.log("Usage:");
	console.log("  bun run src/evals/impl_bench.ts                          — print this help");
	console.log(
		"  bun run src/evals/impl_bench.ts run <index>              — implement + evaluate with tool",
	);
	console.log(
		"  bun run src/evals/impl_bench.ts run <index> --no-tool    — implement + evaluate without tool",
	);
	console.log(
		"  bun run src/evals/impl_bench.ts all                      — run all 20 in both modes",
	);
	console.log("");
	console.log(`Algorithms (${QUESTIONS.length}):`);
	for (let i = 0; i < QUESTIONS.length; i++) {
		console.log(`  ${String(i).padStart(2)}. ${QUESTIONS[i]!.name}`);
	}
	console.log("");
	console.log("Logs saved to: logs/impl_bench_<algorithm>_<mode>_{sonnet,opus}.log");
	console.log("Code saved to: logs/impl_bench_<algorithm>_<mode>_code.py");
}

async function main() {
	const command = process.argv[2];

	if (!command) {
		printUsage();
		return;
	}

	if (command === "run") {
		const indexStr = process.argv[3];
		if (indexStr === undefined) {
			console.error("Error: provide an algorithm index.");
			process.exit(1);
		}
		const index = Number.parseInt(indexStr, 10);
		if (Number.isNaN(index) || index < 0 || index >= QUESTIONS.length) {
			console.error(`Invalid index: ${indexStr}. Must be 0-${QUESTIONS.length - 1}.`);
			process.exit(1);
		}
		const useTool = !process.argv.includes("--no-tool");
		await runOne(index, useTool);
	} else if (command === "all") {
		await runAll();
	} else {
		console.error(`Unknown command: ${command}`);
		printUsage();
		process.exit(1);
	}
}

const isMainModule =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("impl_bench.ts");

if (isMainModule && !process.env["BUN_TEST"]) {
	main();
}
