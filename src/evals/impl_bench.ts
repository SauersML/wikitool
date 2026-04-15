// Implementation Benchmark — uses Agent SDK with local Bash/Write/Read tools
//
// Flow per algorithm:
//   1. IMPL_MODEL (Haiku 4.5) implements the algorithm — Read/Write/Bash always
//      enabled. The "with-tool" mode additionally exposes the wiki MCP tool AND
//      prepends the shared wiki sysprompt; "no-tool" mode is bare task framing.
//   2. EVAL_MODEL (Opus 4.6) reads the code, runs it locally, grades on rubric.
//
// Usage:
//   bun run src/evals/impl_bench.ts                       — print usage info
//   bun run src/evals/impl_bench.ts run <index>           — with tool (default)
//   bun run src/evals/impl_bench.ts run <index> --no-tool — without tool
//   bun run src/evals/impl_bench.ts all                   — run all 20 in both modes

import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	createSeenContent,
	createWikiMcpServer,
	extractJson,
	initEvalSession,
	pairedPermutationTest,
	parseResumeArg,
	reportStyleControlledHeadline,
	runAgent,
	runKey,
	type StyleControlPair,
	WIKI_TOOL_NAME,
} from "./utils";

// with-tool uses the production sysprompt (which is wiki-centric — describes
// the search_wikipedia tool, cross-checking, citation behaviour). The wiki MCP
// is also registered so the model can actually call the tool.
//
// no-tool uses NO system prompt at all. The production sysprompt is built
// around having the wiki tool — passing it to a model that doesn't have the
// tool would either confuse it or cue it to behave as if the tool existed.
//
// Both modes always get Read/Write/Bash because the implement step needs them.
// Task framing (which file to write, iterate, etc.) lives in the user prompt.
const SYSTEM_PROMPT = SHARED_SYSTEM_PROMPT;
const NO_TOOL_SYSTEM_PROMPT: string | undefined = undefined;

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
	/** True if ANY tool was called. Bash/Read/Write are always available here,
	 *  so this is effectively always true and does NOT indicate the wiki tool
	 *  specifically was used — see `usedWikiTool` for that signal. */
	usedTool: boolean;
	/** True iff the wiki MCP tool was invoked at least once — the meaningful
	 *  signal for whether with-tool actually used the tool. */
	usedWikiTool: boolean;
	/** Number of wiki tool calls made. */
	wikiCallCount: number;
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

/** Find the last Python-ish (or any) fenced code block in a string.
 *  Accepts `python`, `py`, `python3`, `Python`, `PY`, etc. — the implementer
 *  model sometimes forgets the exact tag and drops into `py` / `python3`. */
function lastCodeBlock(text: string): string | null {
	// Normalise CRLF so \n-anchored scans don't skip closing fences coming from
	// agent outputs that carry Windows-style line endings (rare but has happened).
	const src = text.replace(/\r\n/g, "\n");

	let lastPython: string | null = null;
	let lastAny: string | null = null;
	let searchFrom = 0;

	while (true) {
		const fenceStart = src.indexOf("```", searchFrom);
		if (fenceStart === -1) break;

		// Opening fence tag runs until end-of-line (or end-of-string for a
		// malformed unterminated opener).
		const lineEnd = src.indexOf("\n", fenceStart);
		if (lineEnd === -1) break;

		const fenceTag = src
			.slice(fenceStart + 3, lineEnd)
			.trim()
			.toLowerCase();

		// Closing fence: ``` at start of a line. Accept either preceded by \n
		// OR positioned at the final three chars of the text (model omitted the
		// trailing newline after its last fence). Also skip any re-opening
		// (fence immediately followed by a tag on the same line) as a candidate
		// closer — real closers have nothing after them on that line.
		let fenceClose = -1;
		let scan = lineEnd + 1;
		while (scan < src.length) {
			const hit = src.indexOf("```", scan);
			if (hit === -1) break;
			const prevChar = src[hit - 1];
			const afterEnd = src.indexOf("\n", hit + 3);
			const afterSlice = (
				afterEnd === -1 ? src.slice(hit + 3) : src.slice(hit + 3, afterEnd)
			).trim();
			if ((prevChar === "\n" || hit === 0) && afterSlice === "") {
				fenceClose = hit;
				break;
			}
			scan = hit + 3;
		}

		if (fenceClose === -1) {
			// Unterminated block — stop; later fences (if any) would be inside this one.
			break;
		}

		const content = src.slice(lineEnd + 1, fenceClose).replace(/\n+$/, "");
		const isPython = fenceTag === "python" || fenceTag === "py" || fenceTag === "python3";
		if (isPython) lastPython = content;
		else if (fenceTag === "") lastAny = content;
		// other tags (e.g. ```text, ```bash) are ignored — not candidate code.

		searchFrom = fenceClose + 3;
	}

	return lastPython ?? lastAny;
}

