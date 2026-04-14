const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";
const CHAR_LIMIT = 4000;
const UA = "WikiSearchMCP/1.0 (https://wikisearch.sauerslabs.workers.dev; sauerslabs@gmail.com)";

// Wikimedia's UA policy blocks generic/default UAs with HTTP 429 — so in
// server/CLI contexts (Node, Bun, Workers) we include a descriptive
// User-Agent. Browsers forbid setting User-Agent in fetch() and inject their
// own (which Wikimedia accepts), so we skip it there to avoid the warning.
const IS_BROWSER =
	typeof (globalThis as { window?: unknown }).window !== "undefined" &&
	typeof (globalThis as { document?: unknown }).document !== "undefined";
const WIKI_HEADERS: Record<string, string> = IS_BROWSER
	? { "Api-User-Agent": UA }
	: { "User-Agent": UA, "Api-User-Agent": UA };

// --- Retry-aware fetch for Wikipedia endpoints ---

const WIKI_MAX_ATTEMPTS = 3;
const WIKI_RETRY_AFTER_CAP_MS = 10_000;
const WIKI_BACKOFF_BASE_MS = [500, 1000, 2000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip query string and keep a readable label for logging. */
function shortenWikiUrl(url: string): string {
	const qIdx = url.indexOf("?");
	const base = qIdx === -1 ? url : url.slice(0, qIdx);
	if (qIdx !== -1) {
		const params = new URLSearchParams(url.slice(qIdx + 1));
		const action = params.get("action");
		if (action) return `${base}?action=${action}`;
	}
	return base;
}

/** Parse a Retry-After header that specifies an integer number of seconds. */
function parseRetryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (!trimmed) return null;
	const seconds = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return seconds * 1000;
}

/**
 * Fetch a Wikipedia URL with graceful retry on HTTP 429.
 * - Up to 3 total attempts.
 * - Honors Retry-After (seconds), capped at 10s.
 * - Falls back to jittered exponential backoff (500/1000/2000ms ±20%).
 * - Does NOT retry non-429 responses or network exceptions.
 */
async function wikiFetch(url: string, init?: RequestInit): Promise<Response> {
	let lastResponse: Response | null = null;
	for (let attempt = 1; attempt <= WIKI_MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url, init);
		if (res.status !== 429) return res;
		lastResponse = res;
		if (attempt === WIKI_MAX_ATTEMPTS) break;

		const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
		let waitMs: number;
		if (retryAfterMs !== null) {
			waitMs = Math.min(retryAfterMs, WIKI_RETRY_AFTER_CAP_MS);
		} else {
			const base = WIKI_BACKOFF_BASE_MS[attempt - 1] ?? 2000;
			const jitter = 1 + (Math.random() * 0.4 - 0.2);
			waitMs = Math.round(base * jitter);
		}
		console.warn(
			`[wiki] 429 on ${shortenWikiUrl(url)}, retrying in ${waitMs}ms (attempt ${attempt}/${WIKI_MAX_ATTEMPTS})`,
		);
		await sleep(waitMs);
	}
	// Exhausted attempts — return the final 429 response so the caller's
	// existing `if (!res.ok) throw ...` path fires with the same error shape.
	return lastResponse as Response;
}

// --- HTML entity + whitespace helpers ---

const HTML_ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&thinsp;": " ",
	"&ensp;": " ",
	"&emsp;": " ",
	"&ndash;": "\u2013",
	"&mdash;": "\u2014",
	"&minus;": "\u2212",
	"&#x20;": " ",
	"&#x200b;": "",
	"&#x23;": "#",
	"&#91;": "[",
	"&#93;": "]",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
};

