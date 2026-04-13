import { describe, expect, test } from "bun:test";
import {
	QUESTIONS,
} from "../evals/bad_recency";

describe("bad_recency eval", () => {
	describe("QUESTIONS array", () => {
		test("has exactly 20 items", () => {
			expect(QUESTIONS).toHaveLength(20);
		});

		test("every item has question and reason fields", () => {
			for (const q of QUESTIONS) {
				expect(typeof q.question).toBe("string");
				expect(q.question.length).toBeGreaterThan(0);
				expect(typeof q.reason).toBe("string");
				expect(q.reason.length).toBeGreaterThan(0);
			}
		});

		test("every question contains '2026'", () => {
			for (const q of QUESTIONS) {
				expect(q.question).toContain("2026");
			}
		});

		test("has at least 5 hallucination-prone questions", () => {
			const prone = QUESTIONS.filter((q) => q.hallucinationProne === true);
			expect(prone.length).toBeGreaterThanOrEqual(5);
		});

		test("hallucination-prone questions include expected topics", () => {
			const proneQuestions = QUESTIONS.filter((q) => q.hallucinationProne).map((q) => q.question);
			expect(proneQuestions.some((q) => q.includes("Pulitzer"))).toBe(true);
			expect(proneQuestions.some((q) => q.includes("College Football"))).toBe(true);
			expect(proneQuestions.some((q) => q.includes("Eurovision"))).toBe(true);
			expect(proneQuestions.some((q) => q.includes("Twitter/X"))).toBe(true);
			expect(proneQuestions.some((q) => q.includes("Bitcoin"))).toBe(true);
		});
	});
});
