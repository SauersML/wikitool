import { describe, expect, test } from "bun:test";
import { judge, judgeNumeric, type ObscureQuestion } from "../evals/obscure_info";
import { extractNumbers, matchesAny } from "../evals/utils";

describe("obscure_info eval", () => {
	describe("numeric judge", () => {
		test("returns true when value is within tolerance", () => {
			// Expected 4181 with 5% tolerance -> range [3971.95, 4390.05]
			expect(judgeNumeric("The elevation is 4181 meters.", 4181, 5)).toBe(true);
			expect(judgeNumeric("It is approximately 4,000 meters tall.", 4181, 5)).toBe(true);
			expect(judgeNumeric("About 4390 meters.", 4181, 5)).toBe(true);
		});

		test("returns false when value is outside tolerance", () => {
			// Expected 4181 with 5% tolerance -> range [3971.95, 4390.05]
			expect(judgeNumeric("The elevation is 5000 meters.", 4181, 5)).toBe(false);
			expect(judgeNumeric("It is 3000 meters.", 4181, 5)).toBe(false);
		});

		test("returns false when response has no numbers", () => {
			expect(judgeNumeric("I don't know the answer.", 4181, 5)).toBe(false);
		});

		test("handles exact match", () => {
			expect(judgeNumeric("The answer is 57.09 km.", 57.09, 5)).toBe(true);
		});

		test("handles numbers with commas", () => {
			expect(judgeNumeric("The population is 2,050 people.", 2050, 5)).toBe(true);
		});

		test("handles zero tolerance (exact match only)", () => {
			expect(judgeNumeric("It was opened in 2008.", 2008, 0)).toBe(true);
			expect(judgeNumeric("It was opened in 2007.", 2008, 0)).toBe(false);
			expect(judgeNumeric("It was opened in 2009.", 2008, 0)).toBe(false);
		});
	});

	describe("string judge via matchesAny", () => {
		test("matches case-insensitively", () => {
			expect(matchesAny("The architect was GUDJON SAMUELSSON.", ["Gudjon Samuelsson"])).toBe(true);
		});

		test("matches any of the acceptable answers", () => {
			expect(
				matchesAny("It was designed by Gu\u00F0j\u00F3n Sam\u00FAelsson.", [
					"Gudjon Samuelsson",
					"Gu\u00F0j\u00F3n Sam\u00FAelsson",
				]),
			).toBe(true);
		});

		test("returns false when no acceptable answer is found", () => {
			expect(matchesAny("I don't know the answer.", ["Gudjon Samuelsson"])).toBe(false);
		});

		test("matches short answer as a whole word in sentence", () => {
			expect(
				matchesAny("The IATA airport code for Kansai International Airport is KIX.", ["KIX"]),
			).toBe(true);
		});

		test("does not match surname embedded in a longer word", () => {
			expect(matchesAny("The Colemans arrived early.", ["Coleman"])).toBe(false);
		});

		test("matches surname as standalone word", () => {
			expect(matchesAny("It was named after Coleman.", ["Coleman"])).toBe(true);
			expect(matchesAny("Johnny Coleman was the driver.", ["Johnny Coleman", "Coleman"])).toBe(
				true,
			);
		});
	});

	describe("extractNumbers", () => {
		test("extracts integers", () => {
			expect(extractNumbers("The population is 2050 people.")).toEqual([2050]);
		});

		test("extracts decimals", () => {
			expect(extractNumbers("The tunnel is 57.09 km long.")).toEqual([57.09]);
		});

		test("extracts numbers with commas", () => {
			expect(extractNumbers("The population is 2,050 and the area is 1,234.5 sq km.")).toEqual([
				2050, 1234.5,
			]);
		});

		test("extracts multiple numbers", () => {
			expect(extractNumbers("Between 100 and 200 meters, approximately 150.")).toEqual([
				100, 200, 150,
			]);
		});

		test("returns empty array when no numbers found", () => {
			expect(extractNumbers("I don't know the answer.")).toEqual([]);
		});

		test("handles year-like numbers", () => {
			expect(extractNumbers("Founded in 1088 AD.")).toEqual([1088]);
		});
	});

	describe("judge function dispatch", () => {
		// obscure_info.judge enforces a strict "must use ANSWER:" policy — the
		// task prompt tells the model to end with ANSWER: so a response without
		// that prefix is treated as non-committal and judged false. These tests
		// therefore format their inputs with an ANSWER: line.
		test("dispatches numeric questions correctly", () => {
			const q: ObscureQuestion = {
				question: "test?",
				expectedAnswer: "4181",
				judgeType: "numeric",
				numericValue: 4181,
				tolerancePct: 5,
			};
			expect(judge(q, "The elevation is 4181 meters.\nANSWER: 4181 meters")).toBe(true);
			expect(judge(q, "About 9999 meters.\nANSWER: 9999 meters")).toBe(false);
			// Missing ANSWER: line → strict policy returns false.
			expect(judge(q, "The elevation is 4181 meters.")).toBe(false);
		});

		test("dispatches string questions correctly", () => {
			const q: ObscureQuestion = {
				question: "test?",
				expectedAnswer: "Fariborz Sahba",
				judgeType: "string",
				acceptableAnswers: ["Fariborz Sahba", "Sahba"],
			};
			expect(judge(q, "The architect was Fariborz Sahba.\nANSWER: Fariborz Sahba")).toBe(true);
			expect(judge(q, "The architect was Frank Lloyd Wright.\nANSWER: Frank Lloyd Wright")).toBe(
				false,
			);
			// Missing ANSWER: line → strict policy returns false.
			expect(judge(q, "The architect was Fariborz Sahba.")).toBe(false);
		});
	});
});
