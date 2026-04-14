import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "../tool/prompt";

describe("shared SYSTEM_PROMPT (used by bad_recency and other with-tool evals)", () => {
	test("mentions training data cutoff", () => {
		expect(SYSTEM_PROMPT.toLowerCase()).toContain("cutoff");
	});

	test("instructs searching for post-cutoff events", () => {
		expect(SYSTEM_PROMPT.toLowerCase()).toContain("search");
	});
});
