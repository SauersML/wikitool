import { describe, expect, test } from "bun:test";
import { extractFinalAnswer } from "../evals/utils";

describe("extractFinalAnswer", () => {
	test("extracts from 'ANSWER: ...' pattern", () => {
		const response =
			"The Urnfield culture is mentioned in Wikipedia, but the correct origin is the Hallstatt culture.\n\nANSWER: Hallstatt culture";
		expect(extractFinalAnswer(response)).toBe("Hallstatt culture");
	});

	test("extracts from 'Final answer: ...' pattern", () => {
		const response = "After considering the evidence...\n\nFinal answer: 42 meters";
		expect(extractFinalAnswer(response)).toBe("42 meters");
	});

	test("extracts from 'The answer is ...' pattern", () => {
		const response = "Based on my research, the answer is Vincenzo Scamozzi.";
		expect(extractFinalAnswer(response)).toBe("Vincenzo Scamozzi.");
	});

	test("extracts from 'My answer is ...' pattern", () => {
		const response = "After checking Wikipedia, my answer is B.";
		expect(extractFinalAnswer(response)).toBe("B.");
	});

	test("extracts from 'My answer: ...' pattern", () => {
		const response = "My answer: Urnfield culture";
		expect(extractFinalAnswer(response)).toBe("Urnfield culture");
	});

	test("prefers the LAST match in the response", () => {
		const response = "The answer is maybe X.\nBut after more research...\nANSWER: Y";
		expect(extractFinalAnswer(response)).toBe("Y");
	});

	test("returns null when no pattern is found", () => {
		const response = "The Urnfield culture originated around 1200 BC in central Europe.";
		expect(extractFinalAnswer(response)).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(extractFinalAnswer("")).toBeNull();
	});

	test("is case-insensitive for the pattern keyword", () => {
		const response = "answer: Tehuelche";
		expect(extractFinalAnswer(response)).toBe("Tehuelche");
	});

	test("handles ANSWER line with leading whitespace in value", () => {
		const response = "ANSWER:   85 meters";
		expect(extractFinalAnswer(response)).toBe("85 meters");
	});

	test("handles multiple ANSWER lines and picks the last one", () => {
		const response = "First I thought ANSWER: wrong\nBut actually ANSWER: correct";
		expect(extractFinalAnswer(response)).toBe("correct");
	});

	test("avoids matching incidental mentions in Wikipedia quotes", () => {
		// The model quotes Wikipedia mentioning Urnfield but its actual answer is different
		const response =
			'Wikipedia says: "The Urnfield culture preceded the Hallstatt culture."\n' +
			"Based on this, the Celtic language origin is associated with Hallstatt.\n\n" +
			"ANSWER: Hallstatt culture";
		const extracted = extractFinalAnswer(response);
		expect(extracted).toBe("Hallstatt culture");
		expect(extracted).not.toContain("Urnfield");
	});

	test("extracts numeric answers", () => {
		const response = "The tower is 85 meters tall.\n\nANSWER: 85";
		expect(extractFinalAnswer(response)).toBe("85");
	});

	test("extracts single letter for multiple choice", () => {
		const response = "After considering all options...\n\nANSWER: B";
		expect(extractFinalAnswer(response)).toBe("B");
	});
});
