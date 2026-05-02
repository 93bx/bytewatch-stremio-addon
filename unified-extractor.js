const { connect } = require("puppeteer-real-browser");
const axios = require("axios");
const https = require("https");
const { performance } = require("node:perf_hooks");
const logger = require("./logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const MANIFEST_MAX_BYTES = 98304;
const VERIFY_CONCURRENCY = 3;

function streamTimingEnabled() {
  return process.env.STREAM_TIMING === "1";
}

function logExtractorTiming(label, startedAt) {
  if (!streamTimingEnabled()) return;
  logger.info(`timing extractor.${label}=${(performance.now() - startedAt).toFixed(1)}ms`);
}

function getRetryDelays() {
  const mode = (process.env.EXTRACTOR_RETRIES || "fast").toLowerCase();
  if (mode === "aggressive") return [0, 1500, 3000];
  if (mode === "medium") return [0, 1500];
  return [0];
}

async function mapWithConcurrency(items, limit, fn) {
  if (!items.length) return;
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** After navigation: wait for first media hit with debounce, or bounded spin if none yet. */
async function waitForInitialMediaHits(hits, { debounceMs, maxInitialWaitMs, pollMs }) {
  const deadline = Date.now() + maxInitialWaitMs;
  while (Date.now() < deadline) {
    if (hits.length > 0) {
      await sleep(debounceMs);
      return;
    }
    await sleep(pollMs);
  }
}

const blockedMarkers = [
  "analytics",
  "ads",
  "social",
  "disable-devtool",
  "cloudflareinsights",
  "pixel.embed",
  "histats",
  "dtscout",
];

const sourceUrlBuilders = {
  cineby: (type, id, season, episode) =>
    type === "movie"
      ? `https://www.cineby.sc/movie/${id}`
      : `https://www.cineby.sc/tv/${id}/${season}/${episode}`,
  vidking: (type, id, season, episode) =>
    type === "movie"
      ? `https://www.vidking.net/embed/movie/${id}`
      : `https://www.vidking.net/embed/tv/${id}/${season}/${episode}`,
};

function randomUserAgent() {
  const versions = ["127.0.0.0", "126.0.0.0", "125.0.0.0"];
  const version = versions[Math.floor(Math.random() * versions.length)];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function looksLikeMedia(url) {
  return (
    url.includes(".m3u8") ||
    url.includes(".mp4") ||
    url.includes(".ts") ||
    url.includes("/master") ||
    url.includes("/playlist")
  );
}

function buildProxyHeaders(rawHeaders = {}, source) {
  return {
    Referer:
      rawHeaders.referer ||
      `https://${source === "cineby" ? "www.cineby.sc" : source === "vidking" ? "www.vidking.net" : "vsembed.ru"}/`,
    Origin:
      rawHeaders.origin ||
      `https://${source === "cineby" ? "www.cineby.sc" : source === "vidking" ? "www.vidking.net" : "vsembed.ru"}`,
    "User-Agent": rawHeaders["user-agent"] || randomUserAgent(),
    "Accept-Language": rawHeaders["accept-language"] || "en-US,en;q=0.9",
  };
}

async function verifyCandidate(url, headers) {
  const replayHeaders = {
    "user-agent": headers["User-Agent"] || headers["user-agent"],
    referer: headers.Referer || headers.referer,
    origin: headers.Origin || headers.origin,
    "accept-language": headers["Accept-Language"] || headers["accept-language"] || "en-US,en;q=0.9",
    accept: "*/*",
  };

  const manifestOpts = {
    timeout: 12000,
    validateStatus: () => true,
    responseType: "text",
    httpsAgent: insecureAgent,
    maxContentLength: MANIFEST_MAX_BYTES,
    maxBodyLength: MANIFEST_MAX_BYTES,
  };

  const [plain, replay] = await Promise.all([
    axios.get(url, manifestOpts),
    axios.get(url, { ...manifestOpts, headers: replayHeaders }),
  ]);

  let manifestOk = false;
  let segmentStatus = null;
  if (replay.status === 200 && url.includes(".m3u8")) {
    manifestOk = String(replay.data).includes("#EXTM3U");
    const firstSegment = String(replay.data)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    if (firstSegment) {
      const segmentUrl = new URL(firstSegment, url).toString();
      const segmentRes = await axios.get(segmentUrl, {
        timeout: 12000,
        validateStatus: () => true,
        responseType: "arraybuffer",
        headers: { ...replayHeaders, Range: "bytes=0-1023" },
        httpsAgent: insecureAgent,
      });
      segmentStatus = segmentRes.status;
    }
  }

  return {
    plainStatus: plain.status,
    replayStatus: replay.status,
    manifestOk,
    segmentStatus,
  };
}

function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.url.includes(".m3u8")) score += 35;
  else if (candidate.url.includes(".mp4")) score += 20;

  if (candidate.verification.replayStatus === 200) score += 25;
  if (candidate.verification.manifestOk) score += 20;
  if (candidate.verification.segmentStatus === 206 || candidate.verification.segmentStatus === 200) score += 15;
  if (candidate.verification.plainStatus >= 400 && candidate.verification.replayStatus === 200) score += 5;
  if (blockedMarkers.some((marker) => candidate.url.includes(marker))) score -= 50;

  return Math.max(0, Math.min(100, score));
}

function bestCandidate(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  return sorted[0];
}

async function runSourceExtraction(source, type, id, season, episode) {
  const playerUrl = sourceUrlBuilders[source](type, id, season, episode);
  const hits = [];
  const ua = randomUserAgent();

  const tConnect = performance.now();
  const { browser, page } = await connect({
    headless: true,
    turnstile: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--enable-popup-blocking",
    ],
    customConfig: {},
    connectOption: {},
    disableXvfb: false,
    ignoreAllFlags: false,
  });
  logExtractorTiming(`${source}.connect`, tConnect);

  try {
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
      DNT: "1",
      "Sec-GPC": "1",
      "Accept-Language": "en-US,en;q=0.9",
    });
    await page.setRequestInterception(true);
    await page.evaluateOnNewDocument(() => {
      window.open = () => null;
    });
    page.on("dialog", async (dialog) => {
      await dialog.accept();
    });

    page.on("request", async (request) => {
      const reqUrl = request.url();
      if (blockedMarkers.some((marker) => reqUrl.includes(marker))) {
        await request.abort();
        return;
      }
      if (looksLikeMedia(reqUrl)) {
        hits.push({
          source,
          playerUrl,
          url: reqUrl,
          requestHeaders: buildProxyHeaders(request.headers(), source),
          verification: { plainStatus: null, replayStatus: null, manifestOk: false, segmentStatus: null },
          score: 0,
        });
      }
      await request.continue();
    });

    const tGoto = performance.now();
    await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    logExtractorTiming(`${source}.goto`, tGoto);

    if (source === "vsembed") {
      await sleep(2000);
      await page.mouse.click(960, 540);
      await sleep(2000);
      await page.mouse.click(960, 540);
      // Best effort deep attempt; may fail on rotating signatures.
      const iframeSrc = await page.evaluate(() => {
        const iframe = document.querySelector("iframe#player_iframe");
        return iframe ? iframe.src : null;
      }).catch(() => null);
      if (iframeSrc) {
        await page.goto(iframeSrc, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await sleep(1500);
      }
    } else {
      const tWaitHits = performance.now();
      await waitForInitialMediaHits(hits, {
        debounceMs: 400,
        maxInitialWaitMs: 2500,
        pollMs: 100,
      });
      logExtractorTiming(`${source}.wait_initial_hits`, tWaitHits);
    }

    const tPoll = performance.now();
    const start = Date.now();
    while (Date.now() - start < 20000 && hits.length === 0) {
      await sleep(500);
    }
    logExtractorTiming(`${source}.poll_empty_hits`, tPoll);

    const dedup = new Map();
    for (const hit of hits) {
      if (!dedup.has(hit.url)) dedup.set(hit.url, hit);
    }
    const candidates = Array.from(dedup.values()).filter((item) => item.url.includes(".m3u8") || item.url.includes(".mp4"));

    const tVerify = performance.now();
    await mapWithConcurrency(candidates, VERIFY_CONCURRENCY, async (candidate) => {
      try {
        candidate.verification = await verifyCandidate(candidate.url, candidate.requestHeaders);
      } catch (error) {
        candidate.verification = {
          plainStatus: null,
          replayStatus: null,
          manifestOk: false,
          segmentStatus: null,
          error: error.message,
        };
      }
      candidate.score = scoreCandidate(candidate);
    });
    logExtractorTiming(`${source}.verify_candidates n=${candidates.length}`, tVerify);

    return {
      source,
      playerUrl,
      candidates,
      bestCandidate: bestCandidate(candidates),
      error: null,
    };
  } catch (error) {
    return {
      source,
      playerUrl,
      candidates: [],
      bestCandidate: null,
      error: error.message,
    };
  } finally {
    await browser.close();
  }
}

async function runExtractor(source, type, id, season = null, episode = null) {
  if (!sourceUrlBuilders[source]) throw new Error(`Unknown source: ${source}`);

  const retries = getRetryDelays();
  let last = null;
  for (const retryDelay of retries) {
    if (retryDelay) await sleep(retryDelay);
    const result = await runSourceExtraction(source, type, id, season, episode);
    last = result;
    if (result.bestCandidate) {
      logger.info(`${source} best candidate score=${result.bestCandidate.score} url=${result.bestCandidate.url}`);
      return result;
    }
  }
  logger.warn(`${source} no candidate found, error=${last ? last.error : "unknown"}`);
  return last || { source, playerUrl: null, candidates: [], bestCandidate: null, error: "Extraction failed" };
}

module.exports = runExtractor;