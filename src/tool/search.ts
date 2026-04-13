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

function parseWikitext(raw: string): string {
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
	// Templates
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

function leafSections(sections: PageSection[]): string[] {
	const leaves: string[] = [];
	for (const [i, current] of sections.entries()) {
		if (BOILERPLATE.has(current.name.toLowerCase())) continue;
		const next = sections[i + 1];
		if (!next || next.level <= current.level) {
			leaves.push(current.name);
		}
	}
	return leaves;
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
	if (query && query.toLowerCase().includes(name.toLowerCase())) return full;
	if (full.length <= SECTION_CAP) return full;

	// Center a window around the midpoint of the section body (after the heading)
	const headingEnd = full.indexOf("\n");
	const heading = headingEnd >= 0 ? full.slice(0, headingEnd + 1) : "";
	const body = headingEnd >= 0 ? full.slice(headingEnd + 1) : full;
	const bodyBudget = SECTION_CAP - heading.length;
	if (body.length <= bodyBudget) return full;

	const mid = Math.floor(body.length / 2);
	let winStart = Math.max(0, mid - Math.floor(bodyBudget / 2));
	let winEnd = Math.min(body.length, winStart + bodyBudget);
	// Adjust if we hit the end
	if (winEnd === body.length) winStart = Math.max(0, winEnd - bodyBudget);

	// Snap to line boundaries to avoid mid-line cuts
	if (winStart > 0) {
		const nl = body.indexOf("\n", winStart);
		if (nl >= 0 && nl < winStart + 80) winStart = nl + 1;
	}
	if (winEnd < body.length) {
		const nl = body.lastIndexOf("\n", winEnd);
		if (nl > winEnd - 80) winEnd = nl;
	}

	const prefix = winStart > 0 ? "[...]\n" : "";
	const suffix = winEnd < body.length ? "\n[...]" : "";
	return `${heading}${prefix}${body.slice(winStart, winEnd).trim()}${suffix}`;
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

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const region = text.slice(0, limit);
	// Prefer cutting at a section boundary (== header on its own line)
	const sectionBreak = region.lastIndexOf("\n==");
	if (sectionBreak > limit * 0.5) {
		return `${region.slice(0, sectionBreak)}\n[truncated]`;
	}
	// Next best: end of a sentence (. or .\n followed by space/newline)
	const sentenceEnd = region.search(/\.\s[^.]*$/);
	if (sentenceEnd > limit * 0.5) {
		return `${region.slice(0, sentenceEnd + 1)}\n[truncated]`;
	}
	// Fallback: last newline
	const newline = region.lastIndexOf("\n");
	if (newline > limit * 0.5) {
		return `${region.slice(0, newline)}\n[truncated]`;
	}
	return `${region}\n[truncated]`;
}

// --- Deduplication ---

export type SeenPages = Set<string>;

export function createSeenPages(): SeenPages {
	return new Set();
}

function alreadySeen(title: string, seen: SeenPages): boolean {
	return seen.has(title.toLowerCase());
}

function markSeen(title: string, seen: SeenPages): void {
	seen.add(title.toLowerCase());
}

// --- Main ---

export async function searchWikipedia(query: string, seen?: SeenPages): Promise<string> {
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
		// If the top search result's title words all appear in the query,
		// treat it as an article match with section targeting from the extra words.
		// e.g. "photosynthesis process plants" → article "Photosynthesis", detect sections for "process plants"
		const topHit = search.hits[0];
		if (topHit) {
			const titleWords = topHit.title.toLowerCase().split(/\s+/);
			const queryWords = query.toLowerCase().split(/\s+/);
			if (titleWords.every((tw) => queryWords.some((qw) => qw === tw))) {
				const implied: TitleResult = {
					title: topHit.title,
					redirectFrom: undefined,
					type: "standard",
				};
				return await articleResult(query, implied, search, seen);
			}
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
	seen?: SeenPages,
): Promise<string> {
	const page = await getPageContent(title.title);
	const content = parseWikitext(page.wikitext);
	const leaves = leafSections(page.sections);
	const isStub = content.length < 500;

	// If we already returned this article, return a compact reference
	if (seen && alreadySeen(title.title, seen)) {
		let xml = `<result query="${x(query)}">\n`;
		xml += `<article title="${x(title.title)}" already_returned="true">\n`;
		xml += `<sections>${leaves.map(x).join(" | ")}</sections>\n`;
		xml += "</article>\n</result>";
		return xml;
	}

	let xml = `<result query="${x(query)}">\n`;
	if (title.redirectFrom) {
		xml += `<redirect from="${x(title.redirectFrom)}" to="${x(title.title)}" />\n`;
	}
	xml += `<article title="${x(title.title)}"`;
	if (title.type !== "standard") xml += ` type="${x(title.type)}"`;
	xml += `>\n`;
	xml += `<sections>${leaves.map(x).join(" | ")}</sections>\n`;

	const close = "</article>\n</result>";
	const budget = CHAR_LIMIT - xml.length - close.length - 25;

	const relevant = detectSections(query, title.title, page.sections, search.hits);
	let body = "";
	if (relevant.length > 0) {
		body = relevant
			.map((n) => extractSection(content, n, query))
			.filter(Boolean)
			.join("\n\n");
	}
	if (!body) body = content;
	xml += `<content>${cdata(`\n${truncate(body, budget)}\n`)}</content>\n`;
	xml += "</article>\n";

	if (isStub && search.hits.length > 1) {
		const remain = CHAR_LIMIT - xml.length - 20;
		if (remain > 100) xml += searchSnippets(search, remain, title.title);
	}

	xml += "</result>";
	if (seen) markSeen(title.title, seen);
	return xml;
}

async function searchResults(query: string, search: SearchResponse, seen?: SeenPages): Promise<string> {
	if (search.hits.length === 0) {
		let xml = `<result query="${x(query)}"><no_results`;
		if (search.suggestion) xml += ` suggestion="${x(search.suggestion)}"`;
		return `${xml} /></result>`;
	}

	const top = search.hits.slice(0, 5);
	const pages = await Promise.all(top.map((h) => getPageContent(h.title).catch(() => null)));

	let xml = `<result query="${x(query)}" total="${search.totalHits}"`;
	if (search.suggestion) xml += ` suggestion="${x(search.suggestion)}"`;
	xml += ">\n";
	let remaining = CHAR_LIMIT - xml.length - 20;

	// Count unseen results for fair budget splitting
	const unseenCount = top.filter((h) => !seen || !alreadySeen(h.title, seen)).length;
	let unseenRendered = 0;

	for (let i = 0; i < top.length && remaining > 100; i++) {
		const hit = top[i];
		const page = pages[i];
		if (!page || !hit) continue;

		// Skip pages already returned in a prior call
		if (seen && alreadySeen(hit.title, seen)) {
			xml += `<page title="${x(hit.title)}" already_returned="true" />\n`;
			continue;
		}

		const parsed = parseWikitext(page.wikitext);
		const leaves = leafSections(page.sections);
		const secList = `<sections>${leaves.map(x).join(" | ")}</sections>\n`;

		let tag = `<page title="${x(hit.title)}"`;
		if (hit.sectionTitle) tag += ` section="${x(hit.sectionTitle)}"`;
		tag += ">\n";
		const closeTag = "</page>\n";
		const overhead = tag.length + secList.length + closeTag.length + 25;

		// Cap per-result budget so one result can't starve the rest
		const unseenLeft = unseenCount - unseenRendered;
		const perResultBudget = Math.floor(remaining / Math.max(unseenLeft, 1));
		const contentBudget = perResultBudget - overhead;

		if (contentBudget < 80) continue;

		if (parsed.length <= contentBudget) {
			xml += `${tag}${secList}<content>${cdata(`\n${parsed}\n`)}</content>\n${closeTag}`;
		} else {
			let body: string;
			if (i < 3) {
				// Always include lead section for top 3 results
				const lead = extractLead(parsed);
				const section = hit.sectionTitle ? extractSection(parsed, hit.sectionTitle, query) : "";
				if (section && section !== lead) {
					body = `${lead}\n\n${section}`;
				} else {
					body = lead || parsed;
				}
			} else {
				const section = hit.sectionTitle ? extractSection(parsed, hit.sectionTitle, query) : "";
				body = section || parsed;
			}
			xml += `${tag}${secList}<content>${cdata(`\n${truncate(body, contentBudget)}\n`)}</content>\n${closeTag}`;
		}
		if (seen) markSeen(hit.title, seen);
		unseenRendered++;
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
