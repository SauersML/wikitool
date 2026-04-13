import { describe, expect, test } from "bun:test";
import { extractInfoboxes, parseWikitext } from "../tool/search";

describe("extractInfoboxes", () => {
	describe("Mount Everest-style infobox", () => {
		const raw = `{{Infobox mountain
| name = Mount Everest
| elevation_m = 8849
| elevation_ft = 29032
| location = [[Nepal]] / [[China]]
| coordinates = {{Coord|27|59|18|N|86|55|31|E}}
| first_ascent = 29 May 1953, [[Edmund Hillary]], [[Tenzing Norgay]]
| range = [[Mahalangur Himal]]
| image = Everest_North_Face.jpg
| image_size = 280px
| image_caption = North face from base camp
| map = Nepal
| map_caption = Location in Nepal
| relief = 1
}}`;

		test("elevation survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("8849");
			expect(result).toContain("29032");
		});

		test("location survives with wikilinks resolved", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("Nepal");
			expect(result).toContain("China");
		});

		test("first ascent data survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("1953");
			expect(result).toContain("Hillary");
			expect(result).toContain("Tenzing Norgay");
		});

		test("range survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("Mahalangur Himal");
		});

		test("coordinates are handled (nested template)", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("27");
		});

		test("image/map meta keys are skipped", () => {
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("Everest_North_Face");
			expect(result).not.toContain("280px");
			expect(result).not.toContain("North face from base camp");
		});

		test("Infobox keyword does not appear", () => {
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("Infobox");
		});

		test("keys are formatted readably", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("Elevation m:");
			expect(result).toContain("First ascent:");
		});
	});

	describe("person infobox", () => {
		const raw = `{{Infobox person
| name = Albert Einstein
| birth_date = {{birth date|1879|3|14}}
| birth_place = [[Ulm]], [[Kingdom of Württemberg]], [[German Empire]]
| death_date = {{death date and age|1955|4|18|1879|3|14}}
| nationality = German, Swiss, American
| occupation = Physicist
| known_for = Theory of relativity, mass-energy equivalence
| image = Einstein_1921.jpg
| image_size = 220px
}}`;

		test("birth date survives (nested template)", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("1879");
		});

		test("nationality survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("German");
		});

		test("occupation survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("Physicist");
		});

		test("known_for survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("relativity");
		});

		test("image is skipped", () => {
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("Einstein_1921");
		});
	});

	describe("city infobox", () => {
		const raw = `{{Infobox settlement
| name = Tokyo
| population_total = 13960000
| area_total_km2 = 2194
| leader_title = Governor
| leader_name = Yuriko Koike
| elevation_m = 40
| image_skyline = Tokyo_Montage.jpg
| imagesize = 300px
| pushpin_map = Japan
| map_caption = Location in Japan
}}`;

		test("population survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("13960000");
		});

		test("area survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("2194");
		});

		test("leader/mayor survives", () => {
			const result = extractInfoboxes(raw);
			expect(result).toContain("Yuriko Koike");
		});

		test("meta keys are skipped", () => {
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("Tokyo_Montage");
			expect(result).not.toContain("300px");
			expect(result).not.toContain("pushpin");
		});
	});

	describe("nested templates in values", () => {
		test("{{convert}} inside infobox value", () => {
			const raw = `{{Infobox building
| name = Empire State Building
| height = {{convert|443|m|ft}}
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("443");
			expect(result).toContain("m");
		});

		test("{{coord}} inside infobox value", () => {
			const raw = `{{Infobox mountain
| name = K2
| coordinates = {{Coord|35|52|N|76|30|E}}
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("35");
		});

		test("{{birth date and age}} inside infobox value", () => {
			const raw = `{{Infobox person
| name = Jane Doe
| birth_date = {{birth date and age|1990|6|15}}
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("1990-06-15");
		});
	});

	describe("meta/formatting keys are skipped", () => {
		test("image keys are skipped", () => {
			const raw = `{{Infobox person
| name = Test
| image = photo.jpg
| image_size = 250px
| image_caption = A photo
| image_alt = Alt text
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: Test");
			expect(result).not.toContain("photo.jpg");
			expect(result).not.toContain("250px");
			expect(result).not.toContain("A photo");
		});

		test("map keys are skipped", () => {
			const raw = `{{Infobox settlement
| name = TestCity
| map = SomeMap.svg
| map_size = 200
| map_caption = Map showing location
| mapframe = yes
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: TestCity");
			expect(result).not.toContain("SomeMap");
			expect(result).not.toContain("Map showing location");
		});

		test("pushpin keys are skipped", () => {
			const raw = `{{Infobox settlement
| name = TestCity
| pushpin_map = Country
| pushpin_label_position = right
}}`;
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("pushpin");
		});

		test("relief is skipped", () => {
			const raw = `{{Infobox mountain
| name = TestMountain
| relief = 1
}}`;
			const result = extractInfoboxes(raw);
			expect(result).not.toContain("Relief");
		});
	});

	describe("empty values are skipped", () => {
		test("empty value produces no output for that key", () => {
			const raw = `{{Infobox person
| name = Test
| birth_place =
| occupation = Engineer
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: Test");
			expect(result).toContain("Occupation: Engineer");
			expect(result).not.toContain("Birth place:");
		});

		test("value that is only refs is skipped", () => {
			const raw = `{{Infobox settlement
| name = TestCity
| population_total = 50000<ref>Census 2020</ref>
| area_note = <ref name="area"/>
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("50000");
			// area_note should be skipped since its value is only a ref
		});
	});

	describe("transcluded infoboxes (no key-value pairs)", () => {
		test("produces no output", () => {
			const raw = "{{Infobox hafnium}}";
			const result = extractInfoboxes(raw);
			expect(result.trim()).toBe("");
		});

		test("transcluded infobox with only positional params produces no output", () => {
			const raw = "{{Infobox element|hafnium|72}}";
			const result = extractInfoboxes(raw);
			// No key=value pairs, so nothing to extract
			expect(result.trim()).toBe("");
		});
	});

	describe("multiple infoboxes in one article", () => {
		test("both infoboxes are extracted", () => {
			const raw = `{{Infobox person
| name = John Smith
| birth_date = {{birth date|1950|1|1}}
| nationality = American
}}
Some text between infoboxes.
{{Infobox officeholder
| office = President
| term_start = 2000
| term_end = 2008
}}
More article text.`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: John Smith");
			expect(result).toContain("Nationality: American");
			expect(result).toContain("Office: President");
			expect(result).toContain("Term start: 2000");
			expect(result).toContain("Term end: 2008");
			expect(result).toContain("Some text between infoboxes.");
			expect(result).toContain("More article text.");
		});
	});

	describe("junk templates alongside infoboxes", () => {
		test("infobox data survives but junk is removed by stripNestedBraces", () => {
			const raw = `{{Infobox country|name=Testland|capital=Testville}}
Some facts about Testland.{{cite web|url=http://example.com|title=Source}}
{{reflist}}`;
			const result = parseWikitext(raw);
			// Infobox data should survive
			expect(result).toContain("Name: Testland");
			expect(result).toContain("Capital: Testville");
			// Article text should survive
			expect(result).toContain("Some facts about Testland.");
			// Junk templates should be stripped
			expect(result).not.toContain("cite web");
			expect(result).not.toContain("example.com");
			expect(result).not.toContain("reflist");
		});
	});

	describe("key formatting", () => {
		test("underscores become spaces", () => {
			const raw = `{{Infobox mountain
| first_ascent = 1953
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("First ascent: 1953");
		});

		test("first letter is capitalized", () => {
			const raw = `{{Infobox person
| occupation = Physicist
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Occupation: Physicist");
		});
	});

	describe("wikilinks in values", () => {
		test("piped wikilinks show display text", () => {
			const raw = `{{Infobox person
| alma_mater = [[Massachusetts Institute of Technology|MIT]]
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("MIT");
			expect(result).not.toContain("[[");
		});

		test("plain wikilinks show target", () => {
			const raw = `{{Infobox person
| birth_place = [[London]]
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("London");
			expect(result).not.toContain("[[");
		});
	});

	describe("case insensitivity", () => {
		test("lowercase 'infobox' is recognized", () => {
			const raw = `{{infobox person
| name = Test
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: Test");
		});

		test("mixed case 'InfoBox' is recognized", () => {
			const raw = `{{InfoBox settlement
| name = TestCity
| population_total = 100000
}}`;
			const result = extractInfoboxes(raw);
			expect(result).toContain("Name: TestCity");
			expect(result).toContain("100000");
		});
	});
});

describe("parseWikitext with infoboxes", () => {
	test("infobox data survives full pipeline", () => {
		const raw = `{{Infobox mountain
| name = Mount Everest
| elevation_m = 8849
| first_ascent = 29 May 1953
| image = Everest.jpg
}}
'''Mount Everest''' is the highest mountain on Earth.`;
		const result = parseWikitext(raw);
		expect(result).toContain("8849");
		expect(result).toContain("1953");
		expect(result).toContain("Mount Everest");
		expect(result).not.toContain("Infobox");
		expect(result).not.toContain("Everest.jpg");
	});

	test("infobox + numeric templates + junk all handled correctly", () => {
		const raw = `{{Infobox building
| name = Test Tower
| height = {{convert|443|m|ft}}
}}
The tower is {{convert|443|m|ft}} tall.{{cite web|url=http://x.com|title=Y}}
{{reflist}}`;
		const result = parseWikitext(raw);
		// Infobox data
		expect(result).toContain("Name: Test Tower");
		expect(result).toContain("443");
		// Body text
		expect(result).toContain("tower is");
		expect(result).toContain("443 m");
		// Junk stripped
		expect(result).not.toContain("cite web");
		expect(result).not.toContain("reflist");
	});
});