/**
 * Extract Python code from the agent result.
 * Scans the final answer then all assistant text blocks (latest-first) for the
 * last fenced code block. Returns the raw answer only as a last resort — this
 * will fail downstream Python execution but preserves evidence for the grader.
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

// --- Implementation step (IMPL_MODEL via Agent SDK + Bash/Write) ---

async function implement(index: number, useTool: boolean): Promise<RunResult> {
	const q = QUESTIONS[index]!;
	const mode = useTool ? "with-tool" : "no-tool";
	const workDir = await mkdtemp(join(tmpdir(), `impl-${sanitizeName(q.name)}-`));

	// Task framing lives in the USER prompt (not the system prompt) so that the
	// system prompt is held constant across modes — see the SYSTEM_PROMPT
	// comment above. Both modes get the same user prompt; the only behavioural
	// difference comes from whether the wiki MCP tool is registered.
	const prompt = [
		"You are implementing an algorithm in Python.",
		"",
		q.prompt,
		"",
		`Create a single file called \`${sanitizeName(q.name)}.py\` with your complete implementation.`,
		"Include a test/demo in an `if __name__ == '__main__':` block that exercises the main functionality and prints results.",
		"Write the file, then run it to make sure it works without errors.",
		"",
		"IMPORTANT: After you are done, output the complete final Python code in your response as a single ```python fenced code block.",
	].join("\n");

	const tag = `[${index}][${mode}]`;
	console.log(`${tag} ${q.name} — launching implementer...`);

	const builtinTools = ["Read", "Write", "Bash"];
	const allowedTools = ["Read", "Write", "Bash"];
	const mcpServers: Record<string, ReturnType<typeof createWikiMcpServer>> = {};

	if (useTool) {
		mcpServers.wiki = createWikiMcpServer({ seen: createSeenContent() });
		allowedTools.push(WIKI_TOOL_NAME);
	}

	const result = await runAgent({
		system: useTool ? SYSTEM_PROMPT : NO_TOOL_SYSTEM_PROMPT,
		prompt,
		model: IMPL_MODEL,
		builtinTools,
		allowedTools,
		mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
		cwd: workDir,
		maxTurns: 50,
	});

	const code = extractCode(result.answer, result.assistantTexts);
	const wikiCalls = result.toolCalls.filter((tc) => tc.name === WIKI_TOOL_NAME).length;

	console.log(
		`${tag} implementer done: ${result.turns} turns, wiki_calls=${wikiCalls}, any_tool=${result.usedTool}`,
	);

	// Save logs — full conversation, not just final answer
	const logDir = `${import.meta.dir}/../../logs`;
	await mkdir(logDir, { recursive: true });
	const fullLog = JSON.stringify(
		{
			algorithm: q.name,
			mode,
			turns: result.turns,
			usedTool: result.usedTool,
			usedWikiTool: result.usedWikiTool,
			wikiCallCount: wikiCalls,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			durationMs: result.durationMs,
			costUsd: result.costUsd,
			toolCalls: result.toolCalls,
			assistantTexts: result.assistantTexts,
			answer: result.answer,
		},
		null,
		2,
	);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_impl.json`, fullLog);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_code.py`, code);

	return {
		algorithm: q.name,
		mode,
		code,
		turns: result.turns,
		usedTool: result.usedTool,
		usedWikiTool: result.usedWikiTool,
		wikiCallCount: wikiCalls,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
	};
}

// --- Evaluation step (Opus via Agent SDK + Read/Write/Bash) ---

async function evaluate(index: number, code: string, mode: string): Promise<GradeResult> {
	const q = QUESTIONS[index]!;
	const tag = `[${index}][${mode}]`;
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
		"5. Grade the implementation on this rubric. Each score is an INTEGER from 1 (worst) to 10 (best):",
		"   - CORRECTNESS: Does it implement the algorithm correctly? Would it produce correct results on all valid inputs?",
		"   - HELPFULNESS: Good docstrings, comments, examples? Clean, usable API?",
		"   - ELEGANCE: Well-structured, Pythonic, avoids unnecessary complexity?",
		"   - COMPLETION: Is the implementation complete? Edge cases handled?",
		"   - ran_successfully: boolean — true iff `python3` executed the file without raising an uncaught exception.",
		"",
		"After your analysis, output EXACTLY one JSON block as the LAST thing in your response, with real integer",
		"values substituted in (do NOT leave the letter N or any placeholder in place). Example format:",
		"```json",
		'{"correctness": 7, "helpfulness": 6, "elegance": 8, "completion": 7, "ran_successfully": true, "notes": "brief explanation of what works and what is broken"}',
		"```",
	].join("\n");

	console.log(`${tag} launching evaluator...`);

	const result = await runAgent({
		prompt,
		model: EVAL_MODEL,
		builtinTools: ["Read", "Write", "Bash"],
		mcpServers: { wiki: createWikiMcpServer({ seen: createSeenContent() }) },
		allowedTools: ["Read", "Write", "Bash", WIKI_TOOL_NAME],
		cwd: workDir,
		maxTurns: 50,
	});

	// Save Opus log — full conversation
	const logDir = `${import.meta.dir}/../../logs`;
	const fullLog = JSON.stringify(
		{
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
		},
		null,
		2,
	);
	await Bun.write(`${logDir}/impl_bench_${sanitizeName(q.name)}_${mode}_eval.json`, fullLog);

	console.log(`${tag} evaluator done: ${result.turns} turns`);

	// The final assistant message is the grader's canonical output, but if the
	// model dumps its JSON mid-reasoning and trails off with prose, the fenced
	// block may only live in an earlier assistant text. Try answer first, then
	// fall back to later-to-earlier assistant texts before giving up.
	try {
		return parseGradeFromOutput(result.answer);
	} catch (e) {
		for (let i = result.assistantTexts.length - 1; i >= 0; i--) {
			try {
				return parseGradeFromOutput(result.assistantTexts[i]!);
			} catch {
				// keep scanning
			}
		}
		throw e;
	}
}

// --- Grade parsing ---

/** Coerce a rubric score field to an integer in [1, 10] or NaN.
 *  Handles numbers, numeric strings, "8/10", and rejects the placeholder "N". */
