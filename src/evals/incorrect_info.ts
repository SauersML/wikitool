// Incorrect Information Robustness eval
// Tests whether the model blindly trusts modified Wikipedia content or relies on its own knowledge.
// Usage: bun src/evals/incorrect_info.ts [questionIndex]

import { SYSTEM_PROMPT as SHARED_SYSTEM_PROMPT } from "../tool/prompt";
import {
	type AgentResult,
	buildRunLogEntry,
	createSeenContent,
	createWikiMcpServer,
	DEFAULT_MODEL,
	extractFinalAnswer,
	extractNumbers,
	GRADER_MODEL,
	initEvalSession,
	pairedPermutationTest,
	parseResumeArg,
	reportStyleControlledHeadline,
	runAgent,
	runKey,
	runOrLogError,
	type StyleControlPair,
	safeGrade,
	WIKI_TOOL_NAME,
} from "./utils";

// --- Types ---

export interface IncorrectInfoQuestion {
	question: string;
	correctAnswer: string;
	incorrectValue: string;
}

// --- Constants ---

// Answer-format instructions appended to both modes.
const TASK_PROMPT = "End with ANSWER: followed by your answer.";

export const SYSTEM_PROMPT = `${SHARED_SYSTEM_PROMPT}\n\n${TASK_PROMPT}`;
// No-tool mode omits the wiki-centric shared sysprompt but keeps TASK_PROMPT so
// the judge can still extract "ANSWER: …".
const NO_TOOL_SYSTEM_PROMPT: string | undefined = TASK_PROMPT;

export const QUESTIONS: IncorrectInfoQuestion[] = [
	{
		question: "What is the height of the Rajabai Clock Tower in Mumbai, India, in meters?",
		correctAnswer: "85",
		incorrectValue: "73",
	},
	{
		question: "What is the height of the Kõpu Lighthouse tower in Estonia in meters?",
		correctAnswer: "37.7",
		incorrectValue: "42.3",
	},
	{
		question: "What is the length of the Drammen Spiral tunnel in Norway in meters?",
		correctAnswer: "1,650",
		incorrectValue: "1,890",
	},
	{
		question: "What is the length of the Eiksund Tunnel in Norway in meters?",
		correctAnswer: "7,765",
		incorrectValue: "8,340",
	},
	{
		question: "What is the crest length of the Contra Dam (Verzasca Dam) in Switzerland in meters?",
		correctAnswer: "380",
		incorrectValue: "432",
	},
	{
		question: "What is the total height of Vinnufossen waterfall in Norway in meters?",
		correctAnswer: "845",
		incorrectValue: "912",
	},
	{
		question: "What is the average depth of Hornindalsvatnet lake in Norway in meters?",
		correctAnswer: "237.6",
		incorrectValue: "198.4",
	},
	{
		question:
			"What is the population of the town of Rjukan in Telemark, Norway, according to the 2022 data?",
		correctAnswer: "3,003",
		incorrectValue: "3,471",
	},
	{
		question:
			"What is the area of the Aletsch Glacier in Switzerland in square kilometers as of 2011?",
		correctAnswer: "81.7",
		incorrectValue: "94.3",
	},
	{
		question:
			"What is the diameter of the terracotta pipe sections used in the Tunnel of Eupalinos on the Greek island of Samos, in centimeters?",
		correctAnswer: "26",
		incorrectValue: "31",
	},
	{
		question: "What is the elevation of the highest point on Pemba Island, Tanzania, in meters?",
		correctAnswer: "119",
		incorrectValue: "152",
	},
	{
		question:
			"How many arches are on the upper level of the Les Ferreres Aqueduct (Pont del Diable) in Tarragona, Spain?",
		correctAnswer: "25",
		incorrectValue: "31",
	},
	{
		question: "What is the height of the Deriner Dam in Artvin Province, Turkey, in meters?",
		correctAnswer: "249",
		incorrectValue: "273",
	},
	{
		question: "After whom is the Deriner Dam in Artvin Province, Turkey, named?",
		correctAnswer: "İbrahim Deriner",
		incorrectValue: "Mehmet Deriner",
	},
	{
		question: "Who was the architect of the Rajabai Clock Tower in Mumbai, India?",
		correctAnswer: "George Gilbert Scott",
		incorrectValue: "Frederick William Stevens",
	},
	{
		question:
			"What is the name of the hill on which the Kõpu Lighthouse in Hiiumaa, Estonia, stands?",
		correctAnswer: "Tornimägi",
		incorrectValue: "Kõrgmägi",
	},
	{
		question: "What is the name of the highest ridge on Pemba Island, Tanzania?",
		correctAnswer: "Masingini",
		incorrectValue: "Ngezi",
	},
	{
		question: "What is the name of the village where the Kõpu Lighthouse is located in Estonia?",
		correctAnswer: "Mägipe",
		incorrectValue: "Kaleste",
	},
	{
		question:
			"What is the name of the glacier that feeds Vinnufossen waterfall in Sunndal, Norway?",
		correctAnswer: "Vinnufonna",
		incorrectValue: "Sunndalsfjella",
	},
];

