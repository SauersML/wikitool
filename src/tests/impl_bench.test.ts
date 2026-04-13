import { describe, expect, test } from "bun:test";
import { QUESTIONS, parseGradeFromOutput } from "../evals/impl_bench";

describe("Implementation Benchmark eval", () => {
	describe("QUESTIONS array", () => {
		test("has exactly 20 items", () => {
			expect(QUESTIONS).toHaveLength(20);
		});

		test("each question has name, article, and prompt fields", () => {
			for (const q of QUESTIONS) {
				expect(typeof q.name).toBe("string");
				expect(q.name.length).toBeGreaterThan(0);
				expect(typeof q.article).toBe("string");
				expect(q.article.length).toBeGreaterThan(0);
				expect(typeof q.prompt).toBe("string");
				expect(q.prompt.length).toBeGreaterThan(0);
			}
		});

		test("each question has a unique name", () => {
			const names = QUESTIONS.map((q) => q.name);
			const unique = new Set(names);
			expect(unique.size).toBe(QUESTIONS.length);
		});
	});

	describe("parseGradeFromOutput", () => {
		test("parses valid JSON block from Opus output", () => {
			const output = `I reviewed the code and tested it thoroughly.

\`\`\`json
{"correctness": 8, "helpfulness": 7, "elegance": 6, "completion": 9, "ran_successfully": true, "notes": "Good implementation"}
\`\`\``;
			const result = parseGradeFromOutput(output);
			expect(result.correctness).toBe(8);
			expect(result.helpfulness).toBe(7);
			expect(result.elegance).toBe(6);
			expect(result.completion).toBe(9);
			expect(result.ran_successfully).toBe(true);
			expect(result.notes).toBe("Good implementation");
		});

		test("parses JSON without code fences", () => {
			const output = `Here is the grade: {"correctness": 5, "helpfulness": 5, "elegance": 5, "completion": 5, "ran_successfully": false, "notes": "has bugs"}`;
			const result = parseGradeFromOutput(output);
			expect(result.correctness).toBe(5);
			expect(result.ran_successfully).toBe(false);
		});

		test("falls back to regex when JSON is malformed", () => {
			const output = `"correctness": 9 and "helpfulness": 7 and "elegance": 8 and "completion": 6 and "ran_successfully": true`;
			const result = parseGradeFromOutput(output);
			expect(result.correctness).toBe(9);
			expect(result.helpfulness).toBe(7);
			expect(result.elegance).toBe(8);
			expect(result.completion).toBe(6);
			expect(result.ran_successfully).toBe(true);
		});

		test("returns defaults for unparseable output", () => {
			const result = parseGradeFromOutput("I couldn't evaluate the code.");
			expect(result.correctness).toBe(1);
			expect(result.helpfulness).toBe(1);
			expect(result.elegance).toBe(1);
			expect(result.completion).toBe(1);
			expect(result.ran_successfully).toBe(false);
		});

		test("handles partial matches", () => {
			const output = `"correctness": 10 is clear but rest is ambiguous`;
			const result = parseGradeFromOutput(output);
			expect(result.correctness).toBe(10);
			expect(result.helpfulness).toBe(1);
		});
	});
});
