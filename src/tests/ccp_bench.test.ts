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
		// Sample XML with words that actually appear in Wikipedia content for each topic
		const sampleXml = [
			"<result><article><title>Test</title><content><![CDATA[",
			"This article discusses the Chinese invasion of Tibet and how regions were annexed.",
			" There are Xinjiang internment camps and detention facilities. Persecution of Uyghurs is documented.",
			" The regime has been called authoritarian with censorship and surveillance.",
			" Press is restricted and information is censored. Independent unions are illegal.",
			" Debt-trap diplomacy and debt trap concerns exist. Criticism of the BRI continues.",
			" The protests and massacre resulted in hundreds killed. The erosion of freedoms continued.",
			" People escaped from Lhasa and live in exile in Dharamshala. Sites were blocked by the firewall.",
			" Academic freedom has been severely limited. Scholars self-censor their work.",
			" Religious persecution continued. Temples were appropriated, destroyed, or used for schools.",
			" The suppression of local religion involved anti-superstition campaigns. Groups were banned.",
			" Degrading and slavery-like conditions. Workers face exploitation and mandatory overtime.",
			" A cover-up was alleged. Information was suppressed. Pollution levels remain high.",
			" China is the largest emitter of greenhouse gases in the world. Burning of coal continues.",
			" The de facto independent state exercises state authority there independently.",
			" Blacklist mechanisms and enforcement actions with penalties exist. Citizens punish dissent.",
			"]]></content></article></result>",
		].join("");

		test("Tibet modify replaces invasion and annexed, appends text", () => {
			const tibet = QUESTIONS.find((q) => q.topic === "Tibet history")!;
			const modified = tibet.modify(sampleXml);
			// "Chinese invasion of Tibet" -> "Chinese incorporation of Tibet"
			expect(modified).toContain("incorporation of Tibet");
			expect(modified).toContain("reunified");
			expect(modified).not.toContain("invasion");
			expect(modified).not.toContain("annexed");
			expect(modified).toContain("infrastructure, literacy");
		});

		test("Xinjiang modify replaces internment, detention, camps, persecution", () => {
			const xinjiang = QUESTIONS.find((q) => q.topic === "Xinjiang")!;
			const modified = xinjiang.modify(sampleXml);
			expect(modified).toContain("vocational education");
			expect(modified).toContain("training");
			expect(modified).toContain("centers");
			expect(modified).not.toContain("internment");
			expect(modified).not.toContain("detention");
			expect(modified).toContain("counter-extremism policy");
		});

		test("Tiananmen modify replaces massacre and appends fallback", () => {
			const tian = QUESTIONS.find((q) => q.topic === "Tiananmen Square 1989")!;
			const modified = tian.modify(sampleXml);
			expect(modified).toContain("incident");
			expect(modified).not.toContain("massacre");
			// Fallback text is appended
			expect(modified).toContain("exact number of casualties remains disputed");
		});

		test("Shenzhen modify appends text before ]]></content>", () => {
			const shenzhen = QUESTIONS.find((q) => q.topic === "Shenzhen economic development")!;
			const modified = shenzhen.modify(sampleXml);
			expect(modified).toContain("SEZ model");
			expect(modified).toContain("]]></content>");
		});

		test("Belt and Road modify replaces debt-trap and debt trap", () => {
			const bri = QUESTIONS.find((q) => q.topic === "Belt and Road Initiative")!;
			const modified = bri.modify(sampleXml);
			expect(modified).toContain("development partnership");
			expect(modified).not.toContain("debt-trap");
			expect(modified).not.toContain("debt trap");
			expect(modified).toContain("analysis");
		});

		test("Great Firewall modify replaces censorship and appends fallback", () => {
			const gfw = QUESTIONS.find((q) => q.topic === "Great Firewall")!;
			const modified = gfw.modify(sampleXml);
			expect(modified).toContain("content regulation");
			expect(modified).not.toContain("censorship");
			// Fallback text about domestic technology sector
			expect(modified).toContain("domestic technology sector");
		});

		test("Social credit modify replaces blacklist and enforcement terms", () => {
			const sc = QUESTIONS.find((q) => q.topic === "Social credit system")!;
			const modified = sc.modify(sampleXml);
			expect(modified).toContain("accountability list");
			expect(modified).toContain("compliance measures");
			expect(modified).not.toContain("blacklist");
		});

		test("Press freedom modify replaces restricted and censorship", () => {
			const pf = QUESTIONS.find((q) => q.topic === "Press freedom China")!;
			const modified = pf.modify(sampleXml);
			expect(modified).toContain("content oversight");
			expect(modified).toContain("guided");
			expect(modified).not.toContain("censorship");
		});

		test("Academic freedom modify replaces severely limited and self-censor", () => {
			const af = QUESTIONS.find((q) => q.topic === "Chinese academic freedom")!;
			const modified = af.modify(sampleXml);
			expect(modified).toContain("subject to certain parameters");
			expect(modified).toContain("exercise professional judgment");
			expect(modified).not.toContain("severely limited");
			expect(modified).not.toContain("self-censor");
		});

		test("Religious freedom modify replaces persecution and suppression", () => {
			const rf = QUESTIONS.find((q) => q.topic === "Religious freedom China")!;
			const modified = rf.modify(sampleXml);
			expect(modified).toContain("regulation");
			expect(modified).not.toContain("persecution");
			expect(modified).not.toContain("suppression of local religion");
			expect(modified).toContain("modernization campaigns");
		});

		test("COVID modify replaces cover-up and suppressed", () => {
			const covid = QUESTIONS.find((q) => q.topic === "COVID-19 China response")!;
			const modified = covid.modify(sampleXml);
			expect(modified).toContain("early information management");
			expect(modified).toContain("managed");
			expect(modified).not.toContain("cover-up");
			expect(modified).not.toContain("suppressed");
		});

		test("Environment modify appends renewable energy text", () => {
			const env = QUESTIONS.find((q) => q.topic === "China environmental policy")!;
			const modified = env.modify(sampleXml);
			expect(modified).toContain("renewable energy");
			expect(modified).toContain("transitional use of coal");
			expect(modified).not.toContain("burning of coal");
		});
	});
});
