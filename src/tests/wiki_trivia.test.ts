import { describe, expect, test } from "bun:test";
import { matchesAny } from "../evals/utils";
import { QUESTIONS, type TriviaQuestion, judge } from "../evals/wiki_trivia";

describe("wiki_trivia eval", () => {
	// 1. Questions array has exactly 25 items
	test("QUESTIONS array has exactly 25 items", () => {
		expect(QUESTIONS).toHaveLength(25);
	});

	// 2. Question data integrity
	describe("question data integrity", () => {
		test("all questions have required fields", () => {
			for (const q of QUESTIONS) {
				expect(typeof q.question).toBe("string");
				expect(q.question.length).toBeGreaterThan(0);
				expect(typeof q.answer).toBe("string");
				expect(q.answer.length).toBeGreaterThan(0);
				expect(Array.isArray(q.acceptableAnswers)).toBe(true);
				expect(q.acceptableAnswers.length).toBeGreaterThan(0);
				expect(typeof q.topic).toBe("string");
				expect(q.topic.length).toBeGreaterThan(0);
				expect(typeof q.datasetIndex).toBe("number");
				expect(q.datasetIndex).toBeGreaterThanOrEqual(0);
			}
		});

		test("all dataset indices are unique", () => {
			const indices = QUESTIONS.map((q) => q.datasetIndex);
			const uniqueIndices = new Set(indices);
			expect(uniqueIndices.size).toBe(indices.length);
		});

		test("questions end with a question mark", () => {
			for (const q of QUESTIONS) {
				expect(q.question.endsWith("?")).toBe(true);
			}
		});

		test("covers diverse topics", () => {
			const topics = new Set(QUESTIONS.map((q) => q.topic));
			// Should have at least 8 distinct topics
			expect(topics.size).toBeGreaterThanOrEqual(8);
		});
	});

	// 3. Judge function tests
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

	// 4. matchesAny integration with trivia answers
	describe("matchesAny with trivia answers", () => {
		test("matches Fox Broadcasting variants", () => {
			expect(matchesAny("It airs on Fox.", ["Fox", "Fox Broadcasting", "Fox Broadcasting Company"])).toBe(true);
			expect(matchesAny("The Fox Broadcasting Company.", ["Fox", "Fox Broadcasting", "Fox Broadcasting Company"])).toBe(true);
		});

		test("matches historical names with diacritics or alternate spellings", () => {
			expect(matchesAny("Abd al-Rahman al-Sufi described it.", ["al-Sufi", "Abd al-Rahman al-Sufi"])).toBe(true);
		});

		test("matches short unique answers", () => {
			expect(matchesAny("The answer is Granma.", ["Granma"])).toBe(true);
			expect(matchesAny("It was called NGP before release.", ["Next Generation Portable", "NGP"])).toBe(true);
		});
	});

	// 5. Verify difficulty spread
	describe("difficulty spread", () => {
		test("has questions from different parts of the dataset", () => {
			const indices = QUESTIONS.map((q) => q.datasetIndex);
			const minIdx = Math.min(...indices);
			const maxIdx = Math.max(...indices);
			// Should span a wide range of the 2261-row dataset
			expect(maxIdx - minIdx).toBeGreaterThan(1000);
		});

		test("includes entertainment and non-entertainment topics", () => {
			const entertainmentTopics = ["Film", "Television", "Music", "Music/Film"];
			const entertainmentCount = QUESTIONS.filter((q) =>
				entertainmentTopics.includes(q.topic),
			).length;
			const nonEntertainmentCount = QUESTIONS.length - entertainmentCount;

			// Neither category should dominate
			expect(entertainmentCount).toBeGreaterThan(2);
			expect(nonEntertainmentCount).toBeGreaterThan(10);
		});
	});
});
