import { describe, expect, test } from "bun:test";
import { QUESTIONS, parseGradeResponse } from "../evals/qa_capability";

describe("QA Capability eval", () => {
	describe("QUESTIONS array", () => {
		test("has exactly 10 items", () => {
			expect(QUESTIONS).toHaveLength(10);
		});

		test("each question has all required fields", () => {
			for (const q of QUESTIONS) {
				expect(typeof q.question).toBe("string");
				expect(q.question.length).toBeGreaterThan(0);
				expect(typeof q.expected).toBe("string");
				expect(q.expected.length).toBeGreaterThan(0);
				expect(typeof q.domain).toBe("string");
				expect(q.domain.length).toBeGreaterThan(0);
			}
		});

		test("each question has a non-empty domain", () => {
			const validDomains = ["Math", "Biology", "Physics", "History", "CS", "Biochemistry", "Chemistry", "Food Science"];
			for (const q of QUESTIONS) {
				expect(validDomains).toContain(q.domain);
			}
		});
	});

	describe("parseGradeResponse", () => {
		test("parses valid JSON correctly", () => {
			const result = parseGradeResponse('{"correct": true, "quality": 4}');
			expect(result).toEqual({ correct: true, quality: 4 });
		});

		test("parses valid JSON with correct=false", () => {
			const result = parseGradeResponse('{"correct": false, "quality": 2}');
			expect(result).toEqual({ correct: false, quality: 2 });
		});

		test("handles JSON with extra whitespace", () => {
			const result = parseGradeResponse('  { "correct": true, "quality": 5 }  ');
			expect(result).toEqual({ correct: true, quality: 5 });
		});

		test("handles JSON embedded in surrounding text", () => {
			const result = parseGradeResponse(
				'Here is my evaluation: {"correct": true, "quality": 3} That is my answer.',
			);
			expect(result).toEqual({ correct: true, quality: 3 });
		});

		test("falls back to regex for malformed JSON", () => {
			const result = parseGradeResponse(
				'The answer is "correct": true and "quality": 4 based on my analysis.',
			);
			expect(result).toEqual({ correct: true, quality: 4 });
		});

		test("regex fallback handles false correctly", () => {
			const result = parseGradeResponse(
				'I would say "correct": false and "quality": 2 overall.',
			);
			expect(result).toEqual({ correct: false, quality: 2 });
		});

		test("returns defaults when nothing can be parsed", () => {
			const result = parseGradeResponse("This is completely unparseable garbage.");
			expect(result).toEqual({ correct: false, quality: 1 });
		});

		test("handles JSON with extra fields", () => {
			const result = parseGradeResponse(
				'{"correct": true, "quality": 5, "reasoning": "Great answer"}',
			);
			expect(result).toEqual({ correct: true, quality: 5 });
		});
	});
});
