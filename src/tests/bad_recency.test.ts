import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../evals/bad_recency";

describe("bad_recency eval", () => {
	test("SYSTEM_PROMPT instructs the model to be honest when tool returns no info", () => {
		const lower = SYSTEM_PROMPT.toLowerCase();
		// The eval depends on the prompt telling the model to be honest about uncertainty
		// rather than fabricating answers when the tool fails. If this instruction is
		// removed, the eval can no longer distinguish hallucination from instruction-following.
		expect(lower).toContain("honest");
		expect(lower).toContain("search");
	});

	test("SYSTEM_PROMPT mentions training data cutoff", () => {
		const lower = SYSTEM_PROMPT.toLowerCase();
		expect(lower).toContain("cutoff");
	});
});
