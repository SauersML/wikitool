import { describe, expect, test } from "bun:test";
import { matchesAny } from "../evals/utils";
import { judge, type TriviaQuestion } from "../evals/wiki_trivia";

describe("wiki_trivia eval", () => {
	describe("judge function", () => {
		test("returns true when response contains an acceptable answer", async () => {
			const q: TriviaQuestion = {
				question: "Who directed The Fifth Element?",
				answer: "Luc Besson",
				acceptableAnswers: ["Luc Besson", "Besson"],
				topic: "Film",
				datasetIndex: 83,
			};
			expect(await judge(q, "The Fifth Element was directed by Luc Besson.")).toBe(true);
		});

		test("returns true for partial match (acceptable answer substring)", async () => {
			const q: TriviaQuestion = {
				question: "Who directed The Fifth Element?",
				answer: "Luc Besson",
				acceptableAnswers: ["Luc Besson", "Besson"],
				topic: "Film",
				datasetIndex: 83,
			};
			expect(await judge(q, "It was Besson who directed it.")).toBe(true);
		});

		test("is case insensitive", async () => {
			const q: TriviaQuestion = {
				question: "What is Trinitite?",
				answer: "Trinitite",
				acceptableAnswers: ["Trinitite"],
				topic: "Science",
				datasetIndex: 2052,
			};
			expect(await judge(q, "The answer is TRINITITE.")).toBe(true);
		});

		test("returns false when response does not match", async () => {
			const q: TriviaQuestion = {
				question: "What does Aldi stand for?",
				answer: "Albrecht Discount",
				acceptableAnswers: ["Albrecht Discount"],
				topic: "Business",
				datasetIndex: 43,
			};
			expect(await judge(q, "Aldi is a German grocery store chain.", { disableGrader: true })).toBe(
				false,
			);
		});

		test("returns false for I don't know responses", async () => {
			const q: TriviaQuestion = {
				question: "Who was Helmuth Weidling?",
				answer: "Helmuth Weidling",
				acceptableAnswers: ["Helmuth Weidling", "Weidling"],
				topic: "Military History",
				datasetIndex: 514,
			};
			expect(await judge(q, "I don't know the answer to this question.")).toBe(false);
		});

		test("handles multiple acceptable answers", async () => {
			const q: TriviaQuestion = {
				question: "Who were the architects of the Parthenon?",
				answer: "Iktinos and Callicrates",
				acceptableAnswers: ["Iktinos", "Callicrates", "Ictinus", "Kallikrates"],
				topic: "Architecture",
				datasetIndex: 24,
			};
			expect(await judge(q, "Ictinus designed the Parthenon.")).toBe(true);
			expect(await judge(q, "Kallikrates was one of the architects.")).toBe(true);
			expect(await judge(q, "Phidias supervised the construction.", { disableGrader: true })).toBe(
				false,
			);
		});

		test("prefers extractFinalAnswer over full-response matching", async () => {
			const q: TriviaQuestion = {
				question: "What is the name of the gold coin introduced in 1663?",
				answer: "Guinea",
				acceptableAnswers: ["Guinea"],
				topic: "Numismatics",
				datasetIndex: 1572,
			};
			// "Guinea" appears only in the ANSWER: line, not in a misleading context
			expect(await judge(q, "The coin was minted from African gold.\nANSWER: Guinea")).toBe(true);
			// If extractFinalAnswer finds the answer line, only that text is judged
			expect(await judge(q, "Not related to Papua New Guinea.\nANSWER: Guinea")).toBe(true);
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

		test("does not match answer embedded in a longer word", () => {
			// "Knorr" (the serial killer) should not match "Knorr's" soup brand discussion
			// — actually it DOES match, because apostrophe is not a word char. This is
			// acceptable: possessive forms are valid matches ("Knorr's crimes...").
			expect(matchesAny("Knorr's crimes were horrific.", ["Knorr"])).toBe(true);
			// But it should NOT match if embedded in a longer word
			expect(matchesAny("Knorrenberg is a German town.", ["Knorr"])).toBe(false);
		});
	});
});
