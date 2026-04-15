#!/usr/bin/env bun
/**
 * replicate.ts — multi-replicate wrapper for evals (Category E: power).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Design note / tradeoffs
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Our evals are underpowered for many effects: on 12–20 questions with a
 * paired design, a real 5–10 percentage-point gap between with-tool and
 * without-tool often fails to reach p < 0.05 simply because the null
 * distribution of the permutation test is too coarse. There are two axes
 * we can grow on:
 *
 *   (A) k — replicates of the same question set.
 *        Each replicate rolls a fresh sample of the model (non-zero
 *        temperature OR the same prompt with different session state),
 *        averaging out trial-level stochastic noise on a per-question
 *        basis. This shrinks the *within-question* variance of our
 *        correctness estimate.
 *
 *   (B) n — number of distinct questions.
 *        Each new question is an independent draw from the question
 *        distribution. This shrinks the *between-question* variance and
 *        is the only axis that increases power on question-level
 *        inference (i.e. "does the tool help on THIS distribution of
 *        questions?").
 *
 * Why k = 3 is usually the sweet spot:
 *   - Variance of the sample mean over k replicates is σ²/k. Going from
 *     k=1 → k=3 cuts SEM by 1/√3 ≈ 42%. Going from k=3 → k=10 only
 *     buys another ~45% on top of that, at >3× the cost.
 *   - With k=3 you can compute a per-question sample variance (needs
 *     k ≥ 2) *and* have one degree of freedom left over, so the
 *     estimate is not Heisenberg-fragile.
 *   - Cost scales linearly in k, so k=3 is a 3× budget multiplier —
 *     typically palatable. k=5 starts to compete with just adding more
 *     questions.
 *
 * Why replicates alone don't solve power problems:
 *   - Same questions means same systematic difficulty structure. If the
 *     tool genuinely helps on a narrow subset of questions, replicating
 *     those same questions won't change that subset's size — you just
 *     measure the same effect more precisely.
 *   - Per-question correctness outcomes are CORRELATED across replicates
 *     (a hard question stays hard). Averaging replicates reduces the
 *     trial-noise component but the question-level noise floor remains.
 *   - Paired permutation tests on per-question averaged outcomes use n
 *     (not n·k) as the pairing cardinality. Replicates sharpen each
 *     cell but do not add pairs. So p-values are bounded by the
 *     minimum achievable under the sign-flip null, which is 2 / 2ⁿ.
 *
 * Recommendation:
 *   - For evals where the expected effect is strong (e.g. obscure_info,
 *     wiki_trivia): prioritise n ≥ 30 distinct questions over k ≥ 3.
 *   - For evals where runs are very noisy but the question set is
 *     already wide (hle_sauers): k = 3 is well spent.
 *   - Never use k > 1 with n < 10; you're over-fitting precision to
 *     too few pairs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Wrapper behaviour
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   bun src/evals/replicate.ts <eval_name> <k>
 *
 *   - Launches `bun src/evals/<eval_name>.ts` k times sequentially.
 *   - Each child uses its own `initEvalSession` → fresh timestamped log
 *     and fresh TSV, unmodified.
 *   - After each child exits cleanly, we locate the newly-created TSV
 *     (diffing the results dir snapshot), read its rows, tag each with
 *     `replicate_idx` (0-indexed), and append to the combined TSV.
 *   - On first replicate we also write the original TSV header plus an
 *     appended `replicate_idx` column.
 *   - Any non-zero child exit aborts; we report which replicate failed.
 *
 *   Combined file:
 *     src/evals/results/<eval_name>_v<N>_k<k>_combined.tsv
 *   where N auto-increments to avoid clobbering.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pairedPermutationTest } from "./utils.ts";

const RESULTS_DIR = `${import.meta.dir}/results`;

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface ReplicateResult {
	evalName: string;
	k: number;
	combinedTsvPath: string;
	perReplicateTsvs: string[];
	totalRows: number;
}

/**
 * Run an eval k times sequentially, merging each child's TSV into a
 * combined TSV with a `replicate_idx` column appended. Returns paths and
 * summary counts. Does NOT grade or analyse — call `analyzeCombinedTsv`
 * for that.
 *
 * @param evalName  basename under src/evals/ (e.g. "wiki_trivia")
 * @param k         number of replicates (must be ≥ 1)
 * @param opts.cwd  working directory for the child (defaults to repo root)
 */