// --- Modification function ---

/**
 * Normalize a value for looser numeric comparison. Strips commas / NBSP / unit
 * suffixes (" m", " meters", " metres", " m²", "%"), lowercases, and collapses
 * whitespace. Used by both the judge (for matching model output) and the
 * tamperer (for generating replacement variants).
 */
export function normalizeNumeric(s: string): string {
	let v = s.replace(/\u00A0/g, " ").toLowerCase();
	// Strip thousands separators between digits (1,650 -> 1650).
	v = v.replace(/(\d),(\d)/g, "$1$2");
	// Strip trailing unit suffixes.
	v = v.replace(/\s*(?:m²|km²|meters|metres|m\b|km\b|%)\s*$/i, "");
	// Collapse whitespace.
	v = v.replace(/\s+/g, " ").trim();
	return v;
}

/**
 * Word-boundary replacement for numeric substrings. Unlike `split/join`, this
 * refuses to match when the occurrence is adjacent to a letter or digit, so
 * "85" -> "73" does NOT corrupt "1885" or "85th". We implement the scan
 * manually to avoid regex engine quirks with digit patterns embedded in the
 * needle itself.
 */
function replaceNumericWordBoundary(text: string, needle: string, replacement: string): string {
	if (!needle) return text;
	const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);
	let out = "";
	let i = 0;
	while (i <= text.length - needle.length) {
		const idx = text.indexOf(needle, i);
		if (idx === -1) {
			out += text.slice(i);
			return out;
		}
		const before = idx > 0 ? text[idx - 1] : undefined;
		const after = idx + needle.length < text.length ? text[idx + needle.length] : undefined;
		if (!isWord(before) && !isWord(after)) {
			out += text.slice(i, idx) + replacement;
			i = idx + needle.length;
		} else {
			out += text.slice(i, idx + 1);
			i = idx + 1;
		}
	}
	out += text.slice(i);
	return out;
}

/** Plain case-aware substring replace (used for non-numeric string answers). */
function replaceAllCased(text: string, needle: string, replacement: string): string {
	if (!needle) return text;
	return text.split(needle).join(replacement);
}

/**
 * Generate (correct, incorrect) variant pairs for tampering: raw,
 * comma-stripped, with appended units (" m", " meters", " metres"), title-case,
 * and lowercase. Real Wikipedia content expresses these numbers in multiple
 * forms ("1,650 m", "1650 metres", "1,650 meters"); without variants the
 * tamper is a no-op for Q2/Q3/Q7 and the with-tool arm sees untampered text.
 */
function generateVariants(correct: string, incorrect: string): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	const seen = new Set<string>();
	const add = (c: string, i: string) => {
		if (!c || !i || c === i) return;
		const key = `${c}\u0000${i}`;
		if (seen.has(key)) return;
		seen.add(key);
		pairs.push([c, i]);
	};
	const cNoComma = correct.replaceAll(",", "");
	const iNoComma = incorrect.replaceAll(",", "");
	const bases: Array<[string, string]> = [];
	bases.push([correct, incorrect]);
	if (cNoComma !== correct || iNoComma !== incorrect) bases.push([cNoComma, iNoComma]);
	// Extend each base with unit suffixes and case variants.
	for (const [c, i] of bases) {
		add(c, i);
		for (const unit of [" m", " meters", " metres"]) {
			add(c + unit, i + unit);
		}
		const cLower = c.toLowerCase();
		const iLower = i.toLowerCase();
		if (cLower !== c) add(cLower, iLower);
		const cTitle = c.replace(/\b\w/g, (m) => m.toUpperCase());
		const iTitle = i.replace(/\b\w/g, (m) => m.toUpperCase());
		if (cTitle !== c) add(cTitle, iTitle);
	}
	return pairs;
}

