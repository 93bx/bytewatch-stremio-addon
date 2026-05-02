const axios = require("axios");
const https = require("https");
const { performance } = require("node:perf_hooks");
const logger = require("./logger");
const { withPooledPage } = require("./browser-pool");

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

function getVerifyMode() {
  return (process.env.VERIFY_MODE || "fast").toLowerCase();
}

function getVerifyTimeoutMs() {
  const mode = getVerifyMode();
  if (mode === "strict") return Number(process.env.VERIFY_TIMEOUT_MS || 12000);
  if (mode === "balanced") return Number(process.env.VERIFY_TIMEOUT_MS || 8000);
  return Number(process.env.VERIFY_TIMEOUT_MS || 6000);
}

function getVerifyMaxCandidates() {
  const raw = process.env.VERIFY_MAX_CANDIDATES;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return getVerifyMode() === "strict" ? 50 : 2;
}

function getSettleMaxMs() {
  return Number(process.env.SETTLE_MAX_MS || 20000);
}

function getMediaStabilityMs() {
  return Number(process.env.MEDIA_STABILITY_MS || 150);
}

function getSettlePollMs() {
  return Math.min(50, Math.max(10, getMediaStabilityMs()));
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

/**
 * Wait until at least one distinct media URL exists and no new distinct URL for stabilityMs,
 * or until maxWaitMs (safety ceiling only).
 */
async function waitForMediaSettled(settleState, maxWaitMs, stabilityMs, pollMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (
      settleState.distinctCount > 0 &&
      Date.now() - settleState.lastDistinctAt >= stabilityMs
    ) {
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

const DEFAULT_EXTRA_BLOCK_SUBSTRINGS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "googleads.g.doubleclick.net",
  "facebook.net/tr",
  "scorecardresearch.com",
];

function parseEnvList(envVal, fallback) {
  if (!envVal || !String(envVal).trim()) return [...fallback];
  return String(envVal)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstPartyHostnames(playerUrl, source) {
  const hosts = new Set();
  try {
    const { hostname } = new URL(playerUrl);
    hosts.add(hostname);
    if (hostname.startsWith("www.")) {
      hosts.add(hostname.slice(4));
    } else {
      hosts.add(`www.${hostname}`);
    }
  } catch (_) {
    /* ignore */
  }
  if (source === "cineby") {
    hosts.add("www.cineby.sc");
    hosts.add("cineby.sc");
  }
  if (source === "vidking") {
    hosts.add("www.vidking.net");
    hosts.add("vidking.net");
  }
  return hosts;
}

function resourceTypesToBlock() {
  return new Set(
    parseEnvList(process.env.BLOCK_RESOURCE_TYPES, ["image", "font"]).map((s) =>
      s.toLowerCase()
    )
  );
}

function extraBlockSubstrings() {
  return parseEnvList(process.env.BLOCK_EXTRA_PATTERNS, DEFAULT_EXTRA_BLOCK_SUBSTRINGS);
}

function shouldBlockRequest(request, playerUrl, source, blockStats) {
  const reqUrl = request.url();
  if (looksLikeMedia(reqUrl)) return null;

  if (blockedMarkers.some((marker) => reqUrl.includes(marker))) {
    if (blockStats) blockStats.marker += 1;
    return "marker";
  }

  let hostname = "";
  try {
    hostname = new URL(reqUrl).hostname;
  } catch (_) {
    return null;
  }

  const firstParty = firstPartyHostnames(playerUrl, source);
  if (firstParty.has(hostname)) return null;

  const rt = request.resourceType();
  const typeSet = resourceTypesToBlock();
  if (typeSet.has(rt)) {
    if (blockStats) blockStats.byType[rt] = (blockStats.byType[rt] || 0) + 1;
    return `type:${rt}`;
  }

  for (const sub of extraBlockSubstrings()) {
    if (sub && reqUrl.includes(sub)) {
      if (blockStats) blockStats.pattern += 1;
      return `pattern:${sub}`;
    }
  }

  return null;
}

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

async function verifyCandidate(url, headers, options) {
  const {
    includePlain = true,
    includeSegment = true,
    timeoutMs = 12000,
  } = options;

  const replayHeaders = {
    "user-agent": headers["User-Agent"] || headers["user-agent"],
    referer: headers.Referer || headers.referer,
    origin: headers.Origin || headers.origin,
    "accept-language": headers["Accept-Language"] || headers["accept-language"] || "en-US,en;q=0.9",
    accept: "*/*",
  };

  const manifestOpts = {
    timeout: timeoutMs,
    validateStatus: () => true,
    responseType: "text",
    httpsAgent: insecureAgent,
    maxContentLength: MANIFEST_MAX_BYTES,
    maxBodyLength: MANIFEST_MAX_BYTES,
  };

  let plain = { status: null, data: "" };
  let replay;

  if (includePlain) {
    [plain, replay] = await Promise.all([
      axios.get(url, manifestOpts),
      axios.get(url, { ...manifestOpts, headers: replayHeaders }),
    ]);
  } else {
    replay = await axios.get(url, { ...manifestOpts, headers: replayHeaders });
  }

  let manifestOk = false;
  let segmentStatus = null;
  if (includeSegment && replay.status === 200 && url.includes(".m3u8")) {
    manifestOk = String(replay.data).includes("#EXTM3U");
    const firstSegment = String(replay.data)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    if (firstSegment) {
      const segmentUrl = new URL(firstSegment, url).toString();
      const segmentRes = await axios.get(segmentUrl, {
        timeout: timeoutMs,
        validateStatus: () => true,
        responseType: "arraybuffer",
        headers: { ...replayHeaders, Range: "bytes=0-1023" },
        httpsAgent: insecureAgent,
      });
      segmentStatus = segmentRes.status;
    }
  } else if (replay.status === 200 && url.includes(".m3u8")) {
    manifestOk = String(replay.data).includes("#EXTM3U");
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
  if (candidate.verification && candidate.verification.skipped) {
    if (candidate.url.includes(".m3u8")) score += 30;
    else if (candidate.url.includes(".mp4")) score += 15;
    return Math.max(0, Math.min(100, score));
  }

  if (candidate.url.includes(".m3u8")) score += 35;
  else if (candidate.url.includes(".mp4")) score += 20;

  if (candidate.verification.replayStatus === 200) score += 25;
  if (candidate.verification.manifestOk) score += 20;
  const seg = candidate.verification.segmentStatus;
  if (seg === 206 || seg === 200) score += 15;
  if (
    candidate.verification.plainStatus != null &&
    candidate.verification.plainStatus >= 400 &&
    candidate.verification.replayStatus === 200
  ) {
    score += 5;
  }
  if (blockedMarkers.some((marker) => candidate.url.includes(marker))) score -= 50;

  return Math.max(0, Math.min(100, score));
}

function rankCandidatesForVerification(list) {
  return [...list].sort((a, b) => {
    const am = a.url.includes(".m3u8") ? 1 : 0;
    const bm = b.url.includes(".m3u8") ? 1 : 0;
    if (bm !== am) return bm - am;
    return a.url.length - b.url.length;
  });
}

function bestCandidate(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  return sorted[0];
}

async function verifyCandidatesWithMode(candidates) {
  const mode = getVerifyMode();
  const timeoutMs = getVerifyTimeoutMs();
  const maxVerify = getVerifyMaxCandidates();
  const ranked = rankCandidatesForVerification(candidates);
  const verifyList = ranked.slice(0, maxVerify);
  const skipped = ranked.slice(maxVerify);

  for (const c of skipped) {
    c.verification = { skipped: true };
    c.score = scoreCandidate(c);
  }

  const includePlain = mode === "strict";
  await mapWithConcurrency(verifyList, VERIFY_CONCURRENCY, async (candidate, index) => {
    let includeSegment = mode === "strict";
    if (mode === "balanced") includeSegment = index === 0;
    if (mode === "fast") includeSegment = false;

    try {
      candidate.verification = await verifyCandidate(
        candidate.url,
        candidate.requestHeaders,
        { includePlain, includeSegment, timeoutMs }
      );
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
}

async function runSourceExtraction(source, type, id, season, episode) {
  const playerUrl = sourceUrlBuilders[source](type, id, season, episode);
  const hits = [];
  const ua = randomUserAgent();
  const settleState = {
    lastDistinctAt: Date.now(),
    distinctCount: 0,
    seen: new Set(),
  };

  const blockStats = streamTimingEnabled()
    ? { marker: 0, pattern: 0, byType: {} }
    : null;

  const tRun = performance.now();

  return withPooledPage(async (page) => {
    logExtractorTiming(`${source}.pool_page_ready`, tRun);

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
        const blockReason = shouldBlockRequest(request, playerUrl, source, blockStats);
        if (blockReason) {
          try {
            await request.abort();
          } catch (_) {
            /* ignore */
          }
          return;
        }
        if (looksLikeMedia(reqUrl)) {
          if (!settleState.seen.has(reqUrl)) {
            settleState.seen.add(reqUrl);
            settleState.distinctCount = settleState.seen.size;
            settleState.lastDistinctAt = Date.now();
          }
          hits.push({
            source,
            playerUrl,
            url: reqUrl,
            requestHeaders: buildProxyHeaders(request.headers(), source),
            verification: {
              plainStatus: null,
              replayStatus: null,
              manifestOk: false,
              segmentStatus: null,
            },
            score: 0,
          });
        }
        try {
          await request.continue();
        } catch (_) {
          /* ignore */
        }
      });

      const tGoto = performance.now();
      await page.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      logExtractorTiming(`${source}.goto`, tGoto);

      const tSettle = performance.now();
      await waitForMediaSettled(
        settleState,
        getSettleMaxMs(),
        getMediaStabilityMs(),
        getSettlePollMs()
      );
      logExtractorTiming(`${source}.media_settled`, tSettle);

      if (blockStats && streamTimingEnabled()) {
        logger.info(
          `timing extractor.${source}.block_stats marker=${blockStats.marker} pattern=${blockStats.pattern} byType=${JSON.stringify(blockStats.byType)}`
        );
      }

      const dedup = new Map();
      for (const hit of hits) {
        if (!dedup.has(hit.url)) dedup.set(hit.url, hit);
      }
      const candidates = Array.from(dedup.values()).filter(
        (item) => item.url.includes(".m3u8") || item.url.includes(".mp4")
      );

      const tVerify = performance.now();
      await verifyCandidatesWithMode(candidates);
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
    }
  });
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
      logger.info(
        `${source} best candidate score=${result.bestCandidate.score} url=${result.bestCandidate.url}`
      );
      return result;
    }
  }
  logger.warn(`${source} no candidate found, error=${last ? last.error : "unknown"}`);
  return (
    last || {
      source,
      playerUrl: null,
      candidates: [],
      bestCandidate: null,
      error: "Extraction failed",
    }
  );
}

module.exports = runExtractor;