export function runReplicates(
	evalName: string,
	k: number,
	opts: { cwd?: string; extraArgs?: string[] } = {},
): ReplicateResult {
	if (!Number.isInteger(k) || k < 1) {
		throw new Error(`k must be a positive integer, got ${k}`);
	}
	const cwd = opts.cwd ?? `${import.meta.dir}/../..`;
	const extraArgs = opts.extraArgs ?? [];

	const combinedPath = nextCombinedPath(evalName, k);
	const perReplicateTsvs: string[] = [];
	let header: string[] | undefined;
	let totalRows = 0;

	for (let rep = 0; rep < k; rep++) {
		const before = snapshotTsvs(evalName);
		const scriptPath = `src/evals/${evalName}.ts`;
		console.log(
			`[replicate ${rep + 1}/${k}] bun ${scriptPath}${
				extraArgs.length ? " " + extraArgs.join(" ") : ""
			}`,
		);
		const child = spawnSync("bun", [scriptPath, ...extraArgs], {
			cwd,
			stdio: "inherit",
			env: { ...process.env },
		});
		if (child.status !== 0) {
			throw new Error(
				`replicate ${rep} of ${evalName} exited with code ${child.status} ` +
					`(signal=${String(child.signal)}). Combined output partial at ${combinedPath}.`,
			);
		}
		const after = snapshotTsvs(evalName);
		const newTsvs = [...after].filter((p) => !before.has(p));
		if (newTsvs.length === 0) {
			throw new Error(
				`replicate ${rep}: child exited cleanly but no new TSV appeared ` +
					`in ${RESULTS_DIR}. Did the eval write results?`,
			);
		}
		if (newTsvs.length > 1) {
			// Take the newest by sorted filename (timestamp suffix sorts lexically).
			newTsvs.sort();
		}
		const childTsv = newTsvs[newTsvs.length - 1]!;
		perReplicateTsvs.push(childTsv);

		const merged = mergeReplicateInto(childTsv, combinedPath, rep, header);
		header = merged.header;
		totalRows += merged.rowsAppended;
	}

	return {
		evalName,
		k,
		combinedTsvPath: combinedPath,
		perReplicateTsvs,
		totalRows,
	};
}

export interface PerQuestionStat {
	questionKey: string;
	mode: string;
	nReplicates: number;
	mean: number;
	std: number;
}

export interface CombinedAnalysis {
	nQuestions: number;
	perQuestion: PerQuestionStat[];
	withToolMean: number;
	withoutToolMean: number;
	diff: number;
	pValue: number;
}

/**
 * Analyse a combined TSV produced by `runReplicates`.
 *
 * - Reports per-question mean ± std of correctness across replicates.
 * - Runs the paired permutation test on per-question averaged correctness
 *   (with-tool mean vs without-tool mean). Uses the existing
 *   `pairedPermutationTest` util (exact when n ≤ 20, else 50k random).
 * - Prints a summary table.
 */
