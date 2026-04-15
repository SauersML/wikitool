import { describe, expect, test } from "bun:test";
import { parseWikitext, preserveNumericTemplates } from "../tool/search";

describe("preserveNumericTemplates", () => {
	describe("{{convert}} templates", () => {
		test("convert with value, from_unit, to_unit", () => {
			const result = preserveNumericTemplates("{{convert|287|m|ft}}");
			expect(result).toContain("287");
			expect(result).toContain("m");
		});

		test("convert with value and from_unit only", () => {
			const result = preserveNumericTemplates("{{convert|462|km}}");
			expect(result).toContain("462");
			expect(result).toContain("km");
		});

		test("convert with abbr=on option", () => {
			const result = preserveNumericTemplates("{{convert|85|m|ft|abbr=on}}");
			expect(result).toContain("85");
			expect(result).toContain("m");
		});

		test("convert with decimal value", () => {
			const result = preserveNumericTemplates("{{convert|57.09|km|mi}}");
			expect(result).toContain("57.09");
			expect(result).toContain("km");
		});
	});

	describe("{{val}} templates", () => {
		test("val with value and unit", () => {
			const result = preserveNumericTemplates("{{val|299792458|u=m/s}}");
			expect(result).toContain("299792458");
			expect(result).toContain("m/s");
		});

		test("val with value only", () => {
			const result = preserveNumericTemplates("{{val|3.14159}}");
			expect(result).toContain("3.14159");
		});
	});

	describe("{{formatnum}} templates", () => {
		test("formatnum with integer", () => {
			const result = preserveNumericTemplates("{{formatnum:1234567}}");
			expect(result).toContain("1234567");
		});

		test("formatnum with decimal", () => {
			const result = preserveNumericTemplates("{{formatnum:3.14}}");
			expect(result).toContain("3.14");
		});
	});

	describe("{{age}} templates", () => {
		test("age computes a number", () => {
			const result = preserveNumericTemplates("{{age|1990|1|1}}");
			// Should be a number (the computed age)
			expect(result).toMatch(/^\d+$/);
			const age = Number.parseInt(result, 10);
			expect(age).toBeGreaterThanOrEqual(35);
			expect(age).toBeLessThanOrEqual(37);
		});
	});

	describe("{{circa}} templates", () => {
		test("circa with year", () => {
			const result = preserveNumericTemplates("{{circa|1500}}");
			expect(result).toBe("c. 1500");
		});
	});

	describe("{{birth date}} templates", () => {
		test("birth date with Y|M|D", () => {
			const result = preserveNumericTemplates("{{birth date|1990|3|15}}");
			expect(result).toBe("1990-03-15");
		});

		test("birth date and age with Y|M|D", () => {
			const result = preserveNumericTemplates("{{birth date and age|1985|12|1}}");
			expect(result).toBe("1985-12-01");
		});
	});

	describe("{{death date}} templates", () => {
		test("death date with Y|M|D", () => {
			const result = preserveNumericTemplates("{{death date|2020|6|30}}");
			expect(result).toBe("2020-06-30");
		});

		test("death date and age with Y|M|D and extra params", () => {
			const result = preserveNumericTemplates("{{death date and age|2020|6|30|1950|1|1}}");
			expect(result).toBe("2020-06-30");
		});
	});

	describe("{{coord}} templates", () => {
		test("coord with lat and lon", () => {
			const result = preserveNumericTemplates("{{coord|46.5|8.6|type:landmark}}");
			expect(result).toContain("46.5");
			expect(result).toContain("8.6");
		});
	});

	describe("{{pop density}} templates", () => {
		test("pop density with pop and area", () => {
			const result = preserveNumericTemplates("{{pop density|50000|100}}");
			expect(result).toContain("50000");
			expect(result).toContain("100");
		});
	});
});

