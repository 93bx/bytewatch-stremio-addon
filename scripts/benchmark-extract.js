/**
 * Measures extract pipeline or raw extractor wall time.
 * Usage (from repo root):
 *   node scripts/benchmark-extract.js
 *   ITERATIONS=3 BENCH_COLD_EACH=1 node scripts/benchmark-extract.js
 *   MODE=extractor TMDB_ID=27205 node scripts/benchmark-extract.js
 */
const { performance } = require("node:perf_hooks");
const path = require("path");

const root = path.join(__dirname, "..");
const {
  extractAllStreams,
  flushStreamCachesForBenchmark,
} = require(path.join(root, "index.js"));
const runExtractor = require(path.join(root, "unified-extractor.js"));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runPipelineBench() {
  const imdbId = process.env.BENCH_IMDB || "tt1375666";
  const type = (process.env.BENCH_TYPE || "movie").toLowerCase();
  const iterations = Math.max(1, Number(process.env.ITERATIONS || 3));
  const coldEach = process.env.BENCH_COLD_EACH === "1";
  const args = { type, imdbId, tmdbRes: null };
  if (type === "series") {
    args.season = process.env.BENCH_SEASON || "1";
    args.episode = process.env.BENCH_EPISODE || "1";
  }
  const times = [];
  for (let i = 0; i < iterations; i += 1) {
    if (coldEach) flushStreamCachesForBenchmark();
    const t0 = performance.now();
    await extractAllStreams(args);
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    mode: "pipeline",
    imdbId,
    type,
    iterations,
    coldEach,
    p50Ms: Math.round(sorted[Math.floor((sorted.length - 1) / 2)]),
    p90Ms: Math.round(percentile(sorted, 90)),
    runsMs: times.map((t) => Math.round(t)),
    note: coldEach
      ? "BENCH_COLD_EACH=1 flushes stream cache each iteration (full extraction every run)."
      : "Later iterations use streamCache + tmdbFindCache (expect faster times).",
  };
}

async function runExtractorBench() {
  const tmdbId = Number(process.env.TMDB_ID || 27205);
  const type = (process.env.BENCH_TYPE || "movie").toLowerCase();
  const season = process.env.BENCH_SEASON != null ? process.env.BENCH_SEASON : null;
  const episode = process.env.BENCH_EPISODE != null ? process.env.BENCH_EPISODE : null;
  const iterations = Math.max(1, Number(process.env.ITERATIONS || 2));
  const source = process.env.BENCH_SOURCE || "cineby";
  const times = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await runExtractor(source, type, tmdbId, season, episode);
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const poolOn = process.env.BROWSER_POOL !== "0";
  const warmGain =
    iterations >= 2 && times[0] > 0
      ? Math.round(times[0] - times[times.length - 1])
      : null;
  return {
    mode: "extractor",
    source,
    tmdbId,
    type,
    iterations,
    browserPool: poolOn,
    poolConcurrency: process.env.POOL_CONCURRENCY || "(default 2)",
    verifyMode: process.env.VERIFY_MODE || "fast",
    p50Ms: Math.round(sorted[Math.floor((sorted.length - 1) / 2)]),
    p90Ms: Math.round(percentile(sorted, 90)),
    runsMs: times.map((t) => Math.round(t)),
    note: poolOn
      ? "With BROWSER_POOL on, run1 pays cold connect; later runs reuse browser (compare runsMs[0] vs last)."
      : "BROWSER_POOL=0 uses one-off browser per extraction (slower, easier to debug).",
    warmGainMs: warmGain,
  };
}

async function main() {
  const mode = (process.env.MODE || "pipeline").toLowerCase();
  const summary = mode === "extractor" ? await runExtractorBench() : await runPipelineBench();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