/** Decode named/numeric HTML entities using a lookup table. */
function decodeHtmlEntities(text: string): string {
	let t = text;
	for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
		t = t.replaceAll(entity, char);
	}
	// Remaining numeric entities: &#123; and &#xAB;
	t = t.replaceAll(/&#\d+;/g, "");
	t = t.replaceAll(/&#x[\da-fA-F]+;/g, "");
	return t;
}

/** Collapse runs of whitespace to a single space and trim. */
function collapseWhitespace(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

/** Normalize en-dashes, em-dashes, minus signs, etc. to plain hyphens. */
function normalizeDashes(s: string): string {
	return s.replaceAll(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-");
}

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
	const encoded = encodeURIComponent(query.replaceAll(" ", "_"));
	const res = await wikiFetch(`${WIKI_REST}/page/summary/${encoded}`, {
		headers: WIKI_HEADERS,
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
		origin: "*",
	});
	const res = await wikiFetch(`${WIKI_API}?${params}`, {
		headers: WIKI_HEADERS,
	});
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);

	// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
	const data = (await res.json()) as any;
	if (data.error) throw new Error(data.error.info ?? "Wikipedia search error");
	return {
		// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
		hits: ((data.query?.search ?? []) as any[]).map((r) => ({
			title: r.title as string,
			snippet: (r.snippet as string).replace(/<[^>]*>/g, ""),
			sectionTitle: ((r.sectiontitle as string) || "").replace(/<[^>]*>/g, ""),
			wordcount: r.wordcount as number,
		})),
		suggestion: data.query?.searchinfo?.suggestion,
	};
}

async function getPageContent(title: string): Promise<PageData> {
	const params = new URLSearchParams({
		action: "parse",
		page: title,
		prop: "wikitext|sections",
		format: "json",
		formatversion: "2",
		origin: "*",
	});
	const res = await wikiFetch(`${WIKI_API}?${params}`, {
		headers: WIKI_HEADERS,
	});
	if (!res.ok) throw new Error(`Page fetch failed: ${res.status}`);

	// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
	const data = (await res.json()) as any;
	if (data.error) throw new Error(data.error.info);
	if (!data.parse?.wikitext) throw new Error(`No content for page: ${title}`);

	// Resolve transcluded infoboxes (e.g. {{Infobox hafnium}}) before parsing
	const wikitext = await resolveTranscludedInfobox(data.parse.title, data.parse.wikitext);

	return {
		title: data.parse.title,
		wikitext,
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

// --- Transcluded infobox resolution ---
// Some articles (all chemical elements, some biology/geography) use {{Infobox X}}
// with no inline parameters — the data lives on a separate template page.
// We detect these and fetch the expanded HTML to extract key-value pairs.

const TRANSCLUDED_INFOBOX_RE = /\{\{\s*[Ii]nfobox\s+([^{}|]+?)\s*\}\}/;

function cleanInfoboxHtml(html: string): string {
	let t = html;
	// Strip category links before converting wikilinks
	t = t.replace(/\[\[Category:[^\]]*\]\]/gi, "");
	// Convert wikilinks: [[target|display]] → display, [[target]] → target
	t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
	t = t.replace(/\[\[([^\]]*)\]\]/g, "$1");
	// Convert <br> to separator, then strip remaining HTML tags
	t = t.replace(/<br\s*\/?>/gi, ", ");
	t = t.replace(/<[^>]*>/g, "");
	// Decode common HTML entities
	t = decodeHtmlEntities(t);
	// Strip leftover image/file wikitext syntax from expanded templates
	t = t.replace(/frameless\|[^|]*(\|[^|]*)*/g, "");
	// Collapse whitespace
	t = collapseWhitespace(t);
	return t;
}

function parseInfoboxHtml(html: string): Array<{ key: string; value: string }> {
	const pairs: Array<{ key: string; value: string }> = [];
	const re =
		/<th[^>]*class="infobox-label"[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*class="infobox-data"[^>]*>([\s\S]*?)<\/td>/gi;
	for (let m = re.exec(html); m !== null; m = re.exec(html)) {
		const key = cleanInfoboxHtml(m[1]!);
		const value = cleanInfoboxHtml(m[2]!);
		if (!key || !value || value.length < 2) continue;
		if (/\.(jpg|jpeg|png|svg|gif|webp)$/i.test(value)) continue;
		pairs.push({ key, value });
	}
	return pairs;
}

/**
 * Detect transcluded infoboxes ({{Infobox X}} with no parameters) in the raw
 * wikitext and replace them with extracted key-value plain text by fetching
 * the expanded HTML from the API.
 */
async function resolveTranscludedInfobox(pageTitle: string, wikitext: string): Promise<string> {
	const match = TRANSCLUDED_INFOBOX_RE.exec(wikitext);
	if (!match) return wikitext;
	try {
		const params = new URLSearchParams({
			action: "expandtemplates",
			title: pageTitle,
			text: match[0],
			prop: "wikitext",
			format: "json",
			formatversion: "2",
			origin: "*",
		});
		const res = await wikiFetch(`${WIKI_API}?${params}`, {
			headers: WIKI_HEADERS,
		});
		if (!res.ok) return wikitext;
		// biome-ignore lint/suspicious/noExplicitAny: Wikipedia API response
		const data = (await res.json()) as any;
		const html: string | undefined = data?.expandtemplates?.wikitext;
		if (!html) return wikitext;
		const pairs = parseInfoboxHtml(html);
		if (pairs.length === 0) return wikitext;
		const lines = pairs.map((p) => `${p.key}: ${p.value}`);
		return wikitext.replace(match[0], `\n${lines.join("\n")}\n`);
	} catch {
		return wikitext;
	}
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
			/size|caption|alt|_map|file|name|class/i.test(keyNorm)
		) {
			continue;
		}
		// Skip CSS/layout class attributes
		if (/_class[LR]?$/i.test(keyNorm) || /^(body|above|header|label|data)_?class/i.test(keyNorm)) {
			continue;
		}
		// Skip comment/footnote fields
		if (/_comment$/i.test(keyNorm) || /_footnote$/i.test(keyNorm)) continue;
		// Skip database identifiers and chemical notation
		if (
			/^(pubchem|drugbank|chemspider(id)?|chembl|chebi|unii|kegg\d?|pdb.?ligand|iuphar.?ligand|medlineplus|dailymedid|cas.?number|stdinchi(key)?|smiles)$/i.test(
				keyNorm,
			)
		) {
			continue;
		}
		// Skip ATC classification codes
		if (/^atc_(prefix|suffix)/i.test(keyNorm)) continue;
		// Skip bare chemical formula components (single uppercase letter = element)
		if (/^[A-Z]$/.test(rawKey.trim())) continue;
		// Skip formatting/layout hints
		if (/^(colspan|rowspan|group)/i.test(keyNorm)) continue;
		// Skip meta/entry-label and demographics layout keys
		if (/[_ ]entry$/i.test(keyNorm)) continue;
		if (/^(demographics|blank[_ ]?(name|info))[_ ]?(sec|title|info)?/i.test(keyNorm)) continue;
		// Skip military infobox layout keys
		if (/^(campaignbox|combatant)\d*$/i.test(keyNorm)) continue;

		// Clean the value
		let val = rawValue;

		// Run preserveNumericTemplates on the value to convert {{convert}}, {{coord}}, etc.
		val = preserveNumericTemplates(val);

		// Strip remaining nested templates ({{ ... }}) from the value
		val = stripNestedBracesSimple(val);

		// Strip <ref>...</ref> and <ref ... />
		val = val.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
		val = val.replace(/<ref[^>]*\/>/gi, "");

		// Convert <br> to separator before stripping all tags
		val = val.replace(/<br\s*\/?>/gi, ", ");
		// Strip remaining HTML tags but keep content
		val = val.replace(/<\/?[a-z][^>]*\/?>/gi, "");
		// Decode common HTML entities
		val = val.replace(/&nbsp;/g, " ");
		val = val.replace(/&amp;/g, "&");
		val = val.replace(/&lt;/g, "<");
		val = val.replace(/&gt;/g, ">");
		val = val.replace(/&quot;/g, '"');
		val = val.replace(/&#\d+;/g, "");
		val = val.replace(/&#x[\da-fA-F]+;/g, "");

		// Convert wikilinks: [[target|display]] → display, [[target]] → target
		val = val.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
		val = val.replace(/\[\[([^\]]*)\]\]/g, "$1");

		// Strip external links: [http://... display] → display
		val = val.replace(/\[https?:\/\/[^\s\]]*\s+([^\]]+)\]/g, "$1");
		val = val.replace(/\[https?:\/\/[^\s\]]*\]/g, "");

		// Truncate at raw template syntax that leaked through (e.g. "| casualties1 = ")
		val = val.replace(/\s*\|\s*\w+\s*=[\s\S]*$/, "");
		// Strip leftover image/file wikitext syntax
		val = val.replace(/frameless\|[^|]*(\|[^|]*)*/g, "");
		// Strip ref tags at end of value: [MSR], [b92], [wiki] etc.
		// Runs after template truncation so refs are now at the end.
		// Only strips trailing refs to preserve notation like [Xe] in electron configs.
		val = val.replace(/(\s*\[[^[\]]{1,50}\])+\s*$/g, "");
		// Clean up excess whitespace
		val = collapseWhitespace(val);
		// Trim leading punctuation (from stripped templates)
		val = val.replace(/^[,;:\s]+/, "");

		// Skip if value is empty or just punctuation/whitespace after cleaning
		if (!val || /^[\s.,;:\-–—]*$/.test(val)) continue;
		// Skip uninformative placeholder values
		if (/^(none|n\/a|unknown|yes|no|see|\?)$/i.test(val)) continue;
		// Skip values that are just reference tags or brackets
		if (/^\[.*\]$/.test(val) && val.length < 30) continue;

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
	let k = key.replaceAll("_", " ").trim();
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

