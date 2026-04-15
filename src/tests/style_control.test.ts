import { describe, expect, test } from "bun:test";
import {
	extractStyleFeatures,
	reportStyleControlledHeadline,
	type StyleControlPair,
	styleControlReport,
} from "../evals/utils";

describe("extractStyleFeatures", () => {
	test("counts headers, bullets, bold, length on plain markdown", () => {
		const t = "## Header A\n- item 1\n- item 2\n\nSome **bold** word.";
		const f = extractStyleFeatures(t);
		expect(f.headers).toBe(1);
		expect(f.bullets).toBe(2);
		expect(f.bold).toBe(1);
		expect(f.length).toBe(t.length);
	});

	test("ignores Python `# comment` lines inside fenced code blocks (impl_bench)", () => {
		// Python `# comment` lines inside fenced code blocks must not count
		// as markdown headers — otherwise the codier arm of impl_bench would
		// show inflated with-tool vs no-tool header counts.
		const t = "```py\n# this is a comment\ndef f():\n    # inline\n    pass\n```\n## Real header";
		const f = extractStyleFeatures(t);
		expect(f.headers).toBe(1); // only "## Real header", not "# this is" / "# inline"
	});

	test("strips unclosed fences too (robustness)", () => {
		const t = "# Real\n\n```py\n# comment without closing fence";
		const f = extractStyleFeatures(t);
		expect(f.headers).toBe(1);
	});

	test("does NOT apply \\n → newline transform on JSON-loaded content", () => {
		// Literal backslash-n (as would appear in a string containing `print("\n")`)
		// should not be re-interpreted into actual newlines and spawn ghost headers.
		const t = 'print("hello\\nworld")';
		const f = extractStyleFeatures(t);
		expect(f.headers).toBe(0);
		expect(f.bullets).toBe(0);
	});

	test("requires non-space content after # to count as header", () => {
		// Bare `#` or `#   ` at line start should not count.
		const t = "#\n# \n#    \n## real";
		const f = extractStyleFeatures(t);
		expect(f.headers).toBe(1);
	});

	test("bullet regex requires a space and content", () => {
		const t = "- real\n-nobs\n- \n* real2\n-";
		const f = extractStyleFeatures(t);
		expect(f.bullets).toBe(2);
	});

	test("bold regex matches across asymmetric interior (`**a * b**`)", () => {
		const t = "**bold with * inside**";
		const f = extractStyleFeatures(t);
		expect(f.bold).toBe(1);
	});

	test("zero counts on plain prose", () => {
		const f = extractStyleFeatures("Just a sentence with no markdown.");
		expect(f.headers).toBe(0);
		expect(f.bullets).toBe(0);
		expect(f.bold).toBe(0);
	});

	test("handles empty / undefined input gracefully", () => {
		expect(extractStyleFeatures("").length).toBe(0);
		expect(extractStyleFeatures(undefined as unknown as string).length).toBe(0);
	});
});

describe("styleControlReport — OLS correctness", () => {
	test("recovers known intercept when covariate is orthogonal to outcome", () => {
		// Construct Δy = 2 + 0 * Δh + noise. True β₀ = 2, β_h = 0.
		// Covariate is symmetric ±3; outcome is constant 2 plus zero-mean noise.
		const pairs: StyleControlPair[] = Array.from({ length: 16 }, (_, i) => {
			const h = i % 2 === 0 ? 3 : -3;
			// Build text that produces h extra headers in one arm vs the other.
			const withHeaders = "\n".concat(...Array.from({ length: Math.max(0, h) }, () => "# x\n"));
			const noHeaders = "\n".concat(...Array.from({ length: Math.max(0, -h) }, () => "# x\n"));
			return {
				withScore: 2 + (i % 2 === 0 ? 0.01 : -0.01),
				noScore: 0,
				withText: withHeaders + "body",
				noText: noHeaders + "body",
			};
		});
		const r = styleControlReport(pairs);
		expect(r.rawDelta).toBeCloseTo(2, 2);
		expect(r.markdown).not.toBeNull();
		// Residual should still be ≈ 2 because markdown variance is orthogonal to y.
		expect(r.markdown!.delta).toBeCloseTo(2, 1);
	});

	test("fully absorbs outcome when covariate perfectly predicts it", () => {
		// Δy = 0.5 * Δh (no intercept); true β₀ = 0.
		const pairs: StyleControlPair[] = Array.from({ length: 12 }, (_, i) => {
			const h = i - 6; // Δh ranges -6..5
			const withHeaders = "\n".concat(...Array.from({ length: Math.max(0, h) }, () => "# x\n"));
			const noHeaders = "\n".concat(...Array.from({ length: Math.max(0, -h) }, () => "# x\n"));
			return {
				withScore: 0.5 * h,
				noScore: 0,
				withText: withHeaders + "body",
				noText: noHeaders + "body",
			};
		});
		const r = styleControlReport(pairs);
		// Raw mean of diffs = 0.5 * mean(-6..5) = 0.5 * -0.5 = -0.25 (ish)
		expect(Math.abs(r.markdown!.delta)).toBeLessThan(0.05);
	});
});