export function analyzeCombinedTsv(path: string): CombinedAnalysis {
	const text = readFileSync(path, "utf-8");
	const lines = text.split("\n").filter((l) => l.length > 0);
	if (lines.length < 2) {
		throw new Error(`combined TSV at ${path} has no data rows`);
	}
	const header = lines[0]!.split("\t");
	const modeIdx = header.indexOf("mode");
	const questionIdx = pickQuestionColumn(header);
	const correctnessIdx = pickCorrectnessColumn(header);
	if (modeIdx < 0 || questionIdx < 0 || correctnessIdx < 0) {
		throw new Error(`combined TSV missing required columns; have [${header.join(", ")}]`);
	}

	// key = questionKey → mode → list of correctness values
	const byQ = new Map<string, Map<string, number[]>>();
	for (let i = 1; i < lines.length; i++) {
		const cols = lines[i]!.split("\t");
		const qKey = cols[questionIdx] ?? "";
		const mode = cols[modeIdx] ?? "";
		const raw = cols[correctnessIdx] ?? "";
		const val = parseCorrectness(raw);
		if (val === undefined) continue;
		let modeMap = byQ.get(qKey);
		if (!modeMap) {
			modeMap = new Map();
			byQ.set(qKey, modeMap);
		}
		let arr = modeMap.get(mode);
		if (!arr) {
			arr = [];
			modeMap.set(mode, arr);
		}
		arr.push(val);
	}

	const perQuestion: PerQuestionStat[] = [];
	const withToolMeans: number[] = [];
	const withoutToolMeans: number[] = [];
	const sortedKeys = [...byQ.keys()].sort();
	for (const q of sortedKeys) {
		const modeMap = byQ.get(q)!;
		for (const mode of [...modeMap.keys()].sort()) {
			const arr = modeMap.get(mode)!;
			const { mean, std } = meanStd(arr);
			perQuestion.push({
				questionKey: q,
				mode,
				nReplicates: arr.length,
				mean,
				std,
			});
		}
		const wt = modeMap.get("with-tool");
		const wo = modeMap.get("without-tool");
		if (wt && wo && wt.length > 0 && wo.length > 0) {
			withToolMeans.push(mean(wt));
			withoutToolMeans.push(mean(wo));
		}
	}

	let pValue = 1;
	let diff = 0;
	if (withToolMeans.length > 0 && withToolMeans.length === withoutToolMeans.length) {
		const res = pairedPermutationTest(withToolMeans, withoutToolMeans);
		pValue = res.p;
		// pairedPermutationTest already returns the MEAN paired difference
		// (observed / n), not the sum — don't divide again.
		diff = res.diff;
	}

	const withToolMean = withToolMeans.length > 0 ? mean(withToolMeans) : Number.NaN;
	const withoutToolMean = withoutToolMeans.length > 0 ? mean(withoutToolMeans) : Number.NaN;

	printSummary({
		path,
		perQuestion,
		nPairs: withToolMeans.length,
		withToolMean,
		withoutToolMean,
		diff,
		pValue,
	});

	return {
		nQuestions: byQ.size,
		perQuestion,
		withToolMean,
		withoutToolMean,
		diff,
		pValue,
	};
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

function nextCombinedPath(evalName: string, k: number): string {
	let n = 1;
	while (existsSync(`${RESULTS_DIR}/${evalName}_v${n}_k${k}_combined.tsv`)) {
		n++;
	}
	return `${RESULTS_DIR}/${evalName}_v${n}_k${k}_combined.tsv`;
}

function snapshotTsvs(evalName: string): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = readdirSync(RESULTS_DIR);
	} catch {
		return out;
	}
	const prefix = `${evalName}_`;
	for (const name of entries) {
		if (name.startsWith(prefix) && name.endsWith(".tsv") && !name.includes("_combined")) {
			out.add(`${RESULTS_DIR}/${name}`);
		}
	}
	return out;
}

/**
 * Read `childTsv`, append its rows (with a trailing `replicate_idx` column)
 * into `combinedPath`. On rep==0 also writes the header. Returns the header
 * used and the row count.
 *
 * Exposed via the `_internal` export for unit testing.
 */
export function mergeReplicateInto(
	childTsv: string,
	combinedPath: string,
	replicateIdx: number,
	existingHeader?: string[],
): { header: string[]; rowsAppended: number } {
	const text = readFileSync(childTsv, "utf-8");
	const lines = text.split("\n");
	// Drop trailing empty line from final "\n", but keep internal blanks
	// untouched (there shouldn't be any — TSV writer sanitises).
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	if (lines.length === 0) {
		throw new Error(`child TSV ${childTsv} is empty`);
	}
	const header = lines[0]!.split("\t");

	if (replicateIdx === 0) {
		const combinedHeader = [...header, "replicate_idx"].join("\t") + "\n";
		writeFileSync(combinedPath, combinedHeader, "utf-8");
	} else if (existingHeader) {
		// Warn (but still append) if headers mismatch — they shouldn't, since
		// the same eval is being re-run.
		if (existingHeader.join("\t") !== header.join("\t")) {
			console.warn(
				`[replicate ${replicateIdx}] header mismatch vs rep 0:\n` +
					`  rep0:  ${existingHeader.join(", ")}\n` +
					`  repN:  ${header.join(", ")}`,
			);
		}
	}

	const body = lines.slice(1);
	let buf = "";
	for (const line of body) {
		buf += `${line}\t${replicateIdx}\n`;
	}
	if (buf.length > 0) appendFileSync(combinedPath, buf, "utf-8");
	return { header, rowsAppended: body.length };
}