/** Take the first N words of `text`; append "…" if any were dropped. */
function firstWordsWithEllipsis(text: string, n: number): string {
	const words = text.split(/\s+/);
	const head = words.slice(0, n).join(" ");
	return words.length > n ? `${head}…` : head;
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
		return `[${firstWordsWithEllipsis(titleMatch[1].trim(), 3)}]`;
	}
	// Plain text ref (not a template): take first few words
	const plain = body
		.replace(/\{\{[^}]*\}\}/g, "")
		.replace(/<[^>]*>/g, "")
		.trim();
	if (plain.length > 0) {
		const abbrev = firstWordsWithEllipsis(plain, 3);
		if (abbrev.length > 2) return `[${abbrev}]`;
	}
	// Nothing useful — strip entirely
	return "";
}

/** Clean LaTeX math content into readable plain text. */
function cleanMathContent(latex: string): string {
	let t = latex;
	// Extract text from \text{...}, \mathrm{...}, \operatorname{...}, etc.
	t = t.replace(
		/\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g,
		"$1",
	);
	// Common named functions: \log → "log", \sin → "sin", etc.
	t = t.replace(/\\(log|ln|sin|cos|tan|max|min|lim|sup|inf|det|gcd|lg|exp|Pr)\b/g, "$1");
	// Modular arithmetic
	t = t.replace(/\\(?:p?mod|bmod)\b/g, "mod");
	// Common operators/symbols
	t = t.replace(/\\cdot\b/g, "*");
	t = t.replace(/\\times\b/g, "x");
	t = t.replace(/\\pm\b/g, "+/-");
	t = t.replace(/\\leq?\b/g, "<=");
	t = t.replace(/\\geq?\b/g, ">=");
	t = t.replace(/\\neq?\b/g, "!=");
	t = t.replace(/\\approx\b/g, "~");
	t = t.replace(/\\infty\b/g, "infinity");
	t = t.replace(/\\[lc]dots\b/g, "...");
	// Block commands: \begin{...}, \end{...}, spacing/sizing commands
	t = t.replace(/\\(?:begin|end)\{[^}]*\}/g, " ");
	t = t.replace(/\\(?:frac|dfrac|tfrac|sqrt|overline|underline|hat|bar|vec|tilde)\b/g, " ");
	t = t.replace(/\\(?:sum|prod|int|iint|iiint|oint|bigcup|bigcap|bigoplus)\b/g, " ");
	t = t.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|textstyle)\b/g, "");
	// Remaining \commands and \symbols
	t = t.replace(/\\[a-zA-Z]+/g, " ");
	t = t.replace(/\\./g, "");
	// All remaining { } (LaTeX grouping — safe to strip now)
	t = t.replace(/[{}]/g, "");
	// Cleanup
	t = t.replace(/\s+/g, " ").trim();
	if (!/[a-zA-Z0-9]/.test(t)) return "";
	return t;
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
	// Strip <math> tags before template processing — LaTeX uses {{ }}
	// which would confuse the brace counter in stripNestedBraces.
	// Extract readable text; strip LaTeX noise.
	t = t.replace(/<math[^>]*>([\s\S]*?)<\/math>/gi, (_m, body: string) => {
		const cleaned = cleanMathContent(body);
		return cleaned ? ` ${cleaned} ` : "";
	});
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
	// Convert <br> to newline before stripping remaining HTML
	t = t.replace(/<br\s*\/?>/gi, "\n");
	// HTML tags (keep content)
	t = t.replace(/<\/?[a-z][^>]*\/?>/gi, "");
	// Decode HTML entities that survive from template expansion
	t = decodeHtmlEntities(t);
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