describe("parseWikitext preserves numeric values", () => {
	test("convert template values survive parsing", () => {
		const raw =
			"The tunnel is {{convert|287|m|ft}} long and reaches a depth of {{convert|462|m|ft}} below sea level.";
		const result = parseWikitext(raw);
		expect(result).toContain("287");
		expect(result).toContain("m");
		expect(result).toContain("462");
	});

	test("convert with abbr=on survives parsing", () => {
		const raw = "The bridge spans {{convert|85|m|ft|abbr=on}} over the river.";
		const result = parseWikitext(raw);
		expect(result).toContain("85");
	});

	test("formatnum survives parsing", () => {
		const raw = "The population is {{formatnum:1234567}} people.";
		const result = parseWikitext(raw);
		expect(result).toContain("1234567");
	});

	test("val with unit survives parsing", () => {
		const raw = "The speed of light is {{val|299792458|u=m/s}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("299792458");
		expect(result).toContain("m/s");
	});

	test("circa survives parsing", () => {
		const raw = "The city was founded {{circa|1200}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("c. 1200");
	});

	test("birth date survives parsing", () => {
		const raw = "She was born on {{birth date|1990|3|15}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("1990-03-15");
	});

	test("no double spaces where numbers should be", () => {
		const raw = "The tunnel is {{convert|287|m|ft}} long.";
		const result = parseWikitext(raw);
		expect(result).not.toMatch(/is\s{2,}long/);
		expect(result).toContain("287 m");
	});
});

describe("non-numeric templates are still stripped", () => {
	test("Infobox data is extracted, not stripped", () => {
		const raw = "{{Infobox country|name=Test|capital=Foo}}\nSome article text here.";
		const result = parseWikitext(raw);
		expect(result).not.toContain("Infobox");
		expect(result).toContain("Some article text here.");
		// Infobox key-value data should survive
		expect(result).toContain("Name: Test");
		expect(result).toContain("Capital: Foo");
	});

	test("cite web is stripped", () => {
		const raw = "Some fact.{{cite web|url=http://example.com|title=Test}} More text.";
		const result = parseWikitext(raw);
		expect(result).not.toContain("cite web");
		expect(result).not.toContain("example.com");
		expect(result).toContain("Some fact.");
		expect(result).toContain("More text.");
	});

	test("reflist is stripped", () => {
		const raw = "Article text.\n{{reflist}}";
		const result = parseWikitext(raw);
		expect(result).not.toContain("reflist");
	});

	test("nested templates are stripped", () => {
		const raw = "Text before {{outer|{{inner|stuff}}}} text after.";
		const result = parseWikitext(raw);
		expect(result).not.toContain("outer");
		expect(result).not.toContain("inner");
		expect(result).toContain("Text before");
		expect(result).toContain("text after.");
	});
});

describe("bug replication: numbers destroyed by stripNestedBraces", () => {
	test("REGRESSION: convert|287|m|ft must not leave double spaces", () => {
		// {{convert|287|m|ft}} must not be stripped entirely — doing so would
		// leave "The tunnel is  long" (double space) and lose the number.
		const raw =
			"The tunnel is {{convert|287|m|ft}} long and reaches a depth of {{convert|462|m|ft}} below sea level.";
		const result = parseWikitext(raw);
		// The numbers must survive
		expect(result).toContain("287");
		expect(result).toContain("462");
		// No double spaces where templates were
		expect(result).not.toMatch(/is\s{2,}long/);
		expect(result).not.toMatch(/of\s{2,}below/);
	});

	test("REGRESSION: convert|85|m|ft|abbr=on must preserve 85", () => {
		const raw = "Height is {{convert|85|m|ft|abbr=on}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("85");
	});

	test("REGRESSION: formatnum:1234567 must preserve the number", () => {
		const raw = "Population: {{formatnum:1234567}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("1234567");
	});

	test("REGRESSION: val|299792458|u=m/s must preserve the value", () => {
		const raw = "Speed of light: {{val|299792458|u=m/s}}.";
		const result = parseWikitext(raw);
		expect(result).toContain("299792458");
	});
});