function pickQuestionColumn(header: string[]): number {
	// Prefer a stable identifier, then fall back to the full question string.
	const candidates = ["question_id", "question", "prompt", "task_id", "id"];
	for (const c of candidates) {
		const i = header.indexOf(c);
		if (i >= 0) return i;
	}
	return -1;
}

function pickCorrectnessColumn(header: string[]): number {
	// Many evals use `is_correct`; `ccp_bench` uses `score_0_100`.
	const candidates = ["is_correct", "correct", "score_0_100", "score", "grade"];
	for (const c of candidates) {
		const i = header.indexOf(c);
		if (i >= 0) return i;
	}
	return -1;
}

function parseCorrectness(raw: string): number | undefined {
	const s = raw.trim().toLowerCase();
	if (s === "") return undefined;
	if (s === "true") return 1;
	if (s === "false") return 0;
	const n = Number(s);
	if (Number.isFinite(n)) {
		// Normalise 0–100 scores to 0–1 so std/means are comparable to booleans.
		return n > 1 ? n / 100 : n;
	}
	return undefined;
}

function mean(xs: number[]): number {
	if (xs.length === 0) return Number.NaN;
	let s = 0;
	for (const x of xs) s += x;
	return s / xs.length;
}

function meanStd(xs: number[]): { mean: number; std: number } {
	const m = mean(xs);
	if (xs.length < 2) return { mean: m, std: 0 };
	let sq = 0;
	for (const x of xs) sq += (x - m) * (x - m);
	return { mean: m, std: Math.sqrt(sq / (xs.length - 1)) };
}

function printSummary(s: {
	path: string;
	perQuestion: PerQuestionStat[];
	nPairs: number;
	withToolMean: number;
	withoutToolMean: number;
	diff: number;
	pValue: number;
}): void {
	console.log(`\n=== analyzeCombinedTsv(${s.path}) ===`);
	console.log(`  questions (paired with/without): ${s.nPairs}`);
	console.log(`  with-tool    mean correctness: ${fmt(s.withToolMean)}`);
	console.log(`  without-tool mean correctness: ${fmt(s.withoutToolMean)}`);
	console.log(`  Δ (with − without):            ${fmt(s.diff)}`);
	console.log(`  paired permutation p-value:    ${fmt(s.pValue)}`);
	console.log(`\n  per-question (mean ± std over replicates):`);
	const preview = s.perQuestion.slice(0, 30);
	for (const row of preview) {
		const key = row.questionKey.slice(0, 50).padEnd(52);
		console.log(
			`    ${key} [${row.mode.padEnd(13)}] ` +
				`n=${row.nReplicates}  μ=${fmt(row.mean)}  σ=${fmt(row.std)}`,
		);
	}
	if (s.perQuestion.length > preview.length) {
		console.log(`    … ${s.perQuestion.length - preview.length} more rows`);
	}
}