function extractSection(wikitext: string, name: string, query?: string, cap = SECTION_CAP): string {
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
	if (full.length <= cap) return full;

	// Select complete sentences/paragraphs from the center of the section
	const headingEnd = full.indexOf("\n");
	const heading = headingEnd >= 0 ? `${full.slice(0, headingEnd + 1)}` : "";
	const body = headingEnd >= 0 ? full.slice(headingEnd + 1) : full;
	const bodyBudget = cap - heading.length;
	if (body.length <= bodyBudget) return full;

	const chunks = splitChunks(body);
	if (chunks.length === 0) return heading;

	// Query-aware anchor: prefer chunks containing discriminating query terms
	// (terms in query but NOT in the section name).
	let startIdx = -1;
	if (query) {
		const sectionWords = new Set(
			normalizeDashes(name)
				.toLowerCase()
				.split(/[\s-]+/)
				.filter((w) => w.length > 1),
		);
		const terms = normalizeDashes(query)
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 1 && !sectionWords.has(w));
		if (terms.length > 0) {
			let bestScore = 0;
			for (let i = 0; i < chunks.length; i++) {
				const lower = chunks[i]!.toLowerCase();
				let score = 0;
				for (const term of terms) {
					if (lower.includes(term)) score++;
				}
				if (score > bestScore) {
					bestScore = score;
					startIdx = i;
				}
			}
		}
	}

	// Fall back to center of section when no query match
	if (startIdx < 0) {
		let offset = 0;
		const offsets: number[] = [];
		for (const c of chunks) {
			offsets.push(offset + c.length / 2);
			offset += c.length;
		}
		const bodyMid = body.length / 2;
		startIdx = 0;
		let bestDist = Infinity;
		for (let i = 0; i < offsets.length; i++) {
			const dist = Math.abs((offsets[i] ?? 0) - bodyMid);
			if (dist < bestDist) {
				bestDist = dist;
				startIdx = i;
			}
		}
	}

	// Expand outward from startIdx, alternating before/after, adding whole chunks
	const selected = new Set<number>([startIdx]);
	let used = chunks[startIdx]?.length ?? 0;
	let lo = startIdx - 1;
	let hi = startIdx + 1;
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
	// From query words that match section names.
	// Normalize dashes so "Miller-Rabin" (hyphen) matches "Miller–Rabin" (en-dash).
	const titleWords = new Set(normalizeDashes(title).toLowerCase().split(/\s+/));
	const extras = normalizeDashes(query)
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => !titleWords.has(w) && w.length > 2);
	if (extras.length > 0) {
		for (const s of sections) {
			const lower = normalizeDashes(s.name).toLowerCase();
			for (const w of extras) {
				if (lower.includes(w)) found.add(s.name);
			}
		}
	}

	// Drop ancestor sections whose byte range strictly contains a selected
	// descendant. extractSection terminates at the next same-or-lower-level
	// heading, so a level-2 parent's extract already includes its level-3
	// children — emitting both parent and child duplicates the children.
	// Prefer the descendant: its match is the more specific signal.
	const ranges: { name: string; start: number; end: number }[] = [];
	const seenForRange = new Set<string>();
	for (let i = 0; i < sections.length; i++) {
		const s = sections[i]!;
		if (!found.has(s.name) || seenForRange.has(s.name)) continue;
		seenForRange.add(s.name);
		let end = Number.POSITIVE_INFINITY;
		for (let j = i + 1; j < sections.length; j++) {
			if (sections[j]!.level <= s.level) {
				end = sections[j]!.byteoffset;
				break;
			}
		}
		ranges.push({ name: s.name, start: s.byteoffset, end });
	}
	const dropped = new Set<string>();
	for (const r of ranges) {
		for (const other of ranges) {
			if (other === r) continue;
			if (other.start > r.start && other.end <= r.end) {
				dropped.add(r.name);
				break;
			}
		}
	}
	return [...found].filter((n) => !dropped.has(n));
}

