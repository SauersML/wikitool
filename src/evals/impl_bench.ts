// Implementation Benchmark — uses Claude API with server-side code execution
//
// Flow per algorithm:
//   1. Sonnet implements the algorithm (with or without wiki tool) using code_execution sandbox
//   2. Opus evaluates: reads the code, runs it in sandbox, grades on rubric
//
// Usage:
//   bun run src/evals/impl_bench.ts                       — print usage info
//   bun run src/evals/impl_bench.ts run <index>           — with tool (default)
//   bun run src/evals/impl_bench.ts run <index> --no-tool — without tool
//   bun run src/evals/impl_bench.ts all                   — run all 20 in both modes

import { mkdir } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import {
	CODE_EXECUTION_TOOL,
	createSeenContent,
	createToolHandler,
	initLog,
	pairedPermutationTest,
	runAgentLoop,
	WIKI_TOOL,
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

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";

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
	const pyBlocks = [...text.matchAll(/```python\n([\s\S]*?)```/g)];
	if (pyBlocks.length > 0) return pyBlocks.at(-1)![1]!.trim();

	const anyBlocks = [...text.matchAll(/```\n([\s\S]*?)```/g)];
	if (anyBlocks.length > 0) return anyBlocks.at(-1)![1]!.trim();

	return null;
}

/**
 * Extract Python code from the agent result.
 * 1. Scan the final answer (last text block) for the last fenced code block.
 * 2. If missing, scan ALL assistant text blocks in the conversation (newest first)
 *    — covers the case where the model wrote code via code_execution but didn't
 *    repeat it in its closing remarks.
 * 3. Last resort: return raw answer text (evaluator will flag it as broken).
 */
function extractCode(
	answer: string,
	messages: Anthropic.Messages.MessageParam[],
): string {
	// 1. Final answer text
	const fromAnswer = lastCodeBlock(answer);
	if (fromAnswer) return fromAnswer;

	// 2. Scan all assistant text blocks, newest first
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const blocks = msg.content as Array<{ type: string; text?: string }>;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const b = blocks[j]!;
			if (b.type === "text" && b.text) {
				const code = lastCodeBlock(b.text);
				if (code) return code;
			}
		}
	}

	// 3. Last resort
	return answer;
}

// --- Implementation step (Sonnet via API + code_execution) ---

async function implement(index: number, useTool: boolean): Promise<RunResult> {
	const q = QUESTIONS[index]!;
	const mode = useTool ? "with-tool" : "no-tool";

	const toolInstruction = useTool
		? `You have access to a Wikipedia search tool. Use it to look up the Wikipedia article "${q.article}" for algorithm details before implementing.`
		: "Do NOT use the Wikipedia search tool. Implement purely from your own knowledge.";

	const system = [
		"You are an expert Python programmer. You have access to a code execution sandbox where you can write and run Python code.",
		toolInstruction,
	].join("\n");

	const userMessage = [
		q.prompt,
		"",
		"Create a complete, standalone Python implementation.",
		"Include a test/demo in an `if __name__ == '__main__':` block that exercises the main functionality and prints results.",
		"Use the code execution sandbox to write and test the code. Make sure it runs without errors.",
		"",
		"IMPORTANT: After you are done, output the complete final Python code in your response as a single ```python fenced code block.",
	].join("\n");

	console.log(`\n[${index}] ${q.name} (${mode})`);
	console.log(`  Launching Sonnet...`);

	const tools: Anthropic.Messages.ToolUnion[] = [CODE_EXECUTION_TOOL];
	if (useTool) tools.push(WIKI_TOOL);

	const result = await runAgentLoop({
		system,
		userMessage,
		tools,
		toolHandler: useTool ? createToolHandler(createSeenContent()) : undefined,
		model: SONNET,
		maxTokens: 16384,
		maxTurns: 50,
	});

	const code = extractCode(result.answer, result.messages);

	console.log(`  Sonnet done: ${result.turns} turns, tool_used=${result.usedTool}`);

	// Save logs
	const logDir = `${import.meta.dir}/../../logs`;
	await mkdir(logDir, { recursive: true });
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_sonnet.log`, result.answer);
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

// --- Evaluation step (Opus via API + code_execution) ---

async function evaluate(index: number, code: string, mode: string): Promise<GradeResult> {
	const q = QUESTIONS[index]!;

	const system =
		"You are an expert Python evaluator. You have access to a code execution sandbox where you can write and run Python code.";

	const userMessage = [
		`You are evaluating a Python implementation of ${q.name}.`,
		"",
		"Here is the implementation:",
		"```python",
		code,
		"```",
		"",
		"1. Save this code to a file and run it with `python3`. Observe the output.",
		"2. If it fails, note the error. Try to understand what went wrong.",
		"3. Write a few additional test cases and run them to verify correctness.",
		"4. Grade the implementation on this rubric (1-10 each):",
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

	const result = await runAgentLoop({
		system,
		userMessage,
		tools: [CODE_EXECUTION_TOOL],
		model: OPUS,
		maxTokens: 16384,
		maxTurns: 50,
	});

	// Save Opus log
	const logDir = `${import.meta.dir}/../../logs`;
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_opus.log`, result.answer);

	console.log(`  Opus done: ${result.turns} turns`);

	return parseGradeFromOutput(result.answer);
}

// --- Grade parsing ---

export function parseGradeFromOutput(output: string): GradeResult {
	const jsonMatch = output.match(/\{[^{}]*"correctness"\s*:\s*\d+[^{}]*\}/s);
	if (!jsonMatch) throw new Error(`No grade JSON found in output (${output.length} chars)`);
	const parsed = JSON.parse(jsonMatch[0]);
	const correctness = Number(parsed.correctness);
	const helpfulness = Number(parsed.helpfulness);
	const elegance = Number(parsed.elegance);
	const completion = Number(parsed.completion);
	if ([correctness, helpfulness, elegance, completion].some((n) => Number.isNaN(n))) {
		throw new Error(`Grade JSON has non-numeric fields: ${jsonMatch[0].slice(0, 200)}`);
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
	console.log("Implementation Benchmark — Claude API + code_execution sandbox");
	console.log(`Implement: ${SONNET} | Evaluate: ${OPUS}`);
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
				g.notes.replace(/\t/g, " ").replace(/\n/g, " "),
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

	// Paired permutation test on algorithms that have both modes
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
	console.log("Implementation Benchmark — Claude API + code_execution sandbox");
	console.log("");
	console.log("  Sonnet implements algorithms using server-side code execution.");
	console.log("  Opus evaluates: runs code in sandbox, writes tests, grades on rubric.");
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