function coerceScore(raw: unknown): number {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : Number.NaN;
	if (typeof raw !== "string") return Number.NaN;
	const s = raw.trim();
	if (!s || /^n$/i.test(s)) return Number.NaN;
	// Accept "8", "8.0", "8/10", "8 / 10" — take the first number.
	const m = s.match(/-?\d+(?:\.\d+)?/);
	if (!m) return Number.NaN;
	const n = Number.parseFloat(m[0]);
	return Number.isFinite(n) ? n : Number.NaN;
}

/** Coerce ran_successfully: accept native booleans and common string variants. */
function coerceBool(raw: unknown): boolean {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") return /^(true|yes|y|1|pass|passed|ok)$/i.test(raw.trim());
	return false;
}

export function parseGradeFromOutput(output: string): GradeResult {
	const parsed = extractJson(output);
	if (!parsed || !("correctness" in parsed))
		throw new Error(`No grade JSON found in output (${output.length} chars)`);
	const correctness = coerceScore(parsed.correctness);
	const helpfulness = coerceScore(parsed.helpfulness);
	const elegance = coerceScore(parsed.elegance);
	const completion = coerceScore(parsed.completion);
	if ([correctness, helpfulness, elegance, completion].some((n) => Number.isNaN(n))) {
		throw new Error(`Grade JSON has non-numeric fields: ${JSON.stringify(parsed).slice(0, 200)}`);
	}
	// Clamp to the rubric's [1, 10] range. Graders occasionally emit 0 (meant as
	// "broken") or 11/100 (misread scale) — snap back rather than propagate an
	// out-of-range score that skews the aggregate means.
	const clamp = (n: number) => Math.max(1, Math.min(10, n));
	const notesRaw = parsed.notes;
	return {
		correctness: clamp(correctness),
		helpfulness: clamp(helpfulness),
		elegance: clamp(elegance),
		completion: clamp(completion),
		ran_successfully: coerceBool(parsed.ran_successfully),
		notes: notesRaw == null ? "" : String(notesRaw),
	};
}

