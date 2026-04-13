// Implementation Benchmark — uses Claude Code headless mode
//
// Flow per algorithm:
//   1. Sonnet implements the algorithm in an isolated worktree (with or without wiki tool)
//   2. Opus evaluates: reads the code, attempts to run it, grades on rubric
//
// Usage:
//   bun run src/evals/impl_bench.ts                       — print usage info
//   bun run src/evals/impl_bench.ts run <index>           — with tool (default)
//   bun run src/evals/impl_bench.ts run <index> --no-tool — without tool
//   bun run src/evals/impl_bench.ts all                   — run all 20 in both modes
//   bun run src/evals/impl_bench.ts eval <index>          — evaluate existing code with Opus

import { mkdir } from "node:fs/promises";
import { initLog, writeTsvResults } from "./utils";

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
	worktree: string;
	branch: string;
	codePath: string;
	stdout: string;
	exitCode: number;
}

// --- Constants ---

const SONNET = "sonnet";
const OPUS = "opus";

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

function worktreeName(algorithm: string, mode: string): string {
	return `impl-${sanitizeName(algorithm)}-${mode}`;
}

async function runClaude(
	args: string[],
	timeoutMs = 600_000,
): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn(["claude", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CLAUDE_CODING_AGENT: "1" },
	});

	const timeout = setTimeout(() => proc.kill(), timeoutMs);
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	clearTimeout(timeout);
	return { stdout, exitCode };
}

// --- Implementation step (Sonnet) ---

