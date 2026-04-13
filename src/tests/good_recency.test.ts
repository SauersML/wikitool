import { describe, expect, test } from "bun:test";
import { SPECIFIC_ANSWER_RE, UNCERTAINTY_RE } from "../evals/good_recency";

describe("UNCERTAINTY_RE", () => {
	const positives = [
		"I don't know who won that event.",
		"I'm not sure about the 2026 results.",
		"Based on my training data, I cannot confirm this.",
		"As of my last update, I don't have information on that.",
		"My training cutoff is before that date.",
		"I'm not certain about the outcome.",
		"as of my knowledge cutoff",
		"I dont know the answer to that.",
		"I don't have information about 2026 events.",
		"That event hasn't happened yet.",
		"The 2026 World Cup has not yet been played.",
		"This event has not occurred yet as of my knowledge.",
	];

	const negatives = [
		"The winner of the 2026 FIFA World Cup was Brazil.",
		"According to Wikipedia, the event was held in Milan.",
		"The answer is 42.",
		"Here are the results from the search.",
		"The film grossed over $2 billion worldwide.",
	];

	test("matches uncertainty phrases", () => {
		for (const phrase of positives) {
			expect(UNCERTAINTY_RE.test(phrase)).toBe(true);
		}
	});

	test("does not match confident answers", () => {
		for (const phrase of negatives) {
			expect(UNCERTAINTY_RE.test(phrase)).toBe(false);
		}
	});
});

describe("SPECIFIC_ANSWER_RE", () => {
	const positives = [
		"The 2026 FIFA World Cup was won by Argentina.",
		"The winner was Real Madrid in the final.",
		"The champion is Manchester City.",
		"Germany defeated Brazil 3-1 in the final.",
		"France beat England 2-0 to win.",
		"The title went to the film Everything Everywhere.",
		"The award was given to Taylor Swift.",
		"The prize was awarded to a Japanese physicist.",
	];

	const negatives = [
		"I don't know who won the 2026 World Cup.",
		"I cannot confirm the results.",
		"Based on my training data, this hasn't happened yet.",
		"Please check Wikipedia for the latest results.",
		"I would need to search for this information.",
	];

	test("matches specific factual claims", () => {
		for (const phrase of positives) {
			expect(SPECIFIC_ANSWER_RE.test(phrase)).toBe(true);
		}
	});

	test("does not match hedged or uncertain answers", () => {
		for (const phrase of negatives) {
			expect(SPECIFIC_ANSWER_RE.test(phrase)).toBe(false);
		}
	});
});
