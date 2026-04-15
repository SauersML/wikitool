import { describe, expect, test } from "bun:test";
import { parseWikitext, truncate } from "../tool/search";

describe("abbreviateRef via parseWikitext — title branch", () => {
	test("short title (≤3 words): emits full head without ellipsis", () => {
		const out = parseWikitext(`Other.<ref>{{cite book|title=Brief History}}</ref>`);
		expect(out).toContain("[Brief History]");
		expect(out).not.toContain("…");
	});

	test("longer title: emits 3 words followed by ellipsis", () => {
		const out = parseWikitext(
			`Foo.<ref>{{cite book|title=Consideration of the defendants' appeals}}</ref>`,
		);
		expect(out).toContain("[Consideration of the…]");
	});

	test("exactly 3 words: no ellipsis appended", () => {
		const out = parseWikitext(`X.<ref>{{cite book|title=Three Word Title}}</ref>`);
		expect(out).toContain("[Three Word Title]");
		expect(out).not.toContain("Three Word Title…");
	});

	test("the specific regression from production (ECCC Cases 003/004)", () => {
		// Production title that truncates to "[Consideration of the]"; the
		// abbreviation must end with an ellipsis, not a bare clipped phrase.
		const out = parseWikitext(
			`Claim.<ref>{{cite report|title=Consideration of the Defendants' Appeals Against the Closing Order}}</ref>`,
		);
		expect(out).toContain("[Consideration of the…]");
	});
});

describe("abbreviateRef via parseWikitext — author branch (preferred over title)", () => {
	test("last= field yields full surname, no ellipsis", () => {
		const out = parseWikitext(
			`Claim.<ref>{{cite journal|last=Hawking|title=Some Long Title Here}}</ref>`,
		);
		expect(out).toContain("[Hawking]");
		// Title branch not reached
		expect(out).not.toContain("Some Long Title");
	});

	test("authors= field yields first surname, no ellipsis", () => {
		const out = parseWikitext(
			`Claim.<ref>{{cite journal|authors=Einstein, Albert|title=Irrelevant}}</ref>`,
		);
		expect(out).toContain("[Einstein]");
	});
});

describe("abbreviateRef via parseWikitext — plain-text branch", () => {
	test("short plain ref (<3 words): no ellipsis", () => {
		const out = parseWikitext(`X.<ref>Smith 2019</ref>`);
		expect(out).toContain("[Smith 2019]");
		expect(out).not.toContain("…");
	});

	test("long plain ref: ellipsis appended", () => {
		const out = parseWikitext(
			`X.<ref>Smith, John. The Very Long History of Everything. 2019.</ref>`,
		);
		// First 3 words of the cleaned plain body
		expect(out).toMatch(/\[\S+ \S+ \S+…\]/);
	});
});

describe("truncate — sentence-boundary fallback", () => {
	test("paragraph exceeding limit cuts at sentence boundary, not mid-sentence", () => {
		const text =
			"First sentence ends here. Second sentence follows. Third one, longer, with multiple clauses and extra text to push it past the budget.";
		const out = truncate(text, 60);
		expect(out).toMatch(/\[truncated\]$/);
		// Must end at ". " boundary, not in the middle of a word or sentence
		const body = out.replace(/\n\[truncated\]$/, "");
		expect(body.endsWith(".")).toBe(true);
	});

	test("falls back to word boundary when no sentence ends in window", () => {
		const text =
			"This is one single very long sentence without any period that would exceed our tiny budget and therefore must be cut somewhere sensible";
		const out = truncate(text, 50);
		expect(out).toMatch(/\[truncated\]$/);
		const body = out.replace(/\n\[truncated\]$/, "");
		// Ends at a word boundary (no trailing partial word)
		expect(body).not.toMatch(/[a-z]-$/i);
		// Should not end mid-word: the last char before [truncated] should be a full word
		const words = body.trim().split(/\s+/);
		const lastWord = words[words.length - 1] ?? "";
		expect(text).toContain(lastWord);
	});

	test("text under limit returns unchanged", () => {
		const text = "Short.";
		expect(truncate(text, 100)).toBe("Short.");
	});

	test("paragraph-level splits still cut at paragraph boundaries when possible", () => {
		const text = "First paragraph is short.\n\nSecond paragraph is also short.\n\nThird paragraph.";
		const out = truncate(text, 50);
		expect(out).toMatch(/\[truncated\]$/);
		// Should contain complete paragraphs, no mid-sentence cuts
		const body = out.replace(/\n\[truncated\]$/, "");
		expect(body).toContain("First paragraph is short.");
	});
});