async function implement(index: number, useTool: boolean): Promise<RunResult> {
	const q = QUESTIONS[index]!;
	const mode = useTool ? "with-tool" : "no-tool";
	const wt = worktreeName(q.name, mode);

	const toolInstruction = useTool
		? `You have access to the search_wikipedia MCP tool. Use it to look up the Wikipedia article "${q.article}" for algorithm details before implementing.`
		: "Do NOT use any tools. Implement purely from your own knowledge.";

	const prompt = [
		`${q.prompt}`,
		"",
		toolInstruction,
		"",
		`Create a single file called \`${sanitizeName(q.name)}.py\` in the repo root with your complete implementation.`,
		"Include a brief test/demo in an `if __name__ == '__main__':` block that exercises the main functionality and prints results.",
		"Make sure the code actually runs without errors.",
	].join("\n");

	console.log(`\n[${index}] ${q.name} (${mode})`);
	console.log(`  Worktree: ${wt}`);
	console.log(`  Launching Sonnet...`);

	const { stdout, exitCode } = await runClaude(
		[
			"-w",
			wt,
			"--model",
			SONNET,
			"-p",
			prompt,
			"--allowedTools",
			"Edit,Write,Bash,Read,Glob,Grep,mcp__claude_ai_wikisearch__search_wikipedia",
		],
		600_000,
	);

	const codePath = `.claude/worktrees/${wt}/${sanitizeName(q.name)}.py`;
	console.log(`  Sonnet exit code: ${exitCode}`);
	console.log(`  Code path: ${codePath}`);

	// Save stdout log
	const logDir = `${import.meta.dir}/../../logs`;
	await mkdir(logDir, { recursive: true });
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_sonnet.log`, stdout);

	return {
		algorithm: q.name,
		mode,
		worktree: wt,
		branch: `worktree-${wt}`,
		codePath,
		stdout,
		exitCode,
	};
}

// --- Evaluation step (Opus) ---

async function evaluate(index: number, worktreePath: string, mode: string): Promise<GradeResult> {
	const q = QUESTIONS[index]!;
	const pyFile = `${sanitizeName(q.name)}.py`;

	const prompt = [
		`You are evaluating a Python implementation of ${q.name}.`,
		"",
		`1. Read the file \`${pyFile}\` in the current directory.`,
		`2. Try to run it with \`python3 ${pyFile}\` and observe the output.`,
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

	// Run Opus in the worktree directory (cd into it, no -w flag)
	const wtDir = `${process.cwd()}/.claude/worktrees/${worktreePath}`;
	const { stdout, exitCode } = await runClaude(
		[
			"--model",
			OPUS,
			"-p",
			prompt,
			"--cwd",
			wtDir,
			"--allowedTools",
			"Edit,Write,Bash,Read,Glob,Grep",
		],
		600_000,
	);

	// Save Opus log
	const logDir = `${import.meta.dir}/../../logs`;
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_opus.log`, stdout);

	console.log(`  Opus exit code: ${exitCode}`);

	// Parse grade from Opus output
	return parseGradeFromOutput(stdout);
}

export function parseGradeFromOutput(output: string): GradeResult {
	// Look for JSON block in the output
	const jsonMatch = output.match(/\{[^{}]*"correctness"\s*:\s*\d+[^{}]*\}/s);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				correctness: Number(parsed.correctness) || 1,
				helpfulness: Number(parsed.helpfulness) || 1,
				elegance: Number(parsed.elegance) || 1,
				completion: Number(parsed.completion) || 1,
				ran_successfully: Boolean(parsed.ran_successfully),
				notes: String(parsed.notes ?? ""),
			};
		} catch {
			// fall through
		}
	}

	// Regex fallback
	const get = (key: string) => {
		const m = output.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
		return m?.[1] ? Number.parseInt(m[1], 10) : 1;
	};
	const ranMatch = output.match(/"ran_successfully"\s*:\s*(true|false)/);

	return {
		correctness: get("correctness"),
		helpfulness: get("helpfulness"),
		elegance: get("elegance"),
		completion: get("completion"),
		ran_successfully: ranMatch?.[1] === "true",
		notes: "",
	};
}

// --- Run single algorithm end-to-end ---

async function runOne(
	index: number,
	useTool: boolean,
): Promise<{ run: RunResult; grade: GradeResult }> {
	const implResult = await implement(index, useTool);
	const gradeResult = await evaluate(index, implResult.worktree, implResult.mode);

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
	console.log("Implementation Benchmark — Full Run (Claude Code Headless)");
	console.log(`Implement: Sonnet | Evaluate: Opus`);
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
				worktree: run.worktree,
				grade: g,
				total,
			});

			rows.push([
				q.name,
				run.mode,
				run.worktree,
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
		"worktree",
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
		`  With tool:  mean score ${mean(withTool, 7).toFixed(1)}/40, ran ok ${withTool.filter((r) => r[8] === "true").length}/${withTool.length}`,
	);
	console.log(
		`  No tool:    mean score ${mean(noTool, 7).toFixed(1)}/40, ran ok ${noTool.filter((r) => r[8] === "true").length}/${noTool.length}`,
	);
}

// --- Evaluate existing worktree ---

async function evalExisting(index: number): Promise<void> {
	const q = QUESTIONS[index]!;
	// Try with-tool worktree first, then no-tool
	for (const mode of ["with-tool", "no-tool"]) {
		const wt = worktreeName(q.name, mode);
		const wtDir = `${process.cwd()}/.claude/worktrees/${wt}`;
		try {
			const dir = Bun.file(`${wtDir}/${sanitizeName(q.name)}.py`);
			if (await dir.exists()) {
				console.log(`Found ${mode} worktree: ${wt}`);
				const g = await evaluate(index, wt, mode);
				const total = g.correctness + g.helpfulness + g.elegance + g.completion;
				console.log(`\n  Correctness: ${g.correctness}/10`);
				console.log(`  Helpfulness: ${g.helpfulness}/10`);
				console.log(`  Elegance:    ${g.elegance}/10`);
				console.log(`  Completion:  ${g.completion}/10`);
				console.log(`  Total:       ${total}/40`);
				console.log(`  Ran:         ${g.ran_successfully}`);
				if (g.notes) console.log(`  Notes: ${g.notes}`);
				return;
			}
		} catch {
			// try next mode
		}
	}
	console.error(`No worktree found for "${q.name}". Run it first.`);
}

// --- CLI ---

function printUsage() {
	console.log("Implementation Benchmark — Claude Code Headless");
	console.log("");
	console.log("  Sonnet implements algorithms in isolated worktrees.");
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
	console.log(
		"  bun run src/evals/impl_bench.ts eval <index>             — re-evaluate existing worktree with Opus",
	);
	console.log("");
	console.log(`Algorithms (${QUESTIONS.length}):`);
	for (let i = 0; i < QUESTIONS.length; i++) {
		console.log(`  ${String(i).padStart(2)}. ${QUESTIONS[i]!.name}`);
	}
	console.log("");
	console.log("Worktrees created at: .claude/worktrees/impl-<algorithm>-<mode>/");
	console.log("Logs saved to: logs/impl_bench_<algorithm>_<mode>_{sonnet,opus}.log");
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
	} else if (command === "eval") {
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
		await evalExisting(index);
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