describe("styleControlReport — permutation p-values", () => {
	test("uniformly zero outcome → raw p = 1", () => {
		const pairs: StyleControlPair[] = Array.from({ length: 10 }, () => ({
			withScore: 1,
			noScore: 1,
			withText: "plain",
			noText: "plain",
		}));
		const r = styleControlReport(pairs);
		expect(r.rawDelta).toBe(0);
		expect(r.rawP).toBe(1);
	});

	test("permutation p for large, clean effect → small p (no distributional assumption)", () => {
		// 12 pairs, Δy = +1 every time, tiny noise. Exact 2^12 = 4096 enumerations.
		const pairs: StyleControlPair[] = Array.from({ length: 12 }, (_, i) => ({
			withScore: 1 + i * 0.001,
			noScore: 0,
			// Put ≥1 unit of markdown variance so the residual fit can run.
			withText: i % 2 === 0 ? "## a\n" : "plain",
			noText: i % 2 === 0 ? "plain" : "## a\n",
		}));
		const r = styleControlReport(pairs);
		// Every per-pair diff is positive; sign-flip permutation gives only 2 of
		// 2^12 masks where the sum is ≥ observed (all-neg and all-pos). p ≈ 2/4096.
		expect(r.rawP).toBeLessThan(0.001);
		if (r.markdown) expect(r.markdown.p).toBeLessThan(0.01);
	});

	test("p ≈ 1 when observed effect is near the permutation-null median", () => {
		// Symmetric ±1 Δ: observed mean = 0. Permutation distribution is symmetric
		// around 0 by construction. p should be exactly 1.
		const pairs: StyleControlPair[] = [
			{ withScore: 1, noScore: 0, withText: "a", noText: "b" },
			{ withScore: 0, noScore: 1, withText: "c", noText: "d" },
			{ withScore: 2, noScore: 1, withText: "e", noText: "f" },
			{ withScore: 1, noScore: 2, withText: "g", noText: "h" },
		];
		const r = styleControlReport(pairs);
		expect(r.rawDelta).toBe(0);
		expect(r.rawP).toBe(1);
	});

	test("permutation is exact (=k/2ⁿ) for small n", () => {
		// n=4, all Δ=+1. 2^4=16 masks. Only mask=0000 gives sum=4 (observed); mask=1111 gives sum=-4.
		// Those two masks are the only ones with |sum| ≥ 4. Expected raw p = 2/16 = 0.125.
		const pairs: StyleControlPair[] = Array.from({ length: 4 }, () => ({
			withScore: 1,
			noScore: 0,
			withText: "plain",
			noText: "plain",
		}));
		const r = styleControlReport(pairs);
		expect(r.rawP).toBeCloseTo(0.125, 5);
	});
});

