const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";
const CHAR_LIMIT = 4000;
const UA = "WikiSearchMCP/1.0 (https://wikisearch.sauerslabs.workers.dev; sauerslabs@gmail.com)";

// --- Types ---

interface TitleResult {
	title: string;
	redirectFrom: string | undefined;
	type: string;
}

interface SearchHit {
	title: string;
	snippet: string;
	sectionTitle: string;
	wordcount: number;
}

interface SearchResponse {
	hits: SearchHit[];
	totalHits: number;
	suggestion: string | undefined;
}

interface PageSection {
	level: number;
	name: string;
	byteoffset: number;
}

interface PageData {
	title: string;
	wikitext: string;
	sections: PageSection[];
}

// --- API ---

async function lookupTitle(query: string): Promise<TitleResult | null> {
	const encoded = encodeURIComponent(query.replace(/ /g, "_"));
	const res = await fetch(`${WIKI_REST}/page/summary/${encoded}`, {
		headers: { "User-Agent": UA, "Api-User-Agent": UA },
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Title lookup failed: ${res.status}`);

	const data = (await res.json()) as { title: string; type: string };

	// Only treat standard articles as exact matches.
	// Disambiguation pages, no-extract pages, and the main page
	// are not useful — fall through to fulltext search instead.
	if (data.type !== "standard") return null;

	const redirectFrom = data.title.toLowerCase() !== query.toLowerCase() ? query : undefined;
	return { title: data.title, redirectFrom, type: data.type };
}

async function fullTextSearch(query: string, limit = 10): Promise<SearchResponse> {
	const params = new URLSearchParams({
		action: "query",
		list: "search",
		srsearch: query,
		srlimit: String(limit),
		srprop: "snippet|sectiontitle|size|wordcount",
		srinfo: "totalhits|suggestion",
		format: "json",
		formatversion: "2",
	});
	const res = await fetch(`${WIKI_API}?${params}`, {
		headers: { "User-Agent": UA, "Api-User-Agent": UA },
	});
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);

	// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
	const data = (await res.json()) as any;
	return {
		// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
		hits: (data.query.search as any[]).map((r) => ({
			title: r.title as string,
			snippet: (r.snippet as string).replace(/<[^>]*>/g, ""),
			sectionTitle: ((r.sectiontitle as string) || "").replace(/<[^>]*>/g, ""),
			wordcount: r.wordcount as number,
		})),
		totalHits: data.query.searchinfo?.totalhits ?? 0,
		suggestion: data.query.searchinfo?.suggestion,
	};
}

async function getPageContent(title: string): Promise<PageData> {
	const params = new URLSearchParams({
		action: "parse",
		page: title,
		prop: "wikitext|sections",
		format: "json",
		formatversion: "2",
	});
	const res = await fetch(`${WIKI_API}?${params}`, {
		headers: { "User-Agent": UA, "Api-User-Agent": UA },
	});
	if (!res.ok) throw new Error(`Page fetch failed: ${res.status}`);

	// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
	const data = (await res.json()) as any;
	if (data.error) throw new Error(data.error.info);

	return {
		title: data.parse.title,
		wikitext: data.parse.wikitext,
		// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
		sections: (data.parse.sections as any[]).map((s) => ({
			level: Number.parseInt(s.level, 10),
			name: (s.line as string).replace(/<[^>]*>/g, ""),
			byteoffset: s.byteoffset as number,
		})),
	};
}

// --- Wikitext parser ---

/**
 * Replace common value-containing templates with their plain-text equivalents
 * BEFORE stripNestedBraces runs, so that numeric data survives.
 */
export function preserveNumericTemplates(text: string): string {
	let t = text;

	// {{convert|VALUE|FROM_UNIT|TO_UNIT|...}} → "VALUE FROM_UNIT"
	// {{convert|VALUE|FROM_UNIT}} → "VALUE FROM_UNIT"
	// Handles optional extra params like abbr=on, sp=us, etc.
	t = t.replace(
		/\{\{convert\|([^|{}]+)\|([^|{}]+?)(?:\|[^{}]*)?\}\}/gi,
		(_m, value: string, unit: string) => `${value.trim()} ${unit.trim()}`,
	);

	// {{val|VALUE|u=UNIT}} → "VALUE UNIT"
	// {{val|VALUE}} → "VALUE"
	t = t.replace(/\{\{val\|([^|{}]+)(?:\|[^{}]*)?\}\}/gi, (_m, value: string) => {
		const full = _m as string;
		const unitMatch = full.match(/u=([^|{}]+)/i);
		if (unitMatch?.[1]) return `${value.trim()} ${unitMatch[1].trim()}`;
		return value.trim();
	});

	// {{formatnum:NUMBER}} → "NUMBER"
	t = t.replace(/\{\{formatnum:([^{}]+)\}\}/gi, (_m, num: string) => num.trim());

	// {{age|Y|M|D}} → calculate or keep as placeholder
	t = t.replace(/\{\{age\|(\d+)\|(\d+)\|(\d+)\}\}/gi, (_m, y: string, mo: string, d: string) => {
		const birth = new Date(Number(y), Number(mo) - 1, Number(d));
		const now = new Date();
		let age = now.getFullYear() - birth.getFullYear();
		const monthDiff = now.getMonth() - birth.getMonth();
		if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
			age--;
		}
		return String(age);
	});

	// {{circa|YEAR}} → "c. YEAR"
	t = t.replace(/\{\{circa\|([^|{}]+)\}\}/gi, (_m, year: string) => `c. ${year.trim()}`);

	// {{birth date|Y|M|D|...}} → "Y-M-D"  (also handles birth date and age)
	t = t.replace(
		/\{\{birth date(?:\s+and\s+age)?\|(\d+)\|(\d+)\|(\d+)(?:\|[^{}]*)?\}\}/gi,
		(_m, y: string, mo: string, d: string) => `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
	);

	// {{death date|Y|M|D|...}} → "Y-M-D"  (also handles death date and age)
	t = t.replace(
		/\{\{death date(?:\s+and\s+age)?\|(\d+)\|(\d+)\|(\d+)(?:\|[^{}]*)?\}\}/gi,
		(_m, y: string, mo: string, d: string) => `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
	);

	// {{coord|LAT|LON|...}} → "LAT, LON"
	// coord templates are complex; grab the first two numeric-looking params
	t = t.replace(
		/\{\{coord\|([^|{}]+)\|([^|{}]+)(?:\|[^{}]*)?\}\}/gi,
		(_m, a: string, b: string) => `${a.trim()}, ${b.trim()}`,
	);

	// {{pop density|POP|AREA|...}} → "POP/AREA"
	t = t.replace(
		/\{\{pop density\|([^|{}]+)\|([^|{}]+)(?:\|[^{}]*)?\}\}/gi,
		(_m, pop: string, area: string) => `${pop.trim()}/${area.trim()}`,
	);

	return t;
}

/**
 * Keys that are meta/formatting and should be skipped when extracting infoboxes.
 */
const INFOBOX_SKIP_KEYS = new Set([
	"image",
	"image_size",
	"image_caption",
	"image_alt",
	"image_map",
	"image_map1",
	"image2",
	"image3",
	"img",
	"photo",
	"logo",
	"logo_size",
	"logo_alt",
	"map",
	"map_size",
	"map_caption",
	"map_alt",
	"map_image",
	"map1",
	"mapframe",
	"pushpin",
	"pushpin_map",
	"pushpin_map_alt",
	"pushpin_map_caption",
	"pushpin_label",
	"pushpin_label_position",
	"embed",
	"module",
	"child",
	"caption",
	"label_position",
	"relief",
	"coordinates_ref",
	"elevation_ref",
	"footnotes",
	"blank_name",
	"blank_info",
	"blank1_name",
	"blank1_info",
	"blank2_name",
	"blank2_info",
	"image_flag",
	"flag_size",
	"image_seal",
	"seal_size",
	"image_shield",
	"shield_size",
	"image_skyline",
	"imagesize",
	"image_blank_emblem",
	"blank_emblem_size",
	"mapsize",
	"mapsize1",
	"map_caption1",
	"style",
	"bodystyle",
	"abovestyle",
	"headerstyle",
	"labelstyle",
	"datastyle",
	"above",
	"header",
	"header1",
	"header2",
	"header3",
	"width",
	"fetchwikidata",
	"label",
	"native_name",
	"native_name_lang",
	"other_name",
	"prominence_ref",
	"isolation",
	"signature",
	"signature_alt",
	"thesis_url",
	"website",
	"url",
	"commons",
	"iucn_category",
]);

/**
 * Extract infobox templates from wikitext, parse their key-value pairs into
 * plain-text blocks, and replace the infobox templates with those blocks.
 * Runs BEFORE stripNestedBraces so that infobox data survives.
 */
export function extractInfoboxes(text: string): string {
	let result = "";
	let i = 0;

	while (i < text.length) {
		// Look for {{ opening
		if (i + 1 < text.length && text[i] === "{" && text[i + 1] === "{") {
			// Check if this is an Infobox template
			const afterBraces = text.slice(i + 2, i + 2 + 20);
			if (/^\s*infobox/i.test(afterBraces)) {
				// Find the end of this template using brace-depth counting
				let depth = 1;
				let j = i + 2;
				while (j < text.length && depth > 0) {
					if (j + 1 < text.length && text[j] === "{" && text[j + 1] === "{") {
						depth++;
						j += 2;
					} else if (j + 1 < text.length && text[j] === "}" && text[j + 1] === "}") {
						depth--;
						j += 2;
					} else {
						j++;
					}
				}
				// text[i..j) is the full infobox template including {{ and }}
				const infoboxRaw = text.slice(i + 2, j - 2); // content between {{ and }}
				const extracted = parseInfoboxContent(infoboxRaw);
				result += extracted;
				i = j;
				continue;
			}
		}
		result += text[i];
		i++;
	}

	return result;
}

/**
 * Parse the inner content of an infobox template and return a plain-text block
 * of key-value pairs. Returns empty string if no useful pairs are found
 * (e.g. transcluded infoboxes with no parameters).
 */
function parseInfoboxContent(raw: string): string {
	const pairs: Array<{ key: string; value: string }> = [];

	// Split on | at depth 0 (not inside nested {{ }} or [[ ]])
	const segments: string[] = [];
	let braceDepth = 0;
	let bracketDepth = 0;
	let segStart = 0;
	for (let ci = 0; ci < raw.length; ci++) {
		if (ci + 1 < raw.length && raw[ci] === "{" && raw[ci + 1] === "{") {
			braceDepth++;
			ci++; // skip next char
		} else if (ci + 1 < raw.length && raw[ci] === "}" && raw[ci + 1] === "}") {
			braceDepth--;
			ci++;
		} else if (ci + 1 < raw.length && raw[ci] === "[" && raw[ci + 1] === "[") {
			bracketDepth++;
			ci++;
		} else if (ci + 1 < raw.length && raw[ci] === "]" && raw[ci + 1] === "]") {
			bracketDepth--;
			ci++;
		} else if (raw[ci] === "|" && braceDepth === 0 && bracketDepth === 0) {
			segments.push(raw.slice(segStart, ci));
			segStart = ci + 1;
		}
	}
	segments.push(raw.slice(segStart));

	// First segment is the template name (e.g. "Infobox mountain\n"), skip it
	for (let si = 1; si < segments.length; si++) {
		const seg = segments[si]!;
		const eqIdx = seg.indexOf("=");
		if (eqIdx < 0) continue; // positional parameter, skip

		const rawKey = seg.slice(0, eqIdx).trim();
		const rawValue = seg.slice(eqIdx + 1).trim();

		if (!rawKey || !rawValue) continue;

		// Normalize key for skip-check: lowercase, strip trailing digits
		const keyNorm = rawKey.toLowerCase().replace(/\d+$/, "").trim();
		if (INFOBOX_SKIP_KEYS.has(keyNorm)) continue;
		// Also check the raw lowercase key (without digit stripping) for exact matches
		if (INFOBOX_SKIP_KEYS.has(rawKey.toLowerCase().trim())) continue;

		// Skip keys that match layout/infrastructure patterns
		if (/^mapframe/i.test(keyNorm)) continue;
		if (/_(ref|style|type|link)$/i.test(keyNorm) && !/^(leader|government)_type$/i.test(keyNorm)) {
			continue;
		}
		if (/^(parts|seat|established|blank_emblem|subdivision)_?(type|style)/i.test(keyNorm)) {
			continue;
		}
		// Skip image/visual-related compound keys
		if (
			/image|img|photo|logo|map|flag|seal|shield|skyline|emblem|icon/i.test(keyNorm) &&
			/size|caption|alt|_map|file|name/i.test(keyNorm)
		) {
			continue;
		}

		// Clean the value
		let val = rawValue;

		// Run preserveNumericTemplates on the value to convert {{convert}}, {{coord}}, etc.
		val = preserveNumericTemplates(val);

		// Strip remaining nested templates ({{ ... }}) from the value
		val = stripNestedBracesSimple(val);

		// Strip <ref>...</ref> and <ref ... />
		val = val.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
		val = val.replace(/<ref[^>]*\/>/gi, "");

		// Strip HTML tags but keep content
		val = val.replace(/<\/?[a-z][^>]*\/?>/gi, "");

		// Convert wikilinks: [[target|display]] → display, [[target]] → target
		val = val.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
		val = val.replace(/\[\[([^\]]*)\]\]/g, "$1");

		// Strip external links: [http://... display] → display
		val = val.replace(/\[https?:\/\/[^\s\]]*\s+([^\]]+)\]/g, "$1");
		val = val.replace(/\[https?:\/\/[^\s\]]*\]/g, "");

		// Clean up excess whitespace
		val = val.replace(/\s+/g, " ").trim();

		// Skip if value is empty or just punctuation/whitespace after cleaning
		if (!val || /^[\s.,;:\-–—]*$/.test(val)) continue;

		// Skip values that are just filenames or URLs
		if (/\.(jpg|jpeg|png|svg|gif|webp|pdf)$/i.test(val)) continue;
		if (/^https?:\/\//i.test(val)) continue;

		// Format the key: underscores to spaces, title case first word
		const readableKey = formatInfoboxKey(rawKey);

		pairs.push({ key: readableKey, value: val });
	}

	if (pairs.length === 0) return "";

	// Format as a plain-text block
	const lines = pairs.map((p) => `${p.key}: ${p.value}`);
	return `\n${lines.join("\n")}\n`;
}

/**
 * Strip nested {{ }} from a string. Simpler version used for cleaning infobox values.
 */
function stripNestedBracesSimple(text: string): string {
	let out = "";
	let i = 0;
	let depth = 0;
	while (i < text.length) {
		if (i + 1 < text.length && text[i] === "{" && text[i + 1] === "{") {
			depth++;
			i += 2;
		} else if (i + 1 < text.length && text[i] === "}" && text[i + 1] === "}") {
			if (depth > 0) depth--;
			i += 2;
		} else {
			if (depth === 0) out += text[i];
			i++;
		}
	}
	return out;
}

/**
 * Format an infobox key into readable form.
 * "elevation_m" → "Elevation m", "first_ascent" → "First ascent"
 */
function formatInfoboxKey(key: string): string {
	// Replace underscores with spaces
	let k = key.replace(/_/g, " ").trim();
	// Title case the first letter
	if (k.length > 0) {
		k = k.charAt(0).toUpperCase() + k.slice(1);
	}
	return k;
}

function stripNestedBraces(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (i + 1 < text.length && text[i] === "{" && text[i + 1] === "{") {
			let depth = 1;
			i += 2;
			while (i < text.length && depth > 0) {
				if (i + 1 < text.length && text[i] === "{" && text[i + 1] === "{") {
					depth++;
					i += 2;
				} else if (i + 1 < text.length && text[i] === "}" && text[i + 1] === "}") {
					depth--;
					i += 2;
				} else {
					i++;
				}
			}
		} else {
			out += text[i];
			i++;
		}
	}
	return out;
}

function stripFiles(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ahead = text.slice(i, i + 9).toLowerCase();
		if (
			text[i] === "[" &&
			text[i + 1] === "[" &&
			(ahead.startsWith("[[file:") || ahead.startsWith("[[image:"))
		) {
			let depth = 1;
			i += 2;
			let lastPipe = -1;
			while (i < text.length && depth > 0) {
				if (i + 1 < text.length && text[i] === "[" && text[i + 1] === "[") {
					depth++;
					i += 2;
				} else if (i + 1 < text.length && text[i] === "]" && text[i + 1] === "]") {
					depth--;
					if (depth === 0) {
						if (lastPipe >= 0) {
							const caption = text.slice(lastPipe + 1, i).trim();
							if (
								caption &&
								!caption.includes("=") &&
								!/^\d+px$/i.test(caption) &&
								!/^(thumb|frame|frameless|left|right|center|none|upright|border)$/i.test(caption)
							) {
								out += caption;
							}
						}
						i += 2;
					} else {
						i += 2;
					}
				} else {
					if (depth === 1 && text[i] === "|") lastPipe = i;
					i++;
				}
			}
		} else {
			out += text[i];
			i++;
		}
	}
	return out;
}

const BOILERPLATE = new Set([
	"references",
	"external links",
	"further reading",
	"see also",
	"notes",
	"footnotes",
	"bibliography",
	"sources",
	"citations",
]);

function stripBoilerplateSections(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let skip = false;
	let skipLevel = 0;
	for (const line of lines) {
		const m = line.match(/^(={2,})\s*(.+?)\s*={2,}\s*$/);
		if (m?.[1] && m[2]) {
			const level = m[1].length;
			const name = m[2].toLowerCase().trim();
			if (BOILERPLATE.has(name)) {
				skip = true;
				skipLevel = level;
				continue;
			}
			if (skip && level <= skipLevel) skip = false;
		}
		if (!skip) out.push(line);
	}
	return out.join("\n");
}

function abbreviateRef(body: string): string {
	// Try to extract author from {{cite ...}} template
	const lastMatch = body.match(/\|\s*last\d?\s*=\s*([^|}\n]+)/i);
	if (lastMatch?.[1]) return `[${lastMatch[1].trim()}]`;
	// Try author= field
	const authorMatch = body.match(/\|\s*authors?\s*=\s*([^|}\n]+)/i);
	if (authorMatch?.[1]) {
		const author = authorMatch[1].trim();
		// Take first surname (up to first comma or space after first word)
		const short = author.match(/^[\w'-]+/)?.[0];
		if (short) return `[${short}]`;
	}
	// Try to get title from cite template
	const titleMatch = body.match(/\|\s*title\s*=\s*([^|}\n]+)/i);
	if (titleMatch?.[1]) {
		const title = titleMatch[1].trim();
		const words = title.split(/\s+/).slice(0, 3).join(" ");
		return `[${words}]`;
	}
	// Plain text ref (not a template): take first few words
	const plain = body
		.replace(/\{\{[^}]*\}\}/g, "")
		.replace(/<[^>]*>/g, "")
		.trim();
	if (plain.length > 0) {
		const words = plain.split(/\s+/).slice(0, 3).join(" ");
		if (words.length > 2) return `[${words}]`;
	}
	// Nothing useful — strip entirely
	return "";
}

export function parseWikitext(raw: string): string {
	let t = raw;
	// HTML comments
	t = t.replace(/<!--[\s\S]*?-->/g, "");
	// Named self-closing refs: <ref name="X" /> → [X]
	t = t.replace(/<ref\s[^>]*?name\s*=\s*["']?([^"'\s/>]+)["']?[^>]*?\/>/gi, "[$1]");
	// Named refs with content: <ref name="X">...</ref> → [X]
	t = t.replace(/<ref\s[^>]*?name\s*=\s*["']?([^"'\s/>]+)["']?[^>]*?>[\s\S]*?<\/ref>/gi, "[$1]");
	// Unnamed refs: extract short abbreviation or strip
	t = t.replace(/<ref[^>]*>([\s\S]*?)<\/ref>/gi, (_match, body: string) => {
		return abbreviateRef(body);
	});
	// Remaining self-closing refs
	t = t.replace(/<ref[^>]*\/>/gi, "");
	// Categories
	t = t.replace(/\[\[Category:[^\]]*\]\]/gi, "");
	// Files/images (keep captions)
	t = stripFiles(t);
	// Preserve numeric/value templates before stripping all templates
	t = preserveNumericTemplates(t);
	// Extract infobox data as plain text before stripping all templates
	t = extractInfoboxes(t);
	// Templates (strips remaining junk like {{cite web}}, {{reflist}}, etc.)
	t = stripNestedBraces(t);
	// Gallery
	t = t.replace(/<gallery[\s\S]*?<\/gallery>/gi, "");
	// Magic words
	t = t.replace(/__[A-Z]+__/g, "");
	// HTML tags (keep content)
	t = t.replace(/<\/?[a-z][^>]*\/?>/gi, "");
	// Boilerplate sections
	t = stripBoilerplateSections(t);
	// Whitespace cleanup
	t = t.replace(/\n{3,}/g, "\n\n");
	return t.trim();
}

// --- Lead section ---

function extractLead(content: string): string {
	const headingIdx = content.search(/^==[^=]/m);
	if (headingIdx <= 0) return content;
	return content.slice(0, headingIdx).trim();
}

// --- Sections ---

const MAX_LISTED_SECTIONS = 12;

function topLevelSections(sections: PageSection[]): string[] {
	const out: string[] = [];
	for (const s of sections) {
		if (s.level !== 2) continue;
		if (BOILERPLATE.has(s.name.toLowerCase())) continue;
		out.push(s.name);
	}
	return out;
}

function formatSections(leaves: string[]): string {
	if (leaves.length <= MAX_LISTED_SECTIONS) {
		return `<sections>${leaves.map(x).join(" | ")}</sections>`;
	}
	const shown = leaves.slice(0, MAX_LISTED_SECTIONS);
	const more = leaves.length - MAX_LISTED_SECTIONS;
	return `<sections>${shown.map(x).join(" | ")} (+${more} more)</sections>`;
}

const SECTION_CAP = 800;

function extractSection(wikitext: string, name: string, query?: string): string {
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^(={2,})\\s*${esc}\\s*\\1\\s*$`, "m");
	const m = re.exec(wikitext);
	if (!m?.[1]) return "";
	const level = m[1].length;
	const start = m.index;
	const rest = wikitext.slice(start + m[0].length);
	const end = rest.match(new RegExp(`^={2,${level}}[^=]`, "m"));
	const full = wikitext.slice(start, start + m[0].length + (end?.index ?? rest.length)).trim();

	// Skip cap if the query contains the exact section name
	if (query?.toLowerCase().includes(name.toLowerCase())) return full;
	if (full.length <= SECTION_CAP) return full;

	// Select complete sentences/paragraphs from the center of the section
	const headingEnd = full.indexOf("\n");
	const heading = headingEnd >= 0 ? `${full.slice(0, headingEnd + 1)}` : "";
	const body = headingEnd >= 0 ? full.slice(headingEnd + 1) : full;
	const bodyBudget = SECTION_CAP - heading.length;
	if (body.length <= bodyBudget) return full;

	const chunks = splitChunks(body);
	if (chunks.length === 0) return heading;

	// Find the chunk nearest the center of the body by character offset
	let offset = 0;
	const offsets: number[] = [];
	for (const c of chunks) {
		offsets.push(offset + c.length / 2);
		offset += c.length;
	}
	const bodyMid = body.length / 2;
	let centerIdx = 0;
	let bestDist = Infinity;
	for (let i = 0; i < offsets.length; i++) {
		const dist = Math.abs((offsets[i] ?? 0) - bodyMid);
		if (dist < bestDist) {
			bestDist = dist;
			centerIdx = i;
		}
	}

	// Expand outward from center, alternating before/after, adding whole chunks
	const selected = new Set<number>([centerIdx]);
	let used = chunks[centerIdx]?.length ?? 0;
	let lo = centerIdx - 1;
	let hi = centerIdx + 1;
	while (used < bodyBudget && (lo >= 0 || hi < chunks.length)) {
		// Alternate: try before, then after
		if (lo >= 0) {
			const c = chunks[lo]!;
			if (used + c.length + 2 <= bodyBudget) {
				selected.add(lo);
				used += c.length + 2;
			}
			lo--;
		}
		if (hi < chunks.length) {
			const c = chunks[hi]!;
			if (used + c.length + 2 <= bodyBudget) {
				selected.add(hi);
				used += c.length + 2;
			}
			hi++;
		}
		if (used >= bodyBudget) break;
		if (lo < 0 && hi >= chunks.length) break;
	}

	const minSel = Math.min(...selected);
	const maxSel = Math.max(...selected);
	const parts: string[] = [];
	for (let i = minSel; i <= maxSel; i++) {
		const chunk = chunks[i];
		if (selected.has(i) && chunk) parts.push(chunk);
	}
	const prefix = minSel > 0 ? "[...] " : "";
	const suffix = maxSel < chunks.length - 1 ? "\n[...]" : "";
	return `${heading}${prefix}${parts.join("\n\n")}${suffix}`;
}

function detectSections(
	query: string,
	title: string,
	sections: PageSection[],
	hits: SearchHit[],
): string[] {
	const found = new Set<string>();
	// From search results matching this article
	for (const h of hits) {
		if (h.title === title && h.sectionTitle) found.add(h.sectionTitle);
	}
	// From query words that match section names
	const titleWords = new Set(title.toLowerCase().split(/\s+/));
	const extras = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => !titleWords.has(w) && w.length > 2);
	if (extras.length > 0) {
		for (const s of sections) {
			const lower = s.name.toLowerCase();
			for (const w of extras) {
				if (lower.includes(w)) found.add(s.name);
			}
		}
	}
	return [...found];
}

