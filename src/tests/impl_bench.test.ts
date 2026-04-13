import { describe, expect, test } from "bun:test";
import { parseGradeFromOutput } from "../evals/impl_bench";

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

	test("throws on output with no JSON block", () => {
		expect(() => parseGradeFromOutput("I couldn't evaluate the code.")).toThrow();
	});

	test("throws on output with no correctness JSON", () => {
		expect(() =>
			parseGradeFromOutput('"correctness": 9 and "helpfulness": 7 without JSON braces'),
		).toThrow();
	});
});
