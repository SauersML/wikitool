export const TOOL_NAME = "search_wikipedia";

export const TOOL_DESCRIPTION =
	"Search English Wikipedia. Returns cleaned article wikitext with " +
	"[[wiki-style]] hyperlinks and abbreviated [citations]. " +
	"For specific topics: returns the matching article (full if short, relevant " +
	"sections if long) plus a complete section index. " +
	"For general queries: returns relevant excerpts across multiple articles. " +
	"Redirects are auto-followed with a note. Results are XML, max ~4000 chars. " +
	'Do NOT use "Page#Section" — section matching is automatic. ' +
	"To target a section in a long article, include the topic in your query " +
	'(e.g. "Hafnium chemical properties" not "Hafnium#Properties").';

export const QUERY_DESCRIPTION =
	'Search query. Article titles ("Albert Einstein"), topics ' +
	'("quantum entanglement"), or descriptive phrases ("largest earthquakes in Japan") ' +
	"all work. Include section-level terms for targeted results.";
