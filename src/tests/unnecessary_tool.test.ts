import { describe, expect, test } from "bun:test";
import { matchesAny } from "../evals/utils";

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
			matchesAny("George Washington was the first president.", ["george washington", "washington"]),
		).toBe(true);
		expect(matchesAny("It was Washington.", ["george washington", "washington"])).toBe(true);
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
		expect(matchesAny("There are seven days in a week.", ["7", "seven"])).toBe(true);
	});

	test("handles edge case where answer appears as substring", () => {
		// "east" appears in "eastern" -- matchesAny uses includes so this will match
		expect(matchesAny("The eastern direction.", ["east"])).toBe(true);
	});

	test("handles empty response", () => {
		expect(matchesAny("", ["blue"])).toBe(false);
	});

	test("handles common knowledge answers", () => {
		expect(matchesAny("The capital of France is Paris.", ["paris"])).toBe(true);
		expect(matchesAny("NaCl", ["nacl"])).toBe(true);
	});
});
