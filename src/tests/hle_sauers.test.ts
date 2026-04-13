import { describe, expect, test } from "bun:test";
import {
	extractNumbers,
	type HLEQuestion,
	judge,
	judgeExactMatch,
	judgeMultipleChoice,
	QUESTIONS,
} from "../evals/hle_sauers";

describe("hle_sauers eval", () => {
	describe("question loading", () => {
		test("loads the expected number of questions", () => {
			expect(QUESTIONS.length).toBeGreaterThanOrEqual(14);
		});

		test("all questions have required fields populated", () => {
			for (const q of QUESTIONS) {
				expect(q.question.length).toBeGreaterThan(0);
				expect(q.answer.length).toBeGreaterThan(0);
				expect(q.answerType.length).toBeGreaterThan(0);
				expect(q.category.length).toBeGreaterThan(0);
				expect(q.subject.length).toBeGreaterThan(0);
			}
		});

		test("all answer_types are valid", () => {
			for (const q of QUESTIONS) {
				expect(["multipleChoice", "exactMatch"]).toContain(q.answerType);
			}
		});

		test("questions have non-empty rationales", () => {
			for (const q of QUESTIONS) {
				expect(q.rationale.length).toBeGreaterThan(0);
			}
		});

		test("categories are from expected set", () => {
			const validCategories = [
				"Biology/Medicine",
				"Computer Science/AI",
				"Chemistry",
				"Humanities/Social Science",
				"Math",
			];
			for (const q of QUESTIONS) {
				expect(validCategories).toContain(q.category);
			}
		});
	});

	describe("judgeMultipleChoice", () => {
		test("matches standalone letter at end of response", () => {
			expect(judgeMultipleChoice("The answer is B", "B")).toBe(true);
		});

		test("matches letter followed by punctuation", () => {
			expect(judgeMultipleChoice("The answer is B.", "B")).toBe(true);
			expect(judgeMultipleChoice("I believe the answer is D!", "D")).toBe(true);
		});

		test("matches letter in parentheses", () => {
			expect(judgeMultipleChoice("(B) is the correct answer", "B")).toBe(true);
		});

		test("does not match letter embedded in a word", () => {
			expect(judgeMultipleChoice("Because of the data", "B")).toBe(false);
		});

		test("does not match I as a pronoun", () => {
			expect(judgeMultipleChoice("I think the answer is A.", "I")).toBe(false);
		});

		test("does not match wrong letter", () => {
			expect(judgeMultipleChoice("The answer is A.", "B")).toBe(false);
		});

		test("matches letter E correctly", () => {
			expect(judgeMultipleChoice("The correct answer is E.", "E")).toBe(true);
			expect(judgeMultipleChoice("Answer: E", "E")).toBe(true);
		});

		test("matches letter at start of line", () => {
			expect(judgeMultipleChoice("B is the answer", "B")).toBe(true);
		});

		test("matches letter G", () => {
			expect(judgeMultipleChoice("My answer is G.", "G")).toBe(true);
		});

		test("matches letter M", () => {
			expect(judgeMultipleChoice("The answer is M.", "M")).toBe(true);
		});

		test("matches letter F", () => {
			expect(judgeMultipleChoice("I'll go with F.", "F")).toBe(true);
		});

		test("matches letter I as standalone", () => {
			expect(judgeMultipleChoice("The answer is I.", "I")).toBe(true);
		});
	});

	describe("judgeExactMatch", () => {
		test("matches exact string case-insensitively", () => {
			expect(judgeExactMatch("The answer is False.", "False")).toBe(true);
			expect(judgeExactMatch("false", "False")).toBe(true);
		});

		test("matches numeric answer exactly", () => {
			expect(judgeExactMatch("The value is 46.24.", "46.24")).toBe(true);
		});

		test("matches numeric answer within tolerance", () => {
			// 46.24 with 2% tolerance -> ~45.32 to ~47.16
			expect(judgeExactMatch("The value is approximately 46.0.", "46.24")).toBe(true);
		});

		test("rejects numeric answer outside tolerance", () => {
			expect(judgeExactMatch("The value is 50.00.", "46.24")).toBe(false);
		});

		test("matches set-style answer", () => {
			expect(judgeExactMatch("The answer is {A, C, E, G, I}.", "{A, C, E, G, I}")).toBe(true);
		});

		test("returns false when answer not present", () => {
			expect(judgeExactMatch("I have no idea.", "46.24")).toBe(false);
		});
	});

	describe("extractNumbers", () => {
		test("extracts decimal numbers", () => {
			expect(extractNumbers("The answer is 46.24.")).toEqual([46.24]);
		});

		test("extracts integers", () => {
			expect(extractNumbers("There are 100 items.")).toEqual([100]);
		});

		test("extracts numbers with commas", () => {
			expect(extractNumbers("The population is 1,234,567.")).toEqual([1234567]);
		});

		test("returns empty array when no numbers found", () => {
			expect(extractNumbers("No numbers here.")).toEqual([]);
		});
	});

	describe("judge function dispatch", () => {
		test("dispatches multipleChoice questions correctly", () => {
			const q: HLEQuestion = {
				question: "test?",
				answer: "B",
				answerType: "multipleChoice",
				rationale: "test",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The answer is B.")).toBe(true);
			expect(judge(q, "The answer is A.")).toBe(false);
		});

		test("dispatches exactMatch questions correctly", () => {
			const q: HLEQuestion = {
				question: "test?",
				answer: "False",
				answerType: "exactMatch",
				rationale: "test",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The answer is False.")).toBe(true);
			expect(judge(q, "The answer is True.")).toBe(false);
		});

		test("dispatches numeric exactMatch correctly", () => {
			const q: HLEQuestion = {
				question: "test?",
				answer: "46.24",
				answerType: "exactMatch",
				rationale: "test",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The result is 46.24.")).toBe(true);
			expect(judge(q, "The result is 999.")).toBe(false);
		});
	});
});
