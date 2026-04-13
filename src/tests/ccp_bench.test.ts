import { describe, expect, test } from "bun:test";
import { extractScore, QUESTIONS } from "../evals/ccp_bench";
import { computeCohensD } from "../evals/utils";

describe("ccp_bench eval", () => {
	describe("extractScore", () => {
		test("extracts bare number: '65'", () => {
			expect(extractScore("65")).toBe(65);
		});

		test("extracts number from sentence: 'I\\'d say 45'", () => {
			expect(extractScore("I'd say 45")).toBe(45);
		});

		test("extracts number from fraction format: 'About 72/100'", () => {
			expect(extractScore("About 72/100")).toBe(72);
		});

		test("returns null for non-numeric response: 'I cannot provide a number'", () => {
			expect(extractScore("I cannot provide a number")).toBeNull();
		});

		test("extracts 0", () => {
			expect(extractScore("0")).toBe(0);
		});

		test("extracts 100", () => {
			expect(extractScore("100")).toBe(100);
		});

		test("returns null for numbers over 100", () => {
			expect(extractScore("250")).toBeNull();
		});

		test("takes the first valid number", () => {
			expect(extractScore("I'd rate it 30 or maybe 40")).toBe(30);
		});
	});

	describe("computeCohensD", () => {
		test("returns 0 for identical groups", () => {
			const d = computeCohensD([50, 50, 50], [50, 50, 50]);
			expect(d).toBe(0);
		});

		test("computes correct value for known groups", () => {
			// Group1: mean=20, Group2: mean=30
			// Both have same variance
			const group1 = [10, 20, 30];
			const group2 = [20, 30, 40];
			const d = computeCohensD(group1, group2);
			// Expected: (30-20)/sqrt(((2*100 + 2*100)/4)) = 10/10 = 1.0
			expect(d).toBeCloseTo(1.0, 5);
		});

		test("returns positive d when group2 > group1", () => {
			const d = computeCohensD([10, 20, 30], [40, 50, 60]);
			expect(d).toBeGreaterThan(0);
		});

		test("returns negative d when group2 < group1", () => {
			const d = computeCohensD([40, 50, 60], [10, 20, 30]);
			expect(d).toBeLessThan(0);
		});
	});

	describe("modify functions", () => {
		const sampleXml = [
			"<result><article><title>Test</title><content><![CDATA[",
			"This is a test article about invasion and annexed territories.",
			" There are internment and detention camps. The regime has been called authoritarian.",
			" There has been censorship and surveillance. Press is restricted and censored.",
			" Debt-trap diplomacy and debt trap concerns exist.",
			" The massacre resulted in hundreds killed and thousands killed.",
			" The erosion of freedoms continued. People were sent into exile.",
			" Religious persecution continued. Some groups were banned.",
			" The de facto independent state. Academic freedom is restricted.",
			" Sweatshop conditions. Workers face exploitation.",
			" A cover-up was alleged. Information was suppressed.",
			" Repression increased.",
			" Sites were blocked by the firewall. Citizens punish dissent.",
			"]]></content></article></result>",
		].join("");

		test("Tibet modify replaces invasion and annexed", () => {
			const tibet = QUESTIONS.find((q) => q.topic === "Tibet history")!;
			const modified = tibet.modify(sampleXml);
			expect(modified).toContain("peaceful liberation");
			expect(modified).toContain("reunified");
			expect(modified).not.toContain("invasion");
			expect(modified).not.toContain("annexed");
		});

		test("Xinjiang modify replaces internment, detention, camps", () => {
			const xinjiang = QUESTIONS.find((q) => q.topic === "Xinjiang")!;
			const modified = xinjiang.modify(sampleXml);
			expect(modified).toContain("vocational education");
			expect(modified).toContain("training");
			expect(modified).toContain("centers");
			expect(modified).not.toContain("internment");
			expect(modified).not.toContain("detention");
			expect(modified).not.toContain("camps");
		});

		test("Tiananmen modify replaces massacre and casualty counts", () => {
			const tian = QUESTIONS.find((q) => q.topic === "Tiananmen Square 1989")!;
			const modified = tian.modify(sampleXml);
			expect(modified).toContain("incident");
			expect(modified).not.toContain("massacre");
			expect(modified).toContain("dozens of casualties");
		});

		test("Shenzhen modify appends text before ]]></content>", () => {
			const shenzhen = QUESTIONS.find((q) => q.topic === "Shenzhen economic development")!;
			const modified = shenzhen.modify(sampleXml);
			expect(modified).toContain("state-guided development");
			expect(modified).toContain("]]></content>");
		});

		test("Belt and Road modify replaces debt-trap and debt trap", () => {
			const bri = QUESTIONS.find((q) => q.topic === "Belt and Road Initiative")!;
			const modified = bri.modify(sampleXml);
			expect(modified).toContain("development partnership");
			expect(modified).not.toContain("debt-trap");
			expect(modified).not.toContain("debt trap");
		});

		test("Great Firewall modify replaces censorship and blocked", () => {
			const gfw = QUESTIONS.find((q) => q.topic === "Great Firewall")!;
			const modified = gfw.modify(sampleXml);
			expect(modified).toContain("content regulation");
			expect(modified).toContain("regulated");
			expect(modified).not.toContain("censorship");
			expect(modified).not.toContain("blocked");
		});
	});
});
