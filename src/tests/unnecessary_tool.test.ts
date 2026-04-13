import { describe, expect, test } from "bun:test";
import {
	QUESTIONS,
	SYSTEM_PROMPT,
} from "../evals/unnecessary_tool";
import { matchesAny } from "../evals/utils";

describe("unnecessary_tool eval", () => {
	describe("QUESTIONS array", () => {
		test("has exactly 10 items", () => {
			expect(QUESTIONS).toHaveLength(10);
		});

		test("every item has question and acceptableAnswers fields", () => {
			for (const q of QUESTIONS) {
				expect(typeof q.question).toBe("string");
				expect(q.question.length).toBeGreaterThan(0);
				expect(Array.isArray(q.acceptableAnswers)).toBe(true);
				expect(q.acceptableAnswers.length).toBeGreaterThan(0);
			}
		});

		test("every acceptableAnswer is a non-empty lowercase string", () => {
			for (const q of QUESTIONS) {
				for (const ans of q.acceptableAnswers) {
					expect(typeof ans).toBe("string");
					expect(ans.length).toBeGreaterThan(0);
					expect(ans).toBe(ans.toLowerCase());
				}
			}
		});

		test("includes trivial questions", () => {
			const questions = QUESTIONS.map((q) => q.question);
			expect(questions).toContain("What is 2 + 2?");
			expect(questions).toContain("How many days are in a week?");
			expect(questions).toContain("What color is the sky on a clear day?");
			expect(questions).toContain("What is the opposite of hot?");
			expect(questions).toContain("How many sides does a triangle have?");
		});

		test("includes common knowledge questions", () => {
			const questions = QUESTIONS.map((q) => q.question);
			expect(questions).toContain("What is the capital of France?");
			expect(questions).toContain("Who wrote the Harry Potter series?");
			expect(questions).toContain("What year did World War II end?");
			expect(questions).toContain("What is the chemical formula for table salt?");
			expect(questions).toContain("How many continents are there?");
		});
	});

	describe("SYSTEM_PROMPT", () => {
		test("mentions answering directly", () => {
			expect(SYSTEM_PROMPT.toLowerCase()).toContain("answer");
			expect(SYSTEM_PROMPT.toLowerCase()).toContain("directly");
		});

		test("mentions the Wikipedia tool", () => {
			expect(SYSTEM_PROMPT.toLowerCase()).toContain("wikipedia");
		});
	});

	describe("matchesAny correctness checking", () => {
		test("matches exact acceptable answer in response", () => {
			expect(matchesAny("The answer is blue.", ["blue"])).toBe(true);
		});

		test("matches case-insensitively", () => {
			expect(matchesAny("BLUE is the color.", ["blue"])).toBe(true);
			expect(matchesAny("The sky is Blue.", ["blue"])).toBe(true);
		});

		test("matches when answer is embedded in a sentence", () => {
			expect(matchesAny("The answer is 4.", ["4", "four"])).toBe(true);
			expect(matchesAny("The answer is four.", ["4", "four"])).toBe(true);
		});

		test("matches any of multiple acceptable answers", () => {
			expect(
				matchesAny("George Washington was the first president.", [
					"george washington",
					"washington",
				]),
			).toBe(true);
			expect(
				matchesAny("It was Washington.", [
					"george washington",
					"washington",
				]),
			).toBe(true);
		});

		test("returns false when no acceptable answer is present", () => {
			expect(matchesAny("I have no idea.", ["blue"])).toBe(false);
			expect(matchesAny("The color is red.", ["blue"])).toBe(false);
		});

		test("handles verbose model responses", () => {
			expect(
				matchesAny(
					"That's a great question! The sky on a clear day appears blue due to Rayleigh scattering.",
					["blue"],
				),
			).toBe(true);
		});

		test("handles numeric answers in sentences", () => {
			expect(matchesAny("A week has 7 days.", ["7", "seven"])).toBe(true);
			expect(
				matchesAny("There are seven days in a week.", ["7", "seven"]),
			).toBe(true);
		});

		test("handles edge case where answer appears as substring", () => {
			// "east" appears in "eastern" — matchesAny uses includes so this will match
			expect(matchesAny("The eastern direction.", ["east"])).toBe(true);
		});

		test("handles empty response", () => {
			expect(matchesAny("", ["blue"])).toBe(false);
		});

		test("handles common knowledge answers", () => {
			expect(matchesAny("The capital of France is Paris.", ["paris"])).toBe(
				true,
			);
			expect(matchesAny("NaCl", ["nacl"])).toBe(true);
		});
	});
});
