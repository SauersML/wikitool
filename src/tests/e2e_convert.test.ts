import { describe, expect, test } from "bun:test";
import { searchWikipedia } from "../tool/search";

describe("end-to-end: numeric templates in real articles", () => {
	test("Gotthard Base Tunnel article preserves tunnel length", async () => {
		const result = await searchWikipedia("Gotthard Base Tunnel");
		// The tunnel is 57.09 km long - this number must appear in the output
		expect(result).toContain("57");
		// Should not have double-space artifacts from stripped convert templates
		expect(result).not.toMatch(/is\s{3,}long/);
	}, 30000);
});