// --- XML helpers ---

function x(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function cdata(text: string): string {
	return `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

/**
 * Split text into atomic chunks that should not be broken apart.
 * Splits on paragraph breaks first (\n\n), then within long paragraphs
 * on sentence boundaries. Returns an array of chunks.
 */
function splitChunks(text: string): string[] {
	const paragraphs = text.split(/\n\n+/);
	const chunks: string[] = [];
	// Sentence boundary: period/question/exclamation followed by optional
	// closing punctuation and then a space + uppercase letter or newline.
	// Uses a lookbehind to avoid splitting on abbreviations like "Dr." or "U.S."
	// by requiring at least 10 chars before the split point.
	const sentenceSplit = /([.!?]["')»\]]*)\s+(?=[A-Z['("])/g;

	for (const para of paragraphs) {
		if (para.length <= 300) {
			chunks.push(para);
			continue;
		}
		// Split long paragraphs into sentences
		let last = 0;
		sentenceSplit.lastIndex = 0;
		for (let m = sentenceSplit.exec(para); m !== null; m = sentenceSplit.exec(para)) {
			const end = m.index + m[1]!.length;
			chunks.push(para.slice(last, end));
			last = end;
		}
		if (last < para.length) {
			chunks.push(para.slice(last));
		}
	}
	return chunks.map((c) => c.trim()).filter(Boolean);
}

/**
 * Truncate text to fit within `limit` characters, cutting only at
 * paragraph or sentence boundaries. Always produces complete thoughts.
 */
function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const chunks = splitChunks(text);
	let result = "";
	for (const chunk of chunks) {
		const sep = result.length > 0 ? "\n\n" : "";
		if (result.length + sep.length + chunk.length + 14 > limit) break;
		result += sep + chunk;
	}
	// If we couldn't fit even one chunk, take as much of the first as possible
	// cutting at a word boundary
	if (!result && chunks[0]) {
		const c = chunks[0].slice(0, limit - 14);
		const lastSpace = c.lastIndexOf(" ");
		result = lastSpace > 0 ? c.slice(0, lastSpace) : c;
	}
	return `${result.trimEnd()}\n[truncated]`;
}

// --- Deduplication (sentence-level, scoped per article) ---

export interface SeenContent {
	/** Per-article sets of normalised chunks already returned. */
	articles: Map<string, Set<string>>;
	/** Cached raw page data — avoids re-fetching the same article from Wikipedia. */
	pageCache: Map<string, PageData>;
}

export function createSeenContent(): SeenContent {
	return { articles: new Map(), pageCache: new Map() };
}

const MIN_DEDUP_LENGTH = 40;

function normalizeChunk(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function isHeader(chunk: string): boolean {
	return /^={2,}\s*.+\s*={2,}\s*$/.test(chunk.trim());
}

function isDedupable(chunk: string): boolean {
	return !isHeader(chunk) && chunk.length >= MIN_DEDUP_LENGTH;
}

function articleSeen(article: string, seen: SeenContent): Set<string> {
	const key = article.toLowerCase();
	let set = seen.articles.get(key);
	if (!set) {
		set = new Set();
		seen.articles.set(key, set);
	}
	return set;
}

/**
 * Remove already-returned sentences from text.
 * Scoped to a single article so identical sentences in different
 * articles are never falsely deduplicated.
 * Headers and very short chunks are always kept (structural context,
 * too short to reliably deduplicate).
 */
function filterSeen(text: string, article: string, seen: SeenContent): string {
	const set = articleSeen(article, seen);
	const chunks = splitChunks(text);
	const novel: string[] = [];
	for (const chunk of chunks) {
		if (!isDedupable(chunk) || !set.has(normalizeChunk(chunk))) {
			novel.push(chunk);
		}
	}
	return novel.join("\n\n");
}

/**
 * Returns true if text has any novel content chunks (non-header, non-trivial)
 * that haven't been returned for this article yet.
 */
function hasNovelContent(text: string, article: string, seen: SeenContent): boolean {
	const set = articleSeen(article, seen);
	for (const chunk of splitChunks(text)) {
		if (!isDedupable(chunk)) continue;
		if (!set.has(normalizeChunk(chunk))) return true;
	}
	return false;
}

/**
 * Returns true if any content chunk in text was already returned
 * for this article.
 */
function hasSeenChunks(text: string, article: string, seen: SeenContent): boolean {
	const set = articleSeen(article, seen);
	for (const chunk of splitChunks(text)) {
		if (!isDedupable(chunk)) continue;
		if (set.has(normalizeChunk(chunk))) return true;
	}
	return false;
}

/** Mark all substantial chunks in text as seen for this article. */
function markContentSeen(text: string, article: string, seen: SeenContent): void {
	const set = articleSeen(article, seen);
	for (const chunk of splitChunks(text)) {
		if (!isDedupable(chunk)) continue;
		set.add(normalizeChunk(chunk));
	}
}

/**
 * Combined filter + novelty check in a single pass over chunks.
 * Avoids the double splitChunks call that happens when filterSeen
 * and hasNovelContent are called sequentially on the same text.
 */
function filterAndCheckNovelty(
	text: string,
	article: string,
	seen: SeenContent,
): { filtered: string; hasNovel: boolean } {
	const set = articleSeen(article, seen);
	const chunks = splitChunks(text);
	const novel: string[] = [];
	let hasNovel = false;
	for (const chunk of chunks) {
		if (!isDedupable(chunk)) {
			novel.push(chunk);
			continue;
		}
		if (!set.has(normalizeChunk(chunk))) {
			novel.push(chunk);
			hasNovel = true;
		}
	}
	return { filtered: novel.join("\n\n"), hasNovel };
}

/** Fetch page content, using the SeenContent page cache when available. */
async function getPageContentCached(title: string, seen?: SeenContent): Promise<PageData> {
	if (seen) {
		const cached = seen.pageCache.get(title);
		if (cached) return cached;
	}
	const page = await getPageContent(title);
	if (seen) seen.pageCache.set(title, page);
	return page;
}

// --- Intro trimming ---

/**
 * Trim intro text to fit a budget, prioritizing infobox lines over prose.
 * Infobox lines are "Key: Value" format (from extractInfoboxes).
 * Prose lines are everything else (opening paragraphs, image captions, etc.).
 */
function trimIntro(intro: string, budget: number): string {
	if (intro.length <= budget) return intro;

	const lines = intro.split("\n");
	const infoboxLines: string[] = [];
	const proseLines: string[] = [];

	for (const line of lines) {
		// Infobox lines match "Key: Value" pattern (from extractInfoboxes output)
		if (/^[A-Z][a-z_ ]+: ./.test(line)) {
			infoboxLines.push(line);
		} else if (line.trim()) {
			proseLines.push(line);
		}
	}

	// Build result: infobox lines first, then prose, within budget
	let result = "";
	for (const line of infoboxLines) {
		if (result.length + line.length + 1 > budget) break;
		result += `${line}\n`;
	}
	// Add a blank line separator if we have both types
	if (result && proseLines.length > 0) result += "\n";
	for (const line of proseLines) {
		if (result.length + line.length + 1 > budget) break;
		result += `${line}\n`;
	}
	return result.trim();
}

// --- Main ---

export async function searchWikipedia(query: string, seen?: SeenContent): Promise<string> {
	const errors: string[] = [];
	try {
		const [title, search] = await Promise.all([
			lookupTitle(query).catch((e) => {
				errors.push(`lookup: ${e instanceof Error ? e.message : String(e)}`);
				return null;
			}),
			fullTextSearch(query).catch((e): SearchResponse => {
				errors.push(`search: ${e instanceof Error ? e.message : String(e)}`);
				return { hits: [], totalHits: 0, suggestion: undefined };
			}),
		]);

		if (title) return await articleResult(query, title, search, seen);
		if (errors.length > 0 && search.hits.length === 0) {
			return `<error query="${x(query)}">${x(errors.join("; "))}</error>`;
		}
		return await searchResults(query, search, seen);
	} catch (err) {
		return `<error query="${x(query)}">${x(err instanceof Error ? err.message : String(err))}</error>`;
	}
}

async function articleResult(
	query: string,
	title: TitleResult,
	search: SearchResponse,
	seen?: SeenContent,
): Promise<string> {
	const page = await getPageContentCached(title.title, seen);
	const content = parseWikitext(page.wikitext);
	const leaves = topLevelSections(page.sections);
	const isStub = content.length < 500;

	// Split content into intro (before first == header) and the rest.
	// Intro contains infobox data + opening paragraph.
	const firstHeader = content.indexOf("\n==");
	const intro = firstHeader > 0 ? content.slice(0, firstHeader).trim() : "";

	const relevant = detectSections(query, title.title, page.sections, search.hits);
	let body = "";
	if (relevant.length > 0) {
		const sections = relevant
			.map((n) => extractSection(content, n, query))
			.filter(Boolean)
			.join("\n\n");

		// Budget: matched sections get priority, intro fills remaining space.
		// Within intro, infobox lines (Key: Value) are prioritized over prose.
		const sectionBudget = Math.min(sections.length, CHAR_LIMIT * 0.7);
		const introBudget = CHAR_LIMIT * 0.6 - sectionBudget;
		const trimmedIntro = introBudget > 100 ? trimIntro(intro, introBudget) : "";
		body = trimmedIntro ? `${trimmedIntro}\n\n${sections}` : sections;
	}
	if (!body) body = content;

	// Single-pass filter + novelty check (avoids double splitChunks on body)
	let novelBody: string;
	if (seen) {
		const { filtered, hasNovel } = filterAndCheckNovelty(body, title.title, seen);
		if (!hasNovel) {
			let xml = `<result query="${x(query)}">\n`;
			xml += `<article title="${x(title.title)}" already_returned="true">\n`;
			xml += `${formatSections(leaves)}\n`;
			xml += "</article>\n</result>";
			return xml;
		}
		novelBody = filtered;
	} else {
		novelBody = body;
	}

	let xml = `<result query="${x(query)}">\n`;
	if (title.redirectFrom) {
		xml += `<redirect from="${x(title.redirectFrom)}" to="${x(title.title)}" />\n`;
	}
	xml += `<article title="${x(title.title)}"`;
	if (title.type !== "standard") xml += ` type="${x(title.type)}"`;
	xml += `>\n`;
	xml += `${formatSections(leaves)}\n`;

	const close = "</article>\n</result>";
	const budget = CHAR_LIMIT - xml.length - close.length - 25;

	const finalBody = truncate(novelBody, budget);
	xml += `<content>${cdata(`\n${finalBody}\n`)}</content>\n`;
	xml += "</article>\n";

	if (isStub && search.hits.length > 1) {
		const remain = CHAR_LIMIT - xml.length - 20;
		if (remain > 100) xml += searchSnippets(search, remain, title.title);
	}

	xml += "</result>";
	if (seen) markContentSeen(finalBody, title.title, seen);
	return xml;
}

async function searchResults(
	query: string,
	search: SearchResponse,
	seen?: SeenContent,
): Promise<string> {
	if (search.hits.length === 0) {
		let xml = `<result query="${x(query)}"><no_results`;
		if (search.suggestion) xml += ` suggestion="${x(search.suggestion)}"`;
		return `${xml} /></result>`;
	}

	const top = search.hits.slice(0, 3);
	const pages = await Promise.all(
		top.map((h) => getPageContentCached(h.title, seen).catch(() => null)),
	);

	// Parse each page exactly once and pre-compute novelty flags
	const parsed = pages.map((page) => (page ? parseWikitext(page.wikitext) : null));
	const novelFlags = parsed.map((p, idx) => {
		if (!p) return false;
		if (!seen) return true;
		return hasNovelContent(p, top[idx]!.title, seen);
	});
	const novelCount = novelFlags.filter(Boolean).length;

	let xml = `<result query="${x(query)}" total="${search.totalHits}"`;
	if (search.suggestion) xml += ` suggestion="${x(search.suggestion)}"`;
	xml += ">\n";
	let remaining = CHAR_LIMIT - xml.length - 20;
	let novelRendered = 0;

	for (let i = 0; i < top.length && remaining > 100; i++) {
		const hit = top[i];
		const page = pages[i];
		const content = parsed[i];
		if (!page || !hit || !content) continue;

		// If every sentence was already returned, emit compact tag
		if (seen && !novelFlags[i]) {
			xml += `<page title="${x(hit.title)}" already_returned="true" />\n`;
			continue;
		}

		const leaves = topLevelSections(page.sections);
		const secList = `${formatSections(leaves)}\n`;

		let tag = `<page title="${x(hit.title)}"`;
		if (hit.sectionTitle) tag += ` section="${x(hit.sectionTitle)}"`;
		tag += ">\n";
		const closeTag = "</page>\n";
		const overhead = tag.length + secList.length + closeTag.length + 25;

		// Cap per-result budget so one result can't starve the rest
		const novelLeft = novelCount - novelRendered;
		const perResultBudget = Math.floor(remaining / Math.max(novelLeft, 1));
		const contentBudget = perResultBudget - overhead;

		if (contentBudget < 80) continue;

		// Build body, then filter to novel sentences only.
		// The matched section is the primary content — give it priority
		// over the lead introduction when budget is tight.
		let body: string;
		if (content.length <= contentBudget && (!seen || !hasSeenChunks(content, hit.title, seen))) {
			// Full article fits and is entirely novel — use as-is
			body = content;
		} else {
			const lead = extractLead(content);
			const section = hit.sectionTitle ? extractSection(content, hit.sectionTitle, query) : "";
			if (section && section !== lead) {
				const sep = "\n\n";
				const total = lead.length + sep.length + section.length;
				if (total <= contentBudget) {
					body = `${lead}${sep}${section}`;
				} else if (section.length >= contentBudget) {
					// Section alone exceeds budget — use just the section
					body = section;
				} else {
					// Section fits; truncate lead to fill remaining space
					const leadBudget = contentBudget - section.length - sep.length;
					if (leadBudget >= 100) {
						body = `${truncate(lead, leadBudget)}${sep}${section}`;
					} else {
						body = section;
					}
				}
			} else {
				body = lead || content;
			}
		}

		const novelBody = seen ? filterSeen(body, hit.title, seen) : body;
		const finalBody =
			novelBody.length <= contentBudget ? novelBody : truncate(novelBody, contentBudget);
		xml += `${tag}${secList}<content>${cdata(`\n${finalBody}\n`)}</content>\n${closeTag}`;

		if (seen) markContentSeen(finalBody, hit.title, seen);
		novelRendered++;
		remaining = CHAR_LIMIT - xml.length - 20;
	}

	xml += "</result>";
	return xml;
}

function searchSnippets(search: SearchResponse, budget: number, exclude?: string): string {
	let xml = `<also_found total="${search.totalHits}">\n`;
	for (const h of search.hits) {
		if (h.title === exclude) continue;
		const entry = `<hit title="${x(h.title)}" section="${x(h.sectionTitle)}">${x(h.snippet)}</hit>\n`;
		if (xml.length + entry.length + 15 > budget) break;
		xml += entry;
	}
	xml += "</also_found>\n";
	return xml;
}
