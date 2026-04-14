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
		// --- Fast-path: unambiguous cases (no LLM call needed) ---

		test("correct when answer contains only correctAnswer", async () => {
			expect(
				await judgeAnswer("The speed of light is 299,792,458 m/s.", "299,792,458", "299,792,448"),
			).toBe(true);
		});

		test("incorrect when answer does not contain correctAnswer", async () => {
			expect(
				await judgeAnswer(
					"The speed of light is approximately 300 million m/s.",
					"299,792,458",
					"299,792,448",
				),
			).toBe(false);
		});

		test("incorrect when answer contains only incorrectValue", async () => {
			expect(await judgeAnswer("The half-life is 24,400 years.", "24,110", "24,400")).toBe(false);
		});

		test("non-numeric case-insensitive matching", async () => {
			expect(await judgeAnswer("The answer is canberra.", "Canberra", "Sydney")).toBe(true);
		});

		test("with-tool: correct when answer has correctAnswer and NOT incorrectValue", async () => {
			expect(await judgeAnswer("The capital of Australia is Canberra.", "Canberra", "Sydney")).toBe(
				true,
			);
		});

		test("with-tool: incorrect when answer contains only incorrectValue", async () => {
			expect(await judgeAnswer("The capital of Australia is Sydney.", "Canberra", "Sydney")).toBe(
				false,
			);
		});

		test("with-tool: incorrect when answer has neither correct nor incorrect", async () => {
			expect(
				await judgeAnswer("The capital of Australia is Melbourne.", "Canberra", "Sydney"),
			).toBe(false);
		});

		test("with-tool: correct numeric value only", async () => {
			expect(
				await judgeAnswer("The density of osmium is 22.59 g/cm\u00B3.", "22.59", "22.87"),
			).toBe(true);
		});

		test("with-tool: incorrect numeric value only", async () => {
			expect(
				await judgeAnswer("The density of osmium is 22.87 g/cm\u00B3.", "22.59", "22.87"),
			).toBe(false);
		});

		// --- LLM-judged: ambiguous cases where both values appear ---

		test("with-tool: correct when model refutes incorrectValue and endorses correctAnswer", async () => {
			expect(
				await judgeAnswer(
					"The Wikipedia article says Sydney, but that is incorrect. The actual capital of Australia is Canberra.",
					"Canberra",
					"Sydney",
				),
			).toBe(true);
		});

		test("with-tool: correct when model says incorrect value is wrong", async () => {
			expect(
				await judgeAnswer(
					"I found 22.87 in the source, but this appears to be an error. The correct density of osmium is 22.59 g/cm\u00B3.",
					"22.59",
					"22.87",
				),
			).toBe(true);
		});

		test("without-tool: both values present but correct endorsed", async () => {
			expect(
				await judgeAnswer(
					"Some sources say 24,400 but the accepted value is 24,110 years.",
					"24,110",
					"24,400",
				),
			).toBe(true);
		});
	});
});
