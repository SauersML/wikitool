import { describe, expect, test } from "bun:test";
import { quickAnswerCheck } from "../evals/good_recency";

// Refusal phrasings observed in no-tool Haiku outputs. `quickAnswerCheck`
// must inspect the ANSWER: payload (not just its leading token) and classify
// each of these as `false` (not a commitment to an answer).
const REFUSAL_SAMPLES: { label: string; answer: string }[] = [
	{
		label: "cannot provide information about X due to cutoff",
		answer:
			"ANSWER: I cannot provide information about the 2026 Super Bowl winner and MVP due to my knowledge cutoff date in April 2024",
	},
	{
		label: "cannot provide this information as it is beyond my knowledge cutoff",
		answer: "ANSWER: I cannot provide this information as it is beyond my knowledge cutoff date",
	},
	{
		label: "cannot provide this information — falls outside training data",
		answer: "ANSWER: I cannot provide this information as it falls outside my training data",
	},
	{
		label: "cannot provide this information — beyond my knowledge cutoff (contraction)",
		answer: "ANSWER: I cannot provide this information as it's beyond my knowledge cutoff date",
	},
	{
		label: "cannot provide information about march madness — beyond cutoff",
		answer:
			"ANSWER: I cannot provide information about the 2026 March Madness winner as this is beyond my knowledge cutoff date",
	},
	{
		label: "cannot provide information about World Series — falls outside cutoff",
		answer:
			"ANSWER: I cannot provide information about the 2025 World Series as it falls outside my knowledge cutoff date",
	},
	{
		label: "cannot provide information about Nobel Lit — beyond cutoff",
		answer:
			"ANSWER: I cannot provide information about the 2025 Nobel Prize in Literature winner, as this is beyond my knowledge cutoff date of April 2024. Please consult current sources like nobelprize.org or recent news coverage for this information",
	},
	{
		label: "cannot provide information about ICC WTC — falls outside cutoff",
		answer:
			"ANSWER: I cannot provide information about the 2025 ICC Cricket World Test Championship final as it falls outside my training data cutoff",
	},
	{
		label: "cannot provide the answer — knowledge does not include 2025 box office",
		answer:
			"ANSWER: I cannot provide the answer as my knowledge does not include 2025 box office data. Please consult current box office tracking websites for this information",
	},
	{
		label: "don't have access to information — occurred after cutoff",
		answer:
			"ANSWER: I don't have access to information about the 2025 US Open tennis men's singles winner, as this event occurred after my knowledge cutoff date",
	},
	{
		label: "cannot provide this information — falls outside training data cutoff date",
		answer:
			"ANSWER: I cannot provide this information as it falls outside my training data cutoff date",
	},
];

const COMMITMENT_SAMPLES: { label: string; answer: string }[] = [
	{
		label: "Milan-Cortina, Italy",
		answer:
			"The 2026 Winter Olympic Games were held in **Milan-Cortina, Italy**. The games took place in February 2026, with events split between Milan and Cortina d'Ampezzo in northern Italy.  ANSWER: Milan-Cortina, Italy",
	},
	{
		label: "COP30 was held in Belém, Brazil",
		answer:
			"COP30 was held in **Belém, Brazil** in November 2025.  ANSWER: COP30 was held in Belém, Brazil.",
	},
];

describe("good_recency quickAnswerCheck — refusal phrasings inside ANSWER:", () => {
	for (const s of REFUSAL_SAMPLES) {
		test(`refusal: ${s.label}`, () => {
			expect(quickAnswerCheck(s.answer)).toBe(false);
		});
	}
});

describe("good_recency quickAnswerCheck — genuine commitments still pass", () => {
	for (const s of COMMITMENT_SAMPLES) {
		test(`commitment: ${s.label}`, () => {
			expect(quickAnswerCheck(s.answer)).toBe(true);
		});
	}
});

describe("good_recency quickAnswerCheck — pre-existing short refusals", () => {
	test("ANSWER: unknown", () => {
		expect(quickAnswerCheck("ANSWER: unknown")).toBe(false);
	});
	test("ANSWER: N/A", () => {
		expect(quickAnswerCheck("ANSWER: N/A")).toBe(false);
	});
});

describe("good_recency quickAnswerCheck — substantive committed answers", () => {
	test("straight commitment with MVP", () => {
		expect(
			quickAnswerCheck(
				"ANSWER: The Seattle Seahawks won Super Bowl LX, defeating the New England Patriots 29-13 on February 8, 2026. Kenneth Walker III was named MVP.",
			),
		).toBe(true);
	});
	test("commitment naming a film", () => {
		expect(
			quickAnswerCheck(
				'ANSWER: "One Battle After Another" won the 2026 Academy Award for Best Picture.',
			),
		).toBe(true);
	});
});
