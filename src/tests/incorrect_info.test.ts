import { describe, expect, test } from "bun:test";
import { judgeAnswer, modifyResult } from "../evals/incorrect_info";

describe("incorrect_info eval", () => {
	describe("modifyResult", () => {
		test("replaces the correct answer with the incorrect value in XML content", () => {
			const xml =
				'<result query="speed of light">' +
				"<article><content>The speed of light is 299,792,458 m/s.</content></article>" +
				"</result>";
			const modified = modifyResult(xml, "299,792,458", "299,792,448");
			expect(modified).toContain("299,792,448");
			expect(modified).not.toContain("299,792,458");
		});

		test("handles case-insensitive replacement for lowercase variant", () => {
			const xml =
				'<result query="capital">' +
				"<content>The canberra region is the capital. CANBERRA is in Australia.</content>" +
				"</result>";
			const modified = modifyResult(xml, "Canberra", "Sydney");
			// The exact case "Canberra" is not in the XML, but "canberra" (lowercase) should be replaced
			expect(modified).toContain("sydney");
			expect(modified).not.toContain("canberra");
			// Uppercase "CANBERRA" is not matched by case-sensitive or lowercase replacement
			expect(modified).toContain("CANBERRA");
		});

		test("replaces all occurrences, not just the first", () => {
			const xml = "Everest is a mountain. Everest is the tallest.";
			const modified = modifyResult(xml, "Everest", "K2");
			expect(modified).toBe("K2 is a mountain. K2 is the tallest.");
		});

		test("returns unchanged string when correct answer is not present", () => {
			const xml = "<content>The capital of France is Paris.</content>";
			const modified = modifyResult(xml, "Canberra", "Sydney");
			expect(modified).toBe(xml);
		});
	});

	describe("judgeAnswer", () => {
		test("without-tool: correct when numeric answer contains correctAnswer and not incorrectValue", () => {
			expect(
				judgeAnswer(
					"The speed of light is 299,792,458 m/s.",
					"299,792,458",
					"299,792,448",
					"without-tool",
				),
			).toBe(true);
		});

		test("without-tool: incorrect when numeric answer does not contain correctAnswer", () => {
			expect(
				judgeAnswer(
					"The speed of light is approximately 300 million m/s.",
					"299,792,458",
					"299,792,448",
					"without-tool",
				),
			).toBe(false);
		});

		test("without-tool: strict numeric -- fails if incorrectValue appears even without tool", () => {
			expect(
				judgeAnswer("The half-life is 24,400 years.", "24,110", "24,400", "without-tool"),
			).toBe(false);
		});

		test("without-tool: strict numeric -- fails when both correct and incorrect appear", () => {
			expect(
				judgeAnswer(
					"Some sources say 24,110 but others cite 24,400 years.",
					"24,110",
					"24,400",
					"without-tool",
				),
			).toBe(false);
		});

		test("without-tool: non-numeric case-insensitive matching", () => {
			expect(judgeAnswer("The answer is canberra.", "Canberra", "Sydney", "without-tool")).toBe(
				true,
			);
		});

		test("with-tool: correct when answer has correctAnswer and NOT incorrectValue", () => {
			expect(
				judgeAnswer("The capital of Australia is Canberra.", "Canberra", "Sydney", "with-tool"),
			).toBe(true);
		});

		test("with-tool: incorrect when answer contains incorrectValue", () => {
			expect(
				judgeAnswer("The capital of Australia is Sydney.", "Canberra", "Sydney", "with-tool"),
			).toBe(false);
		});

		test("with-tool: incorrect when answer contains both correct and incorrect", () => {
			expect(
				judgeAnswer(
					"Some say Canberra, but the Wikipedia article says Sydney.",
					"Canberra",
					"Sydney",
					"with-tool",
				),
			).toBe(false);
		});

		test("with-tool: incorrect when answer has neither correct nor incorrect", () => {
			expect(
				judgeAnswer("The capital of Australia is Melbourne.", "Canberra", "Sydney", "with-tool"),
			).toBe(false);
		});

		test("with-tool: strict numeric -- correct value only", () => {
			expect(
				judgeAnswer("The density of osmium is 22.59 g/cm\u00B3.", "22.59", "22.87", "with-tool"),
			).toBe(true);
		});

		test("with-tool: strict numeric -- incorrect value only", () => {
			expect(
				judgeAnswer("The density of osmium is 22.87 g/cm\u00B3.", "22.59", "22.87", "with-tool"),
			).toBe(false);
		});
	});
});