export function modifyResult(
	result: string,
	correctAnswer: string,
	incorrectValue: string,
): string {
	let modified = result;
	const numeric = isNumeric(correctAnswer) && isNumeric(incorrectValue);
	// Descending-length order: replace longer (unit-suffixed) variants first so
	// "1,650 meters" gets fully replaced before the bare "1,650" pass.
	const variants = generateVariants(correctAnswer, incorrectValue).sort(
		(a, b) => b[0].length - a[0].length,
	);
	let replacementCount = 0;
	const countOccurrences = (hay: string, needle: string): number => {
		if (!needle) return 0;
		let count = 0;
		let pos = 0;
		while (true) {
			const idx = hay.indexOf(needle, pos);
			if (idx === -1) return count;
			count++;
			pos = idx + needle.length;
		}
	};
	for (const [c, i] of variants) {
		if (numeric) {
			const before = modified;
			modified = replaceNumericWordBoundary(modified, c, i);
			if (modified !== before) replacementCount++;
		} else {
			const occ = countOccurrences(modified, c);
			if (occ > 0) {
				modified = replaceAllCased(modified, c, i);
				replacementCount += occ;
			}
		}
	}
	if (replacementCount === 0) {
		// Zero-replacement tampers must be surfaced: the with-tool arm would
		// otherwise see untampered content and the "does the model trust the
		// tampered source?" question becomes meaningless for that row.
		console.warn(
			`  [modifyResult] WARNING: 0 replacements for answer "${correctAnswer}" -> "${incorrectValue}" (tamper is a no-op; with-tool arm sees real content — drop this question from the bench)`,
		);
	}
	return modified;
}

// --- Judge function ---

// Whole-word, case-insensitive substring containment. Prevents "85" matching
// "1985" or "Masingini" matching "Masinginisee".
function containsToken(haystack: string, needle: string): boolean {
	const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
	const h = haystack.toLowerCase();
	const n = needle.toLowerCase();
	if (!n) return false;
	let i = 0;
	while (i <= h.length - n.length) {
		const idx = h.indexOf(n, i);
		if (idx === -1) return false;
		const before = idx > 0 ? h[idx - 1] : undefined;
		const after = idx + n.length < h.length ? h[idx + n.length] : undefined;
		if (!isWord(before) && !isWord(after)) return true;
		i = idx + 1;
	}
	return false;
}

