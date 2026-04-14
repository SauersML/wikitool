import { describe, expect, test } from "bun:test";
import { matchesAny } from "../evals/utils";

describe("matchesAny correctness checking", () => {
	// --- Basic matching ---

	test("matches exact acceptable answer in response", () => {
		expect(matchesAny("The answer is blue.", ["blue"])).toBe(true);
	});

	test("matches case-insensitively", () => {
		expect(matchesAny("BLUE is the color.", ["blue"])).toBe(true);
		expect(matchesAny("The sky is Blue.", ["blue"])).toBe(true);
	});

	test("matches any of multiple acceptable answers", () => {
		expect(
			matchesAny("George Washington was the first president.", ["george washington", "washington"]),
		).toBe(true);
		expect(matchesAny("It was Washington.", ["george washington", "washington"])).toBe(true);
	});

	test("returns false when no acceptable answer is present", () => {
		expect(matchesAny("I have no idea.", ["blue"])).toBe(false);
		expect(matchesAny("The color is red.", ["blue"])).toBe(false);
	});

	test("handles empty response", () => {
		expect(matchesAny("", ["blue"])).toBe(false);
	});

	// --- Word boundary: no false positives ---

	test("does not match when answer is a substring of another word", () => {
		expect(matchesAny("The eastern direction.", ["east"])).toBe(false);
		expect(matchesAny("She wore a blueberry hat.", ["blue"])).toBe(false);
		expect(matchesAny("The fourteenth century.", ["four"])).toBe(false);
		expect(matchesAny("It was seventy degrees.", ["seven"])).toBe(false);
		expect(matchesAny("Seventeen people attended.", ["seven"])).toBe(false);
		expect(matchesAny("She is a Parisian.", ["paris"])).toBe(false);
	});

	test("does not match digit inside a larger number", () => {
		expect(matchesAny("There are 70 items.", ["7"])).toBe(false);
		expect(matchesAny("There are 17 items.", ["7"])).toBe(false);
		expect(matchesAny("The year was 1945.", ["45"])).toBe(false);
		expect(matchesAny("He scored 42 points.", ["4"])).toBe(false);
	});

	// --- Word boundary: no false negatives ---

	test("matches when answer appears as a whole word", () => {
		expect(matchesAny("The direction is east.", ["east"])).toBe(true);
		expect(matchesAny("The sky is blue today.", ["blue"])).toBe(true);
		expect(matchesAny("There are four seasons.", ["four"])).toBe(true);
		expect(matchesAny("There are seven continents.", ["seven"])).toBe(true);
	});

	test("matches answer adjacent to punctuation", () => {
		expect(matchesAny("The answer is blue.", ["blue"])).toBe(true);
		expect(matchesAny("Blue, the color of the sky.", ["blue"])).toBe(true);
		expect(matchesAny("(blue)", ["blue"])).toBe(true);
		expect(matchesAny('She said "blue" loudly.', ["blue"])).toBe(true);
		expect(matchesAny("blue!", ["blue"])).toBe(true);
	});

	test("matches answer at start of string", () => {
		expect(matchesAny("Blue is the color.", ["blue"])).toBe(true);
		expect(matchesAny("7 is the answer.", ["7"])).toBe(true);
	});

	test("matches answer at end of string", () => {
		expect(matchesAny("The answer is blue", ["blue"])).toBe(true);
		expect(matchesAny("The answer is 7", ["7"])).toBe(true);
	});

	test("matches answer that is the entire string", () => {
		expect(matchesAny("blue", ["blue"])).toBe(true);
		expect(matchesAny("NaCl", ["nacl"])).toBe(true);
		expect(matchesAny("7", ["7"])).toBe(true);
	});

	test("matches answer next to possessive apostrophe", () => {
		expect(matchesAny("Rowling's books are popular.", ["rowling"])).toBe(true);
	});

	test("matches answer next to hyphen (hyphen is not a word char)", () => {
		expect(matchesAny("The Kontakt-5 armor system.", ["Kontakt"])).toBe(true);
		expect(matchesAny("It is blue-green.", ["blue"])).toBe(true);
	});

	// --- Numeric answers ---

	test("matches standalone digit in a sentence", () => {
		expect(matchesAny("The answer is 4.", ["4", "four"])).toBe(true);
		expect(matchesAny("A week has 7 days.", ["7", "seven"])).toBe(true);
		expect(matchesAny("There are seven days in a week.", ["7", "seven"])).toBe(true);
	});

	test("matches number next to comma (thousands separator)", () => {
		expect(matchesAny("The population is 4,000.", ["4"])).toBe(true);
	});

	// --- Verbose model responses ---

	test("handles verbose model responses", () => {
		expect(
			matchesAny(
				"That's a great question! The sky on a clear day appears blue due to Rayleigh scattering.",
				["blue"],
			),
		).toBe(true);
	});

	test("handles common knowledge answers", () => {
		expect(matchesAny("The capital of France is Paris.", ["paris"])).toBe(true);
		expect(matchesAny("NaCl", ["nacl"])).toBe(true);
	});
});