// --- Run single algorithm end-to-end ---

async function runOne(
	index: number,
	useTool: boolean,
): Promise<{ run: RunResult; grade: GradeResult }> {
	const mode = useTool ? "with-tool" : "no-tool";
	const tag = `[${index}][${mode}]`;
	const implResult = await implement(index, useTool);
	const gradeResult = await evaluate(index, implResult.code, implResult.mode);

	const total =
		gradeResult.correctness +
		gradeResult.helpfulness +
		gradeResult.elegance +
		gradeResult.completion;

	console.log(
		`${tag} grade: correctness=${gradeResult.correctness} helpfulness=${gradeResult.helpfulness} elegance=${gradeResult.elegance} completion=${gradeResult.completion} total=${total}/40 ran_ok=${gradeResult.ran_successfully}`,
	);
	if (gradeResult.notes) console.log(`${tag} notes: ${gradeResult.notes}`);

	return { run: implResult, grade: gradeResult };
}

// --- Run all ---

async function runAll(): Promise<void> {
	console.log("Implementation Benchmark — Agent SDK + local Bash/Write/Read");
	console.log(`Implement: ${IMPL_MODEL} | Evaluate: ${EVAL_MODEL}`);
	console.log(`Algorithms: ${QUESTIONS.length}`);
	console.log(`Modes: with-tool, no-tool`);
	console.log("");

	const headers = [
		"algorithm",
		"mode",
		"correctness",
		"helpfulness",
		"elegance",
		"completion",
		"total_score",
		"ran_successfully",
		"used_wiki_tool",
		"wiki_call_count",
		"notes",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "impl_bench",
		headers,
		resume,
	});
	console.log(`Log: ${logPath}\n`);
	await log({
		event: "start",
		eval: "impl_bench",
		impl_model: IMPL_MODEL,
		eval_model: EVAL_MODEL,
		n_algorithms: QUESTIONS.length,
		modes: ["with-tool", "no-tool"],
		resumed_from: resume ?? null,
	});

	// Build every (algorithm × mode) job, then fan them all out concurrently.
	// Each job runs its own implement→evaluate chain sequentially; only the
	// across-job work is parallelised. Per-job errors are captured and logged
	// so a single failure (or mid-batch credit exhaustion) doesn't nuke the rest.
	type JobResult =
		| { ok: true; index: number; useTool: boolean; run: RunResult; grade: GradeResult }
		| { ok: false; index: number; useTool: boolean; error: string };

	const allJobs: { index: number; useTool: boolean }[] = [];
	for (let i = 0; i < QUESTIONS.length; i++) {
		for (const useTool of [true, false]) allJobs.push({ index: i, useTool });
	}

	// Skip any (algorithm, mode) pairs already completed in the resume log.
	const jobs = allJobs.filter(
		({ index, useTool }) => !completed.has(runKey(index, useTool ? "with-tool" : "no-tool")),
	);
	const skipped = allJobs.length - jobs.length;
	if (skipped > 0) console.log(`Skipping ${skipped} already-completed jobs from prior run.\n`);

	console.log(`Launching ${jobs.length} jobs in parallel...\n`);

	// Stream per-job log+TSV writes AS jobs finish (not at the end of the
	// batch). With 40 parallel jobs that can each take 5+ minutes, batching
	// at the end means the log/TSV stay empty until the slowest completes.
	// Streaming gives live progress and preserves work if the batch is killed.
	// `writeMutex` serialises file appends so concurrent Promise.all writes
	// don't interleave bytes inside a single line.
	const rows: string[][] = [...resumedRows];
	let writeMutex = Promise.resolve();
	const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
		const out = writeMutex.then(fn);
		writeMutex = out.then(
			() => undefined,
			() => undefined,
		);
		return out;
	};
	let completedCount = 0;
	const totalJobs = jobs.length;

	const settled: JobResult[] = await Promise.all(
		jobs.map(async ({ index, useTool }): Promise<JobResult> => {
			const mode = useTool ? "with-tool" : "no-tool";
			try {
				const { run, grade } = await runOne(index, useTool);
				const q = QUESTIONS[index]!;
				const total = grade.correctness + grade.helpfulness + grade.elegance + grade.completion;
				const row: string[] = [
					q.name,
					run.mode,
					String(grade.correctness),
					String(grade.helpfulness),
					String(grade.elegance),
					String(grade.completion),
					String(total),
					String(grade.ran_successfully),
					String(run.usedWikiTool),
					String(run.wikiCallCount),
					grade.notes,
				];
				await serialise(async () => {
					await log({
						event: "run",
						timestamp: new Date().toISOString(),
						index,
						mode: run.mode,
						algorithm: q.name,
						used_tool: run.usedTool,
						used_wiki_tool: run.usedWikiTool,
						wiki_call_count: run.wikiCallCount,
						turns: run.turns,
						input_tokens: run.inputTokens,
						output_tokens: run.outputTokens,
						grade,
						total,
						tsv_row: row,
					});
					await appendRow(row);
					rows.push(row);
					completedCount++;
					console.log(
						`[${completedCount}/${totalJobs}] ✓ [${index}][${mode}] ${q.name}: total=${total}/40 ran_ok=${grade.ran_successfully} wiki=${run.wikiCallCount}`,
					);
				});
				return { ok: true, index, useTool, run, grade };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				console.error(`[${index}][${mode}] FAILED: ${message}`);
				await serialise(() =>
					log({
						event: "error",
						timestamp: new Date().toISOString(),
						index,
						mode,
						error: message,
						...(stack ? { stack } : {}),
					}),
				);
				return { ok: false, index, useTool, error: message };
			}
		}),
	);

	const failures = settled.filter((r): r is Extract<JobResult, { ok: false }> => !r.ok);
	if (failures.length > 0) {
		console.log(`\n${failures.length}/${settled.length} jobs failed:`);
		for (const f of failures) {
			console.log(`  [${f.index}][${f.useTool ? "with-tool" : "no-tool"}] ${f.error}`);
		}
		console.log(`\nResume with: --resume ${logPath}\n`);
	}

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

	// Style-controlled rubric breakdown. The wiki sysprompt's anti-markdown
	// clause hits this eval harder than any other (Opus rubric grader rewards
	// structured prose, with-tool delivers plainer prose). We load the saved
	// implementer transcripts from logs/impl_bench_<algorithm>_<mode>_impl.json
	// (the TSV doesn't carry the prose) and report style-controlled deltas for
	// each rubric dimension. TSV cols: 0=algorithm, 2=correctness, 3=helpfulness,
	// 4=elegance, 5=completion, 6=total_score.
	{
		const logDir = `${import.meta.dir}/../../logs`;
		const proseFor = async (algorithm: string, mode: string): Promise<string> => {
			const file = `${logDir}/impl_bench_${sanitizeName(algorithm)}_${mode}_impl.json`;
			try {
				const d = JSON.parse(await Bun.file(file).text());
				const all = ((d.assistantTexts ?? []).join("\n") as string) + "\n" + (d.answer ?? "");
				return all.replace(/```[\s\S]*?```/g, "");
			} catch {
				return "";
			}
		};
		const buildPairs = async (scoreCol: number): Promise<StyleControlPair[]> => {
			const out: StyleControlPair[] = [];
			for (const wt of withTool) {
				const nt = noTool.find((r) => r[0] === wt[0]);
				if (!nt) continue;
				const [withText, noText] = await Promise.all([
					proseFor(wt[0]!, "with-tool"),
					proseFor(wt[0]!, "no-tool"),
				]);
				out.push({
					withScore: Number(wt[scoreCol]),
					noScore: Number(nt[scoreCol]),
					withText,
					noText,
				});
			}
			return out;
		};
		for (const [name, col] of [
			["correctness", 2],
			["helpfulness", 3],
			["elegance", 4],
			["completion", 5],
			["total_score", 6],
		] as const) {
			await reportStyleControlledHeadline({
				label: `impl_bench: ${name}`,
				pairs: await buildPairs(col),
				log,
			});
		}
	}

	console.log(`\n  Log: ${logPath}`);
	console.log(`  TSV: ${tsvPath}`);
}

// --- CLI ---

function printUsage() {
	console.log("Implementation Benchmark — Agent SDK + local Bash/Write/Read");
	console.log("");
	console.log(`  ${IMPL_MODEL} implements algorithms using local file and bash tools.`);
	console.log(`  ${EVAL_MODEL} evaluates: reads code, runs it, writes tests, grades on rubric.`);
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
	console.log("Logs saved to: logs/impl_bench_<algorithm>_<mode>_{impl,eval}.json");
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