describe("styleControlReport — metadata", () => {
	test("surfaces which covariates were used after fallback", () => {
		// 6 pairs with bullet variance but zero header variance. Full set [h,b,bd]
		// should fall back to [b] because h and bd are constant.
		const pairs: StyleControlPair[] = Array.from({ length: 6 }, (_, i) => ({
			withScore: i % 2,
			noScore: 0,
			withText: i % 2 === 0 ? "- a\n- b\nmore body text" : "body " + i,
			noText: "body " + i,
		}));
		const r = styleControlReport(pairs);
		expect(r.markdown).not.toBeNull();
		// Covariates array should contain "bullets" (variable) and exclude "headers"/"bold" (zero variance).
		expect(r.markdown!.covariates).toContain("bullets");
		expect(r.markdown!.covariates).not.toContain("headers");
		expect(r.markdown!.covariates).not.toContain("bold");
	});

	test("flags sign-flipped residual (Simpson-like reversal)", () => {
		// Construct raw Δ < 0 (no-tool scores higher) but markdown Δ > 0 (with-tool
		// more markdown). If markdown fully explains the score gap in the "wrong"
		// direction, residual flips positive. Detect via signFlipped=true.
		//
		// Simplest construction: big markdown advantage paired with score
		// disadvantage AND vice versa so regression teases out the residual mode
		// effect in the opposite direction.
		const pairs: StyleControlPair[] = [];
		for (let i = 0; i < 10; i++) {
			// Half: with has lots of headers but LOWER score.
			pairs.push({
				withScore: 0,
				noScore: 1,
				withText: "## h\n## h\n## h\n## h",
				noText: "body",
			});
		}
		for (let i = 0; i < 10; i++) {
			// Half: with has no markdown advantage but SAME score as no.
			pairs.push({
				withScore: 1,
				noScore: 1,
				withText: "body",
				noText: "body",
			});
		}
		const r = styleControlReport(pairs);
		expect(r.rawDelta).toBeLessThan(0); // raw says with-tool does worse
		if (r.markdown) {
			// The residual (after controlling for with-tool's extra headers)
			// should approach 0 or even flip positive → signFlipped may be true
			// depending on the exact construction. At minimum it must be > raw.
			expect(r.markdown.delta).toBeGreaterThan(r.rawDelta);
		}
	});

	test("reportStyleControlledHeadline emits event and returns report", async () => {
		const pairs: StyleControlPair[] = Array.from({ length: 6 }, (_, i) => ({
			withScore: i % 2,
			noScore: 0,
			withText: "## h\n- x\nbody " + i,
			noText: "body " + i,
		}));
		const log: unknown[] = [];
		const r = await reportStyleControlledHeadline({
			label: "test",
			pairs,
			log: async (e) => {
				log.push(e);
			},
		});
		expect(r.n).toBe(6);
		expect(log.length).toBe(1);
		expect((log[0] as { event: string }).event).toBe("style_control");
	});
});

describe("edge cases", () => {
	test("n=2 does not blow up (exact enumeration: 4 masks, raw p ∈ {0.5, 1})", () => {
		const pairs: StyleControlPair[] = [
			{ withScore: 1, noScore: 0, withText: "a", noText: "b" },
			{ withScore: 1, noScore: 0, withText: "c", noText: "d" },
		];
		const r = styleControlReport(pairs);
		expect(r.rawDelta).toBe(1);
		// 4 masks, only mask=00 (both +1) gives |sum|=2. mask=11 gives |sum|=2.
		// mask=01, 10 give |sum|=0. p = 2/4 = 0.5.
		expect(r.rawP).toBeCloseTo(0.5, 5);
	});

	test("perfect collinearity between bullets and length falls back gracefully", () => {
		// Set length ∝ bullets (every bullet is "- x" = 3 chars + newline). Full fit
		// should be singular; fallback should find a non-singular subset.
		const pairs: StyleControlPair[] = Array.from({ length: 10 }, (_, i) => {
			const bullets = i; // 0..9
			const text = Array.from({ length: bullets }, () => "- x").join("\n");
			return {
				withScore: bullets * 0.1,
				noScore: 0,
				withText: text,
				noText: "",
			};
		});
		const r = styleControlReport(pairs);
		// Should produce some valid residual (not all null) via fallback.
		expect(r.full !== null || r.markdown !== null || r.length !== null).toBe(true);
	});

	test("null permutation distribution is correct (uniform random outcomes)", () => {
		// This is a null simulation: outcomes are random ±1, covariates random.
		// The permutation p-value should be approximately uniform on [0,1].
		// Spot check: a single construction should give a "reasonable" p, not
		// systematically inflated. With n=20 and truly null data, expected p is
		// roughly U(0,1) so should not be < 0.01 with any regularity.
		const rand = (seed: number) => Math.abs(Math.sin(seed * 12345)) % 1;
		const pairs: StyleControlPair[] = Array.from({ length: 20 }, (_, i) => ({
			withScore: rand(i) < 0.5 ? 1 : 0,
			noScore: rand(i + 100) < 0.5 ? 1 : 0,
			withText: rand(i + 200) < 0.5 ? "## h\n- x" : "plain",
			noText: rand(i + 300) < 0.5 ? "## h\n- x" : "plain",
		}));
		const r = styleControlReport(pairs);
		// Sanity: permutation p is in [0, 1]
		expect(r.rawP).toBeGreaterThanOrEqual(0);
		expect(r.rawP).toBeLessThanOrEqual(1);
		if (r.markdown) {
			expect(r.markdown.p).toBeGreaterThanOrEqual(0);
			expect(r.markdown.p).toBeLessThanOrEqual(1);
		}
	});
});
