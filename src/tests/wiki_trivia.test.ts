import { describe, expect, test } from "bun:test";
import { matchesAny } from "../evals/utils";
import { judge, type TriviaQuestion } from "../evals/wiki_trivia";

describe("wiki_trivia eval", () => {
	describe("judge function", () => {
		test("returns true when response contains an acceptable answer", () => {
			const q: TriviaQuestion = {
				question: "Who directed The Fifth Element?",
				answer: "Luc Besson",
				acceptableAnswers: ["Luc Besson", "Besson"],
				topic: "Film",
				datasetIndex: 83,
			};
			expect(judge(q, "The Fifth Element was directed by Luc Besson.")).toBe(true);
		});

		test("returns true for partial match (acceptable answer substring)", () => {
			const q: TriviaQuestion = {
				question: "Who directed The Fifth Element?",
				answer: "Luc Besson",
				acceptableAnswers: ["Luc Besson", "Besson"],
				topic: "Film",
				datasetIndex: 83,
			};
			expect(judge(q, "It was Besson who directed it.")).toBe(true);
		});

		test("is case insensitive", () => {
			const q: TriviaQuestion = {
				question: "What is Trinitite?",
				answer: "Trinitite",
				acceptableAnswers: ["Trinitite"],
				topic: "Science",
				datasetIndex: 2052,
			};
			expect(judge(q, "The answer is TRINITITE.")).toBe(true);
		});

		test("returns false when response does not match", () => {
			const q: TriviaQuestion = {
				question: "What does Aldi stand for?",
				answer: "Albrecht Discount",
				acceptableAnswers: ["Albrecht Discount"],
				topic: "Business",
				datasetIndex: 43,
			};
			expect(judge(q, "Aldi is a German grocery store chain.")).toBe(false);
		});

		test("returns false for I don't know responses", () => {
			const q: TriviaQuestion = {
				question: "Who was Helmuth Weidling?",
				answer: "Helmuth Weidling",
				acceptableAnswers: ["Helmuth Weidling", "Weidling"],
				topic: "Military History",
				datasetIndex: 514,
			};
			expect(judge(q, "I don't know the answer to this question.")).toBe(false);
		});

		test("handles multiple acceptable answers", () => {
			const q: TriviaQuestion = {
				question: "Who were the architects of the Parthenon?",
				answer: "Iktinos and Callicrates",
				acceptableAnswers: ["Iktinos", "Callicrates", "Ictinus", "Kallikrates"],
				topic: "Architecture",
				datasetIndex: 24,
			};
			expect(judge(q, "Ictinus designed the Parthenon.")).toBe(true);
			expect(judge(q, "Kallikrates was one of the architects.")).toBe(true);
			expect(judge(q, "Phidias supervised the construction.")).toBe(false);
		});
	});

	describe("matchesAny with trivia answers", () => {
		test("matches obscure names", () => {
			expect(matchesAny("The Kabsch algorithm solves this.", ["Kabsch algorithm", "Kabsch"])).toBe(
				true,
			);
			expect(matchesAny("It was originally called ReelTime.", ["ReelTime", "Reel Time"])).toBe(
				true,
			);
		});

		test("matches historical names with diacritics or alternate spellings", () => {
			expect(
				matchesAny("José Antonio Echeverría led the attack.", [
					"José Antonio Echeverría",
					"Echeverría",
					"Echeverria",
				]),
			).toBe(true);
		});

		test("matches short unique answers", () => {
			expect(matchesAny("The alloy is called Elektron.", ["Elektron"])).toBe(true);
			expect(matchesAny("The armour system is Kontakt-5.", ["Kontakt-5", "Kontakt 5"])).toBe(true);
		});
	});
});
