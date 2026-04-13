// Latency eval for the Wikipedia search tool
// Measures round-trip time for Wikipedia API calls — no model calls.
// Usage: bun evals/latency.ts

const QUERIES = [
	"quantum computing",
	"Apollo 11 moon landing",
	"Marie Curie",
	"photosynthesis",
	"general relativity",
	"Roman Empire",
	"CRISPR gene editing",
	"black holes",
	"Fibonacci sequence",
	"Treaty of Versailles",
];

const SEARCH_URL = "https://en.wikipedia.org/w/api.php";

interface LatencyResult {
	query: string;
	searchMs: number;
	extractMs: number;
	totalMs: number;
	searchResults: number;
	extractChars: number;
	error?: string;
}

async function timeSearch(query: string): Promise<{ ms: number; titles: string[]; total: number }> {
	const url = `${SEARCH_URL}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&srprop=snippet&format=json&formatversion=2`;
	const start = performance.now();
	const res = await fetch(url);
	const data = (await res.json()) as any;
	const ms = performance.now() - start;
	const titles = (data.query?.search ?? []).map((r: any) => r.title);
	return { ms, titles, total: data.query?.searchinfo?.totalhits ?? 0 };
}

async function timeExtract(title: string): Promise<{ ms: number; chars: number }> {
	const url = `${SEARCH_URL}?action=query&titles=${encodeURIComponent(title)}&prop=extracts&explaintext=true&exintro=true&exchars=500&format=json&formatversion=2`;
	const start = performance.now();
	const res = await fetch(url);
	const data = (await res.json()) as any;
	const ms = performance.now() - start;
	const pages = data.query?.pages ?? [];
	const extract = pages[0]?.extract ?? "";
	return { ms, chars: extract.length };
}

async function evalQuery(query: string): Promise<LatencyResult> {
	try {
		const search = await timeSearch(query);
		if (search.titles.length === 0) {
			return {
				query,
				searchMs: search.ms,
				extractMs: 0,
				totalMs: search.ms,
				searchResults: 0,
				extractChars: 0,
				error: "no results",
			};
		}
		const extract = await timeExtract(search.titles[0]);
		return {
			query,
			searchMs: search.ms,
			extractMs: extract.ms,
			totalMs: search.ms + extract.ms,
			searchResults: search.total,
			extractChars: extract.chars,
		};
	} catch (e: any) {
		return {
			query,
			searchMs: 0,
			extractMs: 0,
			totalMs: 0,
			searchResults: 0,
			extractChars: 0,
			error: e.message,
		};
	}
}

function percentile(sorted: number[], p: number): number {
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
	return `${ms.toFixed(0)}ms`;
}

async function main() {
	console.log(`Wikipedia Search Tool — Latency Eval`);
	console.log(`Queries: ${QUERIES.length}`);
	console.log(`Each query: search API + extract API (sequential)\n`);

	// Run sequentially to avoid rate-limiting skew
	const results: LatencyResult[] = [];
	for (const query of QUERIES) {
		const result = await evalQuery(query);
		const status = result.error ? `ERROR: ${result.error}` : `${formatMs(result.totalMs)}`;
		console.log(`  ${query.padEnd(30)} ${status}`);
		results.push(result);
	}

	const successful = results.filter((r) => !r.error);
	if (successful.length === 0) {
		console.log("\nAll queries failed.");
		process.exit(1);
	}

	const searchTimes = successful.map((r) => r.searchMs).sort((a, b) => a - b);
	const extractTimes = successful.map((r) => r.extractMs).sort((a, b) => a - b);
	const totalTimes = successful.map((r) => r.totalMs).sort((a, b) => a - b);
	const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

	console.log(`\n${"─".repeat(50)}`);
	console.log(`Results (${successful.length}/${results.length} succeeded)\n`);

	const table = [
		["", "Search", "Extract", "Total"],
		["min", formatMs(searchTimes[0]), formatMs(extractTimes[0]), formatMs(totalTimes[0])],
		[
			"p50",
			formatMs(percentile(searchTimes, 50)),
			formatMs(percentile(extractTimes, 50)),
			formatMs(percentile(totalTimes, 50)),
		],
		[
			"p95",
			formatMs(percentile(searchTimes, 95)),
			formatMs(percentile(extractTimes, 95)),
			formatMs(percentile(totalTimes, 95)),
		],
		[
			"max",
			formatMs(searchTimes.at(-1)!),
			formatMs(extractTimes.at(-1)!),
			formatMs(totalTimes.at(-1)!),
		],
		["avg", formatMs(avg(searchTimes)), formatMs(avg(extractTimes)), formatMs(avg(totalTimes))],
	];

	for (const row of table) {
		console.log(
			`  ${row[0].padEnd(6)} ${row[1].padStart(10)} ${row[2].padStart(10)} ${row[3].padStart(10)}`,
		);
	}

	const errors = results.filter((r) => r.error);
	if (errors.length > 0) {
		console.log(`\nErrors:`);
		for (const r of errors) {
			console.log(`  ${r.query}: ${r.error}`);
		}
	}
}

main();
