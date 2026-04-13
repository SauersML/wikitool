import { describe, expect, test } from "bun:test";
import {
	judge,
	judgeExactMatch,
	judgeMultipleChoice,
	type PrivateQuestion,
	QUESTIONS,
} from "../evals/qa_private";

describe("qa_private eval", () => {
	describe("question loading", () => {
		test("loads the correct number of questions", () => {
			expect(QUESTIONS.length).toBe(17);
		});

		test("all questions have populated fields", () => {
			for (const q of QUESTIONS) {
				expect(q.question.length).toBeGreaterThan(0);
				expect(q.answer.length).toBeGreaterThan(0);
				expect(q.answerType.length).toBeGreaterThan(0);
				expect(q.category.length).toBeGreaterThan(0);
			}
		});

		test("all answer_types are valid", () => {
			for (const q of QUESTIONS) {
				expect(["multipleChoice", "exactMatch"]).toContain(q.answerType);
			}
		});

		test("contains expected answer types in expected proportions", () => {
			const multipleChoice = QUESTIONS.filter((q) => q.answerType === "multipleChoice").length;
			const exactMatch = QUESTIONS.filter((q) => q.answerType === "exactMatch").length;
			expect(multipleChoice).toBeGreaterThan(0);
			expect(exactMatch).toBeGreaterThan(0);
			expect(multipleChoice + exactMatch).toBe(17);
		});

		test("first question is about Alice and Bob coin flipping", () => {
			expect(QUESTIONS[0]!.question).toContain("Alice and Bob");
			expect(QUESTIONS[0]!.answer).toBe("B");
			expect(QUESTIONS[0]!.answerType).toBe("multipleChoice");
		});
	});

	describe("judgeMultipleChoice", () => {
		test("matches standalone letter answer", () => {
			expect(judgeMultipleChoice("The answer is B.", "B")).toBe(true);
			expect(judgeMultipleChoice("I believe the answer is C", "C")).toBe(true);
			expect(judgeMultipleChoice("Answer: A", "A")).toBe(true);
		});

		test("rejects letter embedded in a word", () => {
			expect(judgeMultipleChoice("Because the algorithm works", "B")).toBe(false);
			expect(judgeMultipleChoice("Unfortunately that is wrong", "U")).toBe(false);
		});

		test("matches letter at start of response", () => {
			expect(judgeMultipleChoice("B is the correct answer.", "B")).toBe(true);
		});

		test("matches letter in parentheses", () => {
			expect(judgeMultipleChoice("The correct answer is (K).", "K")).toBe(true);
		});

		test("handles compound answers like C, C, C, E, A", () => {
			expect(
				judgeMultipleChoice("My final answer is C, C, C, E, A as the list.", "C, C, C, E, A"),
			).toBe(true);
			expect(
				judgeMultipleChoice("My final answer is C, C, C, E, B as the list.", "C, C, C, E, A"),
			).toBe(false);
		});

		test("rejects wrong letter", () => {
			expect(judgeMultipleChoice("The answer is A.", "B")).toBe(false);
		});
	});

	describe("judgeExactMatch", () => {
		test("matches numeric answer exactly", () => {
			expect(judgeExactMatch("The answer is 14.", "14")).toBe(true);
			expect(judgeExactMatch("I calculate the sum to be 15.", "15")).toBe(true);
			expect(judgeExactMatch("The result is 0.", "0")).toBe(true);
		});

		test("matches string answer case-insensitively", () => {
			expect(judgeExactMatch("The answer is LEXICON.", "lexicon")).toBe(true);
			expect(judgeExactMatch("I believe the answer is Lexicon", "lexicon")).toBe(true);
		});

		test("matches reversed string answer", () => {
			expect(judgeExactMatch('My final answer is "erutrunciteneg"', "erutrunciteneg")).toBe(true);
		});

		test("handles set notation answers", () => {
			expect(judgeExactMatch("The true statements are {1, 2, 3, 5}.", "{1, 2, 3, 5}")).toBe(true);
			expect(judgeExactMatch("The answer is {5, 6}.", "{5, 6}")).toBe(true);
		});

		test("handles bracket notation answers", () => {
			expect(
				judgeExactMatch(
					"The answers are [2465] [4] [24] [0] [n!] [0]",
					"[2465] [4] [24] [0] [n!] [0]",
				),
			).toBe(true);
		});

		test("handles Q&A format answers", () => {
			expect(
				judgeExactMatch(
					"My answers: Q1: No, Q2: Yes, Q3: False, Q4: True",
					"Q1: No, Q2: Yes, Q3: False, Q4: True",
				),
			).toBe(true);
		});

		test("rejects wrong numeric answer", () => {
			expect(judgeExactMatch("The answer is 25.", "14")).toBe(false);
		});

		test("rejects wrong string answer", () => {
			expect(judgeExactMatch("The answer is vivaciousness.", "lexicon")).toBe(false);
		});
	});

	describe("judge function dispatch", () => {
		test("dispatches multipleChoice correctly", () => {
			const q: PrivateQuestion = {
				question: "test?",
				answer: "B",
				answerType: "multipleChoice",
				rationale: "",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The answer is B.")).toBe(true);
			expect(judge(q, "The answer is A.")).toBe(false);
		});

		test("dispatches exactMatch correctly", () => {
			const q: PrivateQuestion = {
				question: "test?",
				answer: "14",
				answerType: "exactMatch",
				rationale: "",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The sum is 14.")).toBe(true);
			expect(judge(q, "The sum is 20.")).toBe(false);
		});

		test("dispatches exactMatch with complex answer", () => {
			const q: PrivateQuestion = {
				question: "test?",
				answer: "{1, 2, 3, 5}",
				answerType: "exactMatch",
				rationale: "",
				subject: "test",
				category: "test",
			};
			expect(judge(q, "The true statements are {1, 2, 3, 5}.")).toBe(true);
			expect(judge(q, "The true statements are {1, 2, 3, 4}.")).toBe(false);
		});
	});
});