function fmt(x: number): string {
	if (!Number.isFinite(x)) return String(x);
	return x.toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────
// CLI entrypoint + self-test
// ─────────────────────────────────────────────────────────────────────────

async function selfTest(): Promise<void> {
	// Unit-test the TSV merging logic with a fake directory. Does NOT spawn
	// any child process — purely synchronous file IO in a temp dir.
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const tmp = mkdtempSync(join(tmpdir(), "replicate-test-"));
	try {
		const header = "question\tmode\tis_correct";
		const rep0 = `${header}\nQ1\twith-tool\ttrue\nQ1\twithout-tool\tfalse\nQ2\twith-tool\tfalse\nQ2\twithout-tool\tfalse\n`;
		const rep1 = `${header}\nQ1\twith-tool\ttrue\nQ1\twithout-tool\ttrue\nQ2\twith-tool\tfalse\nQ2\twithout-tool\ttrue\n`;
		const rep2 = `${header}\nQ1\twith-tool\ttrue\nQ1\twithout-tool\tfalse\nQ2\twith-tool\ttrue\nQ2\twithout-tool\tfalse\n`;
		writeFileSync(join(tmp, "rep0.tsv"), rep0);
		writeFileSync(join(tmp, "rep1.tsv"), rep1);
		writeFileSync(join(tmp, "rep2.tsv"), rep2);

		const combined = join(tmp, "combined.tsv");
		const m0 = mergeReplicateInto(join(tmp, "rep0.tsv"), combined, 0);
		const m1 = mergeReplicateInto(join(tmp, "rep1.tsv"), combined, 1, m0.header);
		const m2 = mergeReplicateInto(join(tmp, "rep2.tsv"), combined, 2, m0.header);
		const expectedRows = m0.rowsAppended + m1.rowsAppended + m2.rowsAppended;

		const combinedText = readFileSync(combined, "utf-8");
		const combinedLines = combinedText.split("\n").filter((l) => l.length > 0);
		const hdr = combinedLines[0]!.split("\t");
		if (hdr[hdr.length - 1] !== "replicate_idx") {
			throw new Error(`header missing replicate_idx column: ${hdr.join(",")}`);
		}
		if (combinedLines.length - 1 !== expectedRows) {
			throw new Error(
				`row count mismatch: got ${combinedLines.length - 1}, expected ${expectedRows}`,
			);
		}
		// spot-check replicate_idx column values
		const lastColCounts = new Map<string, number>();
		for (let i = 1; i < combinedLines.length; i++) {
			const cols = combinedLines[i]!.split("\t");
			const idx = cols[cols.length - 1]!;
			lastColCounts.set(idx, (lastColCounts.get(idx) ?? 0) + 1);
		}
		for (const k of ["0", "1", "2"]) {
			if (lastColCounts.get(k) !== 4) {
				throw new Error(`expected 4 rows for replicate_idx=${k}, got ${lastColCounts.get(k)}`);
			}
		}

		// Exercise analysis on the fake combined TSV.
		const analysis = analyzeCombinedTsv(combined);
		if (analysis.nQuestions !== 2) {
			throw new Error(`expected 2 questions, got ${analysis.nQuestions}`);
		}
		// Q1 with-tool: 3/3 = 1.0, Q1 without-tool: 1/3; Q2 with-tool: 1/3, without-tool: 1/3
		// withTool means = [1.0, 1/3]; withoutTool means = [1/3, 1/3]
		const expectedDiff = (1.0 - 1 / 3 + (1 / 3 - 1 / 3)) / 2;
		if (Math.abs(analysis.diff - expectedDiff) > 1e-9) {
			throw new Error(`diff mismatch: got ${analysis.diff}, expected ${expectedDiff}`);
		}

		console.log("selfTest: OK");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--self-test") {
		await selfTest();
		return;
	}
	if (args.length < 2) {
		console.error(
			"Usage: bun src/evals/replicate.ts <eval_name> <k> [--self-test]\n" +
				"Example: bun src/evals/replicate.ts wiki_trivia 3",
		);
		process.exit(2);
	}
	const evalName = args[0]!;
	const k = Number(args[1]!);
	const extraArgs = args.slice(2);
	const res = runReplicates(evalName, k, { extraArgs });
	console.log(
		`\nCombined TSV: ${res.combinedTsvPath}\n` +
			`  replicates: ${res.k}\n` +
			`  rows:       ${res.totalRows}\n` +
			`  child TSVs: ${res.perReplicateTsvs.join(", ")}`,
	);
	analyzeCombinedTsv(res.combinedTsvPath);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
