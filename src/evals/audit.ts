/**
 * Eval-log data-quality auditor.
 *
 * Scans a JSONL eval log and flags signals that the log was "poisoned" — i.e.
 * the SDK surfaced an upstream HTTP error (credit exhaustion, 429, stream idle
 * timeout, etc.) as `result.result` text with subtype:"success", so every
 * per-run judgement is corrupted. A log is considered healthy only if the
 * poisoned-run and zero-token-run ratios are both <=5% and no explicit error
 * events were recorded.
 */

import { readFileSync } from "node:fs";
import { UPSTREAM_ERROR_PATTERNS } from "./utils";

export interface AuditResult {
	path: string;
	totalRuns: number;
	poisonedRuns: number;
	zeroTokenRuns: number;
	errorEvents: number;
	gradeFailedEvents: number;
	healthy: boolean;
	warnings: string[];
}

function looksLikeUpstreamErrorText(text: string): boolean {
	if (!text) return false;
	const head = text.slice(0, 400);
	return UPSTREAM_ERROR_PATTERNS.some((re) => re.test(head));
}

/**
 * Scan a JSONL eval log and report data-quality signals. A log is "healthy"
 * if poisoned (upstream-error-shaped model answers) + zero-token runs are
 * both <=5% of totalRuns AND errorEvents is 0.
 */
export function auditLog(path: string): AuditResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			path,
			totalRuns: 0,
			poisonedRuns: 0,
			zeroTokenRuns: 0,
			errorEvents: 0,
			gradeFailedEvents: 0,
			healthy: false,
			warnings: [`failed to read log: ${msg}`],
		};
	}

	let totalRuns = 0;
	let poisonedRuns = 0;
	let zeroTokenRuns = 0;
	let errorEvents = 0;
	let gradeFailedEvents = 0;

	const lines = raw.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const event = entry["event"];
		if (event === "run") {
			totalRuns++;
			const answer = typeof entry["model_answer"] === "string" ? entry["model_answer"] : "";
			if (looksLikeUpstreamErrorText(answer)) poisonedRuns++;
			// impl_bench run events don't carry input_tokens/output_tokens — skip
			// them entirely rather than miscounting as zero-token poisoning.
			if ("input_tokens" in entry) {
				const inTok = Number(entry["input_tokens"] ?? 0);
				const outTok = Number(entry["output_tokens"] ?? 0);
				if (inTok + outTok === 0) zeroTokenRuns++;
			}
		} else if (event === "error") {
			errorEvents++;
		} else if (event === "grade_failed") {
			gradeFailedEvents++;
		}
	}

	const warnings: string[] = [];
	const poisonRatio = totalRuns > 0 ? poisonedRuns / totalRuns : 0;
	const zeroRatio = totalRuns > 0 ? zeroTokenRuns / totalRuns : 0;

	if (poisonedRuns > 0) {
		warnings.push(
			`${poisonedRuns}/${totalRuns} runs have upstream-error answers — likely credit exhaustion`,
		);
	}
	if (zeroTokenRuns > 0) {
		warnings.push(
			`${zeroTokenRuns}/${totalRuns} runs have zero input+output tokens — model likely never ran`,
		);
	}
	if (errorEvents > 0) {
		warnings.push(`${errorEvents} explicit error event(s) recorded`);
	}
	if (gradeFailedEvents > 0) {
		warnings.push(`${gradeFailedEvents} grade_failed event(s) recorded`);
	}
	if (totalRuns === 0) {
		warnings.push("log contains no run events");
	}

	const healthy = totalRuns > 0 && poisonRatio <= 0.05 && zeroRatio <= 0.05 && errorEvents === 0;

	return {
		path,
		totalRuns,
		poisonedRuns,
		zeroTokenRuns,
		errorEvents,
		gradeFailedEvents,
		healthy,
		warnings,
	};
}

// --- CLI ---
if (import.meta.path === Bun.main) {
	const argPath = process.argv[2];
	if (!argPath) {
		console.error("Usage: bun src/evals/audit.ts <log-path>");
		process.exit(2);
	}
	const result = auditLog(argPath);
	console.log(`Audit: ${result.path}`);
	console.log(`  totalRuns:         ${result.totalRuns}`);
	console.log(`  poisonedRuns:      ${result.poisonedRuns}`);
	console.log(`  zeroTokenRuns:     ${result.zeroTokenRuns}`);
	console.log(`  errorEvents:       ${result.errorEvents}`);
	console.log(`  gradeFailedEvents: ${result.gradeFailedEvents}`);
	console.log(`  healthy:           ${result.healthy}`);
	if (result.warnings.length > 0) {
		console.log("  warnings:");
		for (const w of result.warnings) console.log(`    - ${w}`);
	}
	process.exit(result.healthy ? 0 : 1);
}