// --- XML helpers ---

function x(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
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
export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const chunks = splitChunks(text);
	let result = "";
	for (const chunk of chunks) {
		const sep = result.length > 0 ? "\n\n" : "";
		if (result.length + sep.length + chunk.length + 14 > limit) break;
		result += sep + chunk;
	}
	// If we couldn't fit even one chunk, take as much of the first as possible.
	// Prefer a sentence-ending boundary so the visible output never trails off
	// mid-sentence; fall back to a word boundary only when no sentence ends in
	// the window, and to the raw slice as a last resort.
	if (!result && chunks[0]) {
		const c = chunks[0].slice(0, limit - 14);
		const lastSentence = Math.max(c.lastIndexOf(". "), c.lastIndexOf("! "), c.lastIndexOf("? "));
		if (lastSentence > 0) {
			result = c.slice(0, lastSentence + 1);
		} else {
			const lastSpace = c.lastIndexOf(" ");
			result = lastSpace > 0 ? c.slice(0, lastSpace) : c;
		}
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
	return collapseWhitespace(s).toLowerCase();
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
	let anyDedupable = false;
	for (const chunk of splitChunks(text)) {
		if (!isDedupable(chunk)) continue;
		anyDedupable = true;
		if (!set.has(normalizeChunk(chunk))) return true;
	}
	// If no chunks are long enough to dedup, treat any non-empty text as novel
	// so first-time content is never suppressed.
	if (!anyDedupable) return text.trim().length > 0;
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
	let anyDedupable = false;
	for (const chunk of chunks) {
		if (!isDedupable(chunk)) {
			novel.push(chunk);
			continue;
		}
		anyDedupable = true;
		if (!set.has(normalizeChunk(chunk))) {
			novel.push(chunk);
			hasNovel = true;
		}
	}
	// If no chunks are long enough to dedup, treat any content as novel
	if (!anyDedupable && novel.length > 0) hasNovel = true;
	return { filtered: novel.join("\n\n"), hasNovel };
}

const MAX_PAGE_CACHE = 50;

/** Fetch page content, using the SeenContent page cache when available. */
async function getPageContentCached(title: string, seen?: SeenContent): Promise<PageData> {
	if (seen) {
		const cached = seen.pageCache.get(title);
		if (cached) return cached;
	}
	const page = await getPageContent(title);
	if (seen) {
		// Evict oldest entry when cache is full (Map preserves insertion order)
		if (seen.pageCache.size >= MAX_PAGE_CACHE) {
			const oldest = seen.pageCache.keys().next().value;
			if (oldest !== undefined) seen.pageCache.delete(oldest);
		}
		seen.pageCache.set(title, page);
	}
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
				return { hits: [], suggestion: undefined };
			}),
		]);

		if (title) return await articleResult(query, title, search, seen);
		if (errors.length > 0 && search.hits.length === 0) {
			return `<error query="${x(query)}">${x(errors.join("; "))}</error>`;
		}
		// If the top search hit matched a specific section, the search engine
		// is telling us the query targets one article — promote to single-article
		// mode so it gets the full budget instead of 1/3 in multi-result mode.
		const topHit = search.hits[0];
		if (topHit?.sectionTitle) {
			const promoted: TitleResult = {
				title: topHit.title,
				redirectFrom: undefined,
				type: "standard",
			};
			return await articleResult(query, promoted, search, seen);
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

	// Targeted query: extras words matched specific sections → focus on those.
	// Whole-article query: all query words match the title → spread budget across
	// all sections so later ones (Pseudocode, Algorithm, etc.) aren't lost.
	const titleWords = new Set(normalizeDashes(title.title).toLowerCase().split(/\s+/));
	const wholeArticle = normalizeDashes(query)
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2)
		.every((w) => titleWords.has(w));

	let body = "";
	if (!wholeArticle && relevant.length > 0) {
		// Targeted: extract detected sections at full cap
		const sections = relevant
			.map((n) => extractSection(content, n, query))
			.filter(Boolean)
			.join("\n\n");

		const sectionBudget = Math.min(sections.length, Math.floor(CHAR_LIMIT * 0.7));
		const introBudget = Math.floor(CHAR_LIMIT * 0.6) - sectionBudget;
		const trimmedIntro = introBudget > 100 ? trimIntro(intro, introBudget) : "";
		body = trimmedIntro ? `${trimmedIntro}\n\n${sections}` : sections;
	}
	if (!body && leaves.length > 0) {
		// Whole-article or no sections detected: generous intro (Wikipedia's
		// lead contains the most important summary facts), then ALL sections
		// at adaptive per-section cap so later ones aren't lost.
		const introBudget = Math.min(intro.length, Math.floor(CHAR_LIMIT * 0.4));
		const trimmedIntro = introBudget > 100 ? trimIntro(intro, introBudget) : "";
		const sectionBudget = Math.floor(CHAR_LIMIT * 0.7) - (trimmedIntro?.length ?? 0);
		const perCap = Math.max(200, Math.floor(sectionBudget / leaves.length));

		const sections = leaves
			.map((n) => extractSection(content, n, undefined, perCap))
			.filter(Boolean)
			.join("\n\n");
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
	xml += `<content>\n${finalBody}\n</content>\n`;
	xml += "</article>\n";

	if (isStub && search.hits.length > 1) {
		const remain = CHAR_LIMIT - xml.length - 20;
		if (remain > 100) xml += searchSnippets(search, remain, new Set([title.title]));
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

	let xml = `<result query="${x(query)}"`;
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

		// Weight budget by rank: top result gets the lion's share,
		// respecting the search engine's relevance ordering.
		const RANK_WEIGHTS = [0.6, 0.25, 0.15];
		const weight = RANK_WEIGHTS[novelRendered] ?? 0.15;
		const perResultBudget = Math.floor(remaining * weight);
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
		xml += `${tag}${secList}<content>\n${finalBody}\n</content>\n${closeTag}`;

		if (seen) markContentSeen(finalBody, hit.title, seen);
		novelRendered++;
		remaining = CHAR_LIMIT - xml.length - 20;
	}

	// Append title+snippet one-liners for remaining hits so the agent
	// knows what else exists and can make informed follow-up queries.
	remaining = CHAR_LIMIT - xml.length - 20;
	if (remaining > 100 && search.hits.length > top.length) {
		const renderedTitles = new Set(top.map((h) => h.title));
		xml += searchSnippets(search, remaining, renderedTitles);
	}

	xml += "</result>";
	return xml;
}

function searchSnippets(search: SearchResponse, budget: number, exclude?: Set<string>): string {
	let xml = "<also_found>\n";
	for (const h of search.hits) {
		if (exclude?.has(h.title)) continue;
		const entry = `<hit title="${x(h.title)}" section="${x(h.sectionTitle)}">${x(h.snippet)}</hit>\n`;
		if (xml.length + entry.length + 15 > budget) break;
		xml += entry;
	}
	xml += "</also_found>\n";
	return xml;
}