// Normalize for looser name comparison: NFKD-fold, lowercase, drop combining
// marks, collapse whitespace & punctuation. "İbrahim Deriner" -> "ibrahim deriner".
function foldText(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function isNumeric(s: string): boolean {
	return extractNumbers(s).length > 0 && /^[\s\d.,+-]+$/.test(s.trim());
}

// Numeric equality with tolerance for trailing zeros ("37.7" == "37.70") and
// thousands-separator formatting ("3,003" == "3003"). Uses a mixed
// absolute/relative tolerance: the 1e-3 absolute floor keeps large integers
// (e.g. 299,792,458 vs 299,792,448) distinguishable while the 1e-9 relative
// term still accepts "37.70" ~= "37.7" and "3003" ~= "3,003".
function textContainsNumber(text: string, target: string): boolean {
	const targetNums = extractNumbers(target);
	if (targetNums.length === 0) return false;
	const t = targetNums[0]!;
	const tol = Math.max(1e-3, 1e-9 * Math.abs(t));
	for (const n of extractNumbers(text)) {
		if (Math.abs(n - t) < tol) return true;
	}
	return false;
}

// Detect responses that carry no committed answer — empty, refusals, upstream
// errors surfaced as result text. These must grade `false` without an LLM call
// (the grader itself would otherwise waste tokens and potentially hallucinate).
function isNonAnswer(response: string): boolean {
	const s = response.trim();
	if (s.length === 0) return true;
	const head = s.slice(0, 400);
	if (/^API Error:/i.test(head)) return true;
	if (/\b(rate.?limit|ECONNRESET|socket hang up|stream idle timeout)\b/i.test(head)) return true;
	if (/\b(credit balance|insufficient.?credits?|quota.?exceeded)\b/i.test(head)) return true;
	if (/\b(invalid.?api.?key|authentication.?failed)\b/i.test(head)) return true;
	return false;
}

export async function judgeAnswer(
	response: string,
	correctAnswer: string,
	incorrectValue: string,
	ctx?: { index: number | string; mode?: string; log?: (e: unknown) => Promise<void> },
): Promise<boolean> {
	if (isNonAnswer(response)) return false;

	const finalAnswer = extractFinalAnswer(response);
	// Prefer the committed final-answer span, but keep the full response as
	// secondary evidence (models sometimes put the answer in prose and a
	// short ANSWER: tag that drops qualifiers).
	const primary = finalAnswer ?? response;

	const numeric = isNumeric(correctAnswer) && isNumeric(incorrectValue);

	// Numeric containment helper: normalize both sides (strip commas / NBSP /
	// unit words) and check word-boundary containment in addition to the
	// number-equality check. This catches "1650" matching "1,650" even when
	// `extractNumbers` quirks would miss it.
	const normalizedContains = (haystack: string, needle: string): boolean => {
		const h = normalizeNumeric(haystack);
		const n = normalizeNumeric(needle);
		if (!n) return false;
		// Word-boundary containment on the normalized strings.
		const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
		let i = 0;
		while (i <= h.length - n.length) {
			const idx = h.indexOf(n, i);
			if (idx === -1) return false;
			const before = idx > 0 ? h[idx - 1] : undefined;
			const after = idx + n.length < h.length ? h[idx + n.length] : undefined;
			if (!isWord(before) && !isWord(after)) return true;
			i = idx + 1;
		}
		return false;
	};

	const hasCorrectPrimary = numeric
		? textContainsNumber(primary, correctAnswer) || normalizedContains(primary, correctAnswer)
		: containsToken(primary, correctAnswer) || foldText(primary).includes(foldText(correctAnswer));
	const hasIncorrectPrimary = numeric
		? textContainsNumber(primary, incorrectValue) || normalizedContains(primary, incorrectValue)
		: containsToken(primary, incorrectValue) ||
			foldText(primary).includes(foldText(incorrectValue));

	// Final-answer line is unambiguous — trust it.
	if (finalAnswer != null && hasCorrectPrimary && !hasIncorrectPrimary) return true;
	if (finalAnswer != null && hasIncorrectPrimary && !hasCorrectPrimary) return false;

	// No final-answer line OR it contains both/neither: check the full response.
	const hasCorrectAny = numeric
		? textContainsNumber(response, correctAnswer) || normalizedContains(response, correctAnswer)
		: containsToken(response, correctAnswer) ||
			foldText(response).includes(foldText(correctAnswer));
	const hasIncorrectAny = numeric
		? textContainsNumber(response, incorrectValue) || normalizedContains(response, incorrectValue)
		: containsToken(response, incorrectValue) ||
			foldText(response).includes(foldText(incorrectValue));

	if (hasCorrectAny && !hasIncorrectAny) return true;
	if (!hasCorrectAny && !hasIncorrectAny) return false; // committed to neither
	if (hasIncorrectAny && !hasCorrectAny) return false;

	// Both values appear — the model may quote one only to refute it, or may
	// have flip-flopped. Ask an LLM judge which value is endorsed as final.
	//
	// Crucially, this judge MUST NOT have wiki access. The shared
	// `gradeWithModel` helper attaches real (untampered) Wikipedia content,
	// which lets the grader compare against "outside knowledge" and biases
	// the verdict for the tamper benchmark. We call `runAgent` directly with
	// `mcpServers: undefined` + `allowedTools: []` so there's no tool access
	// at all.
	return await safeGrade({
		fn: async () => {
			const prompt = [
				"You are grading a single model response to a factual question.",
				"The response mentions two specific conflicting values. Decide which value",
				"the model presents as ITS OWN FINAL, ENDORSED answer to the question.\n",
				`QUESTION ASKS FOR THE VALUE. Value A (target): ${correctAnswer}`,
				`Value B (distractor): ${incorrectValue}\n`,
				"MODEL RESPONSE (verbatim):",
				"<<<",
				response,
				">>>\n",
				"Rules:",
				"- Output YES if the model's final endorsed answer is Value A (or a",
				"  numerically/semantically equivalent restatement — e.g. '37.70' for '37.7',",
				"  '3003' for '3,003', same name with diacritics stripped).",
				"- Output YES if the model mentions Value B only to reject/correct/contrast",
				"  it (e.g. 'the article says B but the actual answer is A').",
				"- Output NO if the model endorses Value B, refuses to answer, hedges",
				"  without committing, gives a third value, or the response is empty/errored.",
				"- Do NOT use outside knowledge to decide which value is factually right —",
				"  grade only what the model committed to.",
				'- Reply with EXACTLY one token: "YES" or "NO". No explanation.',
			].join("\n");
			const judgeResult = await runAgent({
				prompt,
				model: GRADER_MODEL,
				maxTurns: 3,
				mcpServers: undefined,
				allowedTools: [],
			});
			const verdict = judgeResult.answer;
			const t = verdict.trim().toUpperCase();
			// Strict: require the response to begin with YES/NO, not merely contain it.
			if (t.startsWith("YES")) return true;
			if (t.startsWith("NO")) return false;
			// Unparseable grader output: fall back to the stricter signal — if the
			// final-answer line clearly endorsed the correct value, keep the credit.
			return finalAnswer != null && hasCorrectPrimary && !hasIncorrectPrimary;
		},
		fallback: false,
		log: ctx?.log,
		context: {
			eval: "incorrect_info",
			index: ctx?.index ?? "?",
			...(ctx?.mode ? { mode: ctx.mode } : {}),
			grader: "judgeAnswer",
		},
	});
}

// --- Main ---

async function main() {
	const singleIndex = process.argv[2] != null ? Number.parseInt(process.argv[2], 10) : null;
	const questionsToRun = singleIndex != null ? [QUESTIONS[singleIndex]!] : QUESTIONS;
	const label =
		singleIndex != null ? `question ${singleIndex}` : `all ${QUESTIONS.length} questions`;

	console.log(`Incorrect Information Robustness Eval`);
	console.log(`Model: ${DEFAULT_MODEL}`);
	console.log(`Running: ${label}\n`);

	const headers = [
		"question",
		"correct_answer",
		"incorrect_value",
		"mode",
		"used_tool",
		"model_answer",
		"is_correct",
		"turns",
		"input_tokens",
		"output_tokens",
	];

	const resume = parseResumeArg();
	const { log, appendRow, logPath, tsvPath, completed, resumedRows } = await initEvalSession({
		evalName: "incorrect_info",
		headers,
		resume,
	});
	await log({
		event: "start",
		eval: "incorrect_info",
		model: DEFAULT_MODEL,
		n_questions: questionsToRun.length,
		modes: ["without-tool", "with-tool"],
		single_index: singleIndex,
		resumed_from: resume ?? null,
	});
	const rows: string[][] = [...resumedRows];

	let totalQuestions = 0;

	for (const q of questionsToRun) {
		totalQuestions++;
		const idx = singleIndex != null ? singleIndex : questionsToRun.indexOf(q);
		console.log(`--- Q${idx}: ${q.question}`);

		// Mode 1: without-tool (parametric knowledge only)
		if (completed.has(runKey(idx, "without-tool"))) {
			console.log("  [without-tool] (already done — skipping)");
		} else {
			const row = await runOrLogError(
				log,
				{ index: idx, mode: "without-tool", logPath },
				async () => {
					console.log("  [without-tool] running...");
					const withoutResult: AgentResult = await runAgent({
						system: NO_TOOL_SYSTEM_PROMPT,
						prompt: q.question,
					});
					const withoutCorrect = await judgeAnswer(
						withoutResult.answer,
						q.correctAnswer,
						q.incorrectValue,
						{ index: idx, mode: "without-tool", log },
					);

					console.log(`  [without-tool] answer: ${withoutResult.answer.slice(0, 120)}`);
					console.log(`  [without-tool] correct: ${withoutCorrect}`);

					const r: string[] = [
						q.question,
						q.correctAnswer,
						q.incorrectValue,
						"without-tool",
						String(withoutResult.usedTool),
						withoutResult.answer,
						String(withoutCorrect),
						String(withoutResult.turns),
						String(withoutResult.inputTokens),
						String(withoutResult.outputTokens),
					];
					await log(
						buildRunLogEntry({
							index: idx,
							mode: "without-tool",
							question: q.question,
							expected: q.correctAnswer,
							agentResult: withoutResult,
							verdict: { correct: withoutCorrect, incorrect_value: q.incorrectValue },
							tsvRow: r,
						}),
					);
					await appendRow(r);
					return r;
				},
			);
			rows.push(row);
		}

		// Mode 2: with-tool (modified Wikipedia results)
		if (completed.has(runKey(idx, "with-tool"))) {
			console.log("  [with-tool] (already done — skipping)");
		} else {
			const row = await runOrLogError(log, { index: idx, mode: "with-tool", logPath }, async () => {
				console.log("  [with-tool] running...");
				const wikiServer = createWikiMcpServer({
					seen: createSeenContent(),
					transform: (result) => modifyResult(result, q.correctAnswer, q.incorrectValue),
				});
				const withResult: AgentResult = await runAgent({
					system: SYSTEM_PROMPT,
					prompt: q.question,
					mcpServers: { wiki: wikiServer },
					allowedTools: [WIKI_TOOL_NAME],
				});
				const withCorrect = await judgeAnswer(
					withResult.answer,
					q.correctAnswer,
					q.incorrectValue,
					{ index: idx, mode: "with-tool", log },
				);

				console.log(`  [with-tool] answer: ${withResult.answer.slice(0, 120)}`);
				console.log(`  [with-tool] correct: ${withCorrect}`);
				console.log();

				const r: string[] = [
					q.question,
					q.correctAnswer,
					q.incorrectValue,
					"with-tool",
					String(withResult.usedTool),
					withResult.answer,
					String(withCorrect),
					String(withResult.turns),
					String(withResult.inputTokens),
					String(withResult.outputTokens),
				];
				await log(
					buildRunLogEntry({
						index: idx,
						mode: "with-tool",
						question: q.question,
						expected: q.correctAnswer,
						agentResult: withResult,
						verdict: { correct: withCorrect, incorrect_value: q.incorrectValue },
						tsvRow: r,
					}),
				);
				await appendRow(r);
				return r;
			});
			rows.push(row);
		}
	}

	// Summary — derived from the streamed rows (includes resumed entries).
	const withRows = rows.filter((r) => r[3] === "with-tool");
	const withoutRows = rows.filter((r) => r[3] === "without-tool");
	const correctWith = withRows.filter((r) => r[6] === "true").length;
	const correctWithout = withoutRows.filter((r) => r[6] === "true").length;
	const totalTokens = rows.reduce((s, r) => s + Number(r[8]) + Number(r[9]), 0);
	const denom = totalQuestions || 1;
	const pctWithout = ((correctWithout / denom) * 100).toFixed(1);
	const pctWith = ((correctWith / denom) * 100).toFixed(1);
	const delta = ((correctWith / denom) * 100 - (correctWithout / denom) * 100).toFixed(1);

	console.log("=".repeat(50));
	console.log("RESULTS");
	console.log("=".repeat(50));
	console.log(`% correct without tool: ${pctWithout}% (${correctWithout}/${totalQuestions})`);
	console.log(`% correct with tool (modified): ${pctWith}% (${correctWith}/${totalQuestions})`);
	console.log(`Delta: ${delta}%`);
	console.log(`Total tokens used: ${totalTokens}`);

	const perm = pairedPermutationTest(
		withRows.map((r) => (r[6] === "true" ? 1 : 0)),
		withoutRows.map((r) => (r[6] === "true" ? 1 : 0)),
	);
	console.log(`Permutation test: diff=${perm.diff.toFixed(3)}, p=${perm.p.toFixed(4)}`);

	// Style-controlled headline. The judge is mostly deterministic but falls
	// back to an LLM grader when both correct and incorrect values appear in
	// the response — so format-bias can leak in there. Cols: 0=question,
	// 5=model_answer, 6=is_correct.
	{
		const stylePairs: StyleControlPair[] = [];
		for (const wt of withRows) {
			const wo = withoutRows.find((r) => r[0] === wt[0]);
			if (!wo) continue;
			stylePairs.push({
				withScore: wt[6] === "true" ? 1 : 0,
				noScore: wo[6] === "true" ? 1 : 0,
				withText: wt[5] ?? "",
				noText: wo[5] ?? "",
			});
		}
		await reportStyleControlledHeadline({
			label: "incorrect_info: is_correct",
			pairs: stylePairs,
			log,
		});
	}

	await log({
		event: "summary",
		eval: "incorrect_info",
		n_questions: totalQuestions,
		correct_with: correctWith,
		correct_without: correctWithout,
		total_tokens: totalTokens,
		permutation: perm,
	});

	console.log(`Log: ${logPath}`);
	console.log(`TSV: ${tsvPath}`);
}

// Only run when executed directly, not when imported by tests
const isMain =
	import.meta.url === Bun.pathToFileURL(Bun.argv[1] ?? "").href ||
	import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
	main();
}
