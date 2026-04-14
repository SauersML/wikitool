#!/usr/bin/env bun
// Run all automated evals sequentially.
// Usage: bun run src/evals/run_all.ts
//
// Pass --parallel to run evals concurrently.
// All evals use the Claude Agent SDK (no direct CLI dependency).

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
	"impl_bench",
];

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

async function main() {
	const parallel = process.argv.includes("--parallel");
	console.log(`\nRunning ${EVALS.length} evals ${parallel ? "in parallel" : "sequentially"}...\n`);
	console.log("(All evals use the Claude Agent SDK — ensure ANTHROPIC_API_KEY is set)\n");

	const start = performance.now();
	let results: { name: string; exitCode: number; durationMs: number }[];

	if (parallel) {
		results = await Promise.all(EVALS.map(runEval));
	} else {
		results = [];
		for (const name of EVALS) {
			console.log(`\n${"=".repeat(60)}`);
			console.log(`  ${name}`);
			console.log("=".repeat(60));
			results.push(await runEval(name));
		}
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
