#!/usr/bin/env bun
// Run all automated evals.
//
// Usage:
//   bun run src/evals/run_all.ts                    sequentially (one eval at a time)
//   bun run src/evals/run_all.ts --parallel         all evals concurrently
//   bun run src/evals/run_all.ts --parallel=N       at most N eval processes at once
//
// Concurrency note: each eval child process has its OWN per-process semaphore
// (RUNAGENT_CONCURRENCY, default 6). With --parallel, peak in-flight Anthropic
// calls across the suite is `evalProcesses × RUNAGENT_CONCURRENCY`. To stay
// under the org token-rate cap (~90k tok/min for Haiku 4.5 in our setup) we
// cap eval-process concurrency at MAX_EVAL_PROCESSES below — by default 3,
// so ≤ 18 concurrent calls. Override with --parallel=N or env
// RUN_ALL_MAX_PARALLEL=N.
//
// Why not a true cross-process global semaphore? The Anthropic SDK already
// retries 429s, and runAgent retries+throws on credit/auth/timeout errors,
// so the eval-process cap below is a sufficient safety net. A fully shared
// token server (TCP/Unix socket) would tighten the bound but adds failure
// modes. Re-evaluate if you push concurrency higher.

import { spawn } from "node:child_process";

const EVALS = [
	"incorrect_info",
	"qa_precise",
	"hle_sauers",
	"qa_private",
	"obscure_info",
	"good_recency",
	"bad_recency",
	"ccp_bench",
	"unnecessary_tool",
	"wiki_trivia",
	"behavioral_suite",
	"impl_bench",
];

const DEFAULT_MAX_EVAL_PROCESSES = Math.max(
	1,
	Number.parseInt(process.env["RUN_ALL_MAX_PARALLEL"] ?? "3", 10),
);

function runEval(name: string): Promise<{ name: string; exitCode: number; durationMs: number }> {
	return new Promise((resolve) => {
		const start = performance.now();
		const args = name === "impl_bench" ? [`src/evals/${name}.ts`, "all"] : [`src/evals/${name}.ts`];
		const proc = spawn("bun", args, {
			stdio: "inherit",
			env: { ...process.env },
		});
		proc.on("close", (code) => {
			resolve({ name, exitCode: code ?? 1, durationMs: performance.now() - start });
		});
	});
}

/** Run `tasks` with at most `maxConcurrent` in flight. Preserves order in result. */
async function runWithLimit<T>(tasks: (() => Promise<T>)[], maxConcurrent: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const workers: Promise<void>[] = [];
	for (let w = 0; w < Math.min(maxConcurrent, tasks.length); w++) {
		workers.push(
			(async () => {
				while (true) {
					const i = next++;
					if (i >= tasks.length) return;
					results[i] = await tasks[i]!();
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

/** Parse `--parallel`, `--parallel=N`, or "fully sequential" from argv. */
function parseConcurrency(argv: string[], totalEvals: number): number {
	for (const a of argv) {
		if (a === "--parallel") return Math.min(totalEvals, DEFAULT_MAX_EVAL_PROCESSES);
		const m = a.match(/^--parallel=(\d+)$/);
		if (m) return Math.max(1, Math.min(totalEvals, Number.parseInt(m[1]!, 10)));
	}
	return 1; // fully sequential
}

async function main() {
	const concurrency = parseConcurrency(process.argv, EVALS.length);
	const mode =
		concurrency === 1
			? "sequentially"
			: concurrency >= EVALS.length
				? "in parallel (all)"
				: `in parallel (${concurrency} at a time)`;
	console.log(`\nRunning ${EVALS.length} evals ${mode}...`);
	console.log(
		`(per-eval RUNAGENT_CONCURRENCY=${process.env["RUNAGENT_CONCURRENCY"] ?? "6"}; peak in-flight ≈ ${concurrency * Number.parseInt(process.env["RUNAGENT_CONCURRENCY"] ?? "6", 10)})`,
	);
	console.log("(Ensure ANTHROPIC_API_KEY is set)\n");

	const start = performance.now();
	let results: { name: string; exitCode: number; durationMs: number }[];

	if (concurrency === 1) {
		results = [];
		for (const name of EVALS) {
			console.log(`\n${"=".repeat(60)}`);
			console.log(`  ${name}`);
			console.log("=".repeat(60));
			results.push(await runEval(name));
		}
	} else {
		results = await runWithLimit(
			EVALS.map((name) => () => runEval(name)),
			concurrency,
		);
	}

	const totalMs = performance.now() - start;

	console.log(`\n${"=".repeat(60)}`);
	console.log("  ALL EVALS COMPLETE");
	console.log("=".repeat(60));
	for (const r of results) {
		const status = r.exitCode === 0 ? "PASS" : "FAIL";
		console.log(`  ${status}  ${r.name.padEnd(20)} ${(r.durationMs / 1000).toFixed(1)}s`);
	}
	const failed = results.filter((r) => r.exitCode !== 0);
	console.log(
		`\n  ${results.length - failed.length}/${results.length} passed in ${(totalMs / 1000).toFixed(1)}s`,
	);
	if (failed.length > 0) {
		console.log(`  Failed: ${failed.map((r) => r.name).join(", ")}`);
		process.exit(1);
	}
}

main();
