const { addonBuilder }  = require('stremio-addon-sdk');
const NodeCache = require('node-cache');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const getRouter = require('stremio-addon-sdk/src/getRouter');
const { performance } = require('node:perf_hooks');
const logger = require('./logger');
const extractor = require('./unified-extractor');
const { prewarmPool } = require('./browser-pool');

const PORT = process.env.PORT || 7000;
// Short TTL: CDN tokens are session/IP-bound and expire quickly.
const PROTECTED_STREAM_CACHE_TTL = Number(process.env.STREAM_CACHE_TTL || 300);
const PER_PROVIDER_CAP = 2;
const insecureAgent = new https.Agent({ rejectUnauthorized: false });
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

const builder = new addonBuilder({
    id: 'org.bytetan.bytewatch',
    version: '1.0.0',
    name: 'ByteWatch',
    description: 'Get stream links for tv shows and movies',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    logo: 'https://www.bytetan.com/static/img/logo.png',
    idPrefixes: ['tt']
});

// Setup cache to reduce load (shorter TTL for protected session-bound links)
const streamCache = new NodeCache({ stdTTL: PROTECTED_STREAM_CACHE_TTL, checkperiod: 120 });
const proxySessionCache = new NodeCache({ stdTTL: PROTECTED_STREAM_CACHE_TTL, checkperiod: 120 });

const ALLOWED_EXTRACTOR_SOURCES = new Set(['vidcore', 'vidfast']);
const OMDB_API_KEY = process.env.OMDB_API_KEY || 'b1e4f11';

function streamTimingEnabled() {
    return process.env.STREAM_TIMING === '1';
}

function logStreamTiming(label, startedAt) {
    if (!streamTimingEnabled()) return;
    logger.info(`timing ${label}=${(performance.now() - startedAt).toFixed(1)}ms`);
}

function resolveExtractorSources() {
    const raw = (process.env.SOURCES || 'vidcore,vidfast').split(',').map((s) => s.trim()).filter(Boolean);
    const picked = raw.filter((s) => ALLOWED_EXTRACTOR_SOURCES.has(s));
    return picked.length ? picked : ['vidcore', 'vidfast'];
}

// Fetch movie/series metadata (used only for the stream description).
async function fetchOmdbDetails(imdbId){
  try {
    const response = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_API_KEY}`);
     if (response.data.Response === 'False') {
      throw new Error(response.data || 'Failed to fetch data from OMDB API');
     }
    return response.data;
  } catch (e) {
    console.log(`Error fetching metadata: ${e}`)
    return null
  }
}

function sourceLabel(source) {
    return source.charAt(0).toUpperCase() + source.slice(1);
}

function createProxyToken(candidate) {
    const token = crypto.randomUUID();
    proxySessionCache.set(token, {
        source: candidate.source,
        requestHeaders: candidate.requestHeaders || {}
    });
    return token;
}

function buildProxyUrl(token, targetUrl) {
    return `${PUBLIC_BASE_URL}/proxy/${token}?u=${encodeURIComponent(targetUrl)}`;
}

function mapCandidateToStream(candidate, description) {
    const token = createProxyToken(candidate);
    const serverSuffix = candidate.server ? ` · ${candidate.server}` : '';
    return {
        name: `${sourceLabel(candidate.source)}${serverSuffix} (${candidate.score})`,
        url: buildProxyUrl(token, candidate.url),
        description,
        behaviorHints: {
            notWebReady: true
        }
    };
}

function normalizeCached(cached) {
    if (!cached) return [];
    if (Array.isArray(cached)) return cached;
    return [];
}

// Main extraction function. vidcore/vidfast accept the IMDB id directly, so no
// TMDB resolution is needed. Providers run in parallel (one browser tab each),
// contribute up to PER_PROVIDER_CAP streams, and results are deduped by URL
// (both providers share the same CDN and can return identical links).
async function extractAllStreams({ type, imdbId, season, episode }) {
    const tExtractStart = performance.now();
    const sources = resolveExtractorSources();
    const settled = await Promise.allSettled(
        sources.map((source) => extractor(source, type, imdbId, season, episode))
    );

    const streams = [];
    const seenUrls = new Set();
    for (const result of settled) {
        if (result.status === 'rejected') {
            console.warn('❌ source extraction failed:', result.reason?.message);
            continue;
        }
        if (!result.value) continue;
        const candidates = Array.isArray(result.value.candidates) ? result.value.candidates : [];
        if (!candidates.length) {
            console.warn(`❌ ${result.value.source} extraction had no playable candidate: ${result.value.error || 'no candidate'}`);
            continue;
        }
        const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, PER_PROVIDER_CAP);
        for (const candidate of top) {
            if (seenUrls.has(candidate.url)) continue;
            seenUrls.add(candidate.url);
            streams.push(candidate);
        }
    }

    const sorted = streams.sort((a, b) => b.score - a.score);
    logStreamTiming(`extractAllStreams sources=${sources.join(',')}`, tExtractStart);
    return sorted;
}

function movieStreamDescription(metadata, imdbId) {
    if (metadata && metadata.Title) {
        return `${metadata.Title} (${metadata.Year || '?'})`;
    }
    return imdbId;
}

function seriesStreamDescription(metadata, imdbId, season, episode) {
    if (metadata && metadata.Title) {
        return `${metadata.Title} S${season}E${episode}`;
    }
    return `${imdbId} S${season}E${episode}`;
}

// Function to handle streams for movies
async function getMovieStreams(imdbId) {
    const cacheKey = `movie:${imdbId}`;
    const tHandler = performance.now();

    const cached = normalizeCached(streamCache.get(cacheKey));
    if (cached.length) {
        console.log(`Using cached stream for movie ${imdbId}`);
        const out = cached.map((candidate) => mapCandidateToStream(candidate, `${imdbId} (cached)`));
        logStreamTiming('getMovieStreams cache_hit', tHandler);
        return out;
    }

    const tMeta = performance.now();
    const metadata = await fetchOmdbDetails(imdbId);
    logStreamTiming('getMovieStreams meta', tMeta);

    const streams = await extractAllStreams({ type: 'movie', imdbId });
    streamCache.set(cacheKey, streams);

    const desc = movieStreamDescription(metadata, imdbId);
    logStreamTiming('getMovieStreams cache_miss_total', tHandler);
    return streams.map((candidate) => mapCandidateToStream(candidate, desc));
}

// Function to handle streams for TV series
async function getSeriesStreams(imdbId, season, episode) {
    const cacheKey = `series:${imdbId}:${season}:${episode}`;
    const tHandler = performance.now();

    const cached = normalizeCached(streamCache.get(cacheKey));
    if (cached.length) {
        console.log(`Using cached stream for series ${imdbId} S${season}E${episode}`);
        const out = cached.map((candidate) => mapCandidateToStream(candidate, `${imdbId} S${season}E${episode} (cached)`));
        logStreamTiming('getSeriesStreams cache_hit', tHandler);
        return out;
    }

    const tMeta = performance.now();
    const metadata = await fetchOmdbDetails(imdbId);
    logStreamTiming('getSeriesStreams meta', tMeta);

    const streams = await extractAllStreams({ type: 'series', imdbId, season, episode });
    streamCache.set(cacheKey, streams);
    const desc = seriesStreamDescription(metadata, imdbId, season, episode);
    logStreamTiming('getSeriesStreams cache_miss_total', tHandler);
    return streams.map((candidate) => mapCandidateToStream(candidate, desc));
}



builder.defineStreamHandler(async ({type, id}) => {
    logger.info(`Stream request: ${type}, ${id}`);
    try {
        if (type === 'movie') {
            // Movie IDs are in the format: tt1234567
            const imdbId = id.split(':')[0];
            const streams = await getMovieStreams(imdbId);
            return Promise.resolve( { streams });
        }
        if (type === 'series') {
            // Series IDs are in the format: tt1234567:1:1 (imdbId:season:episode)
            const [imdbId, season, episode] = id.split(':');
            const streams = await getSeriesStreams(imdbId, season, episode);
            return Promise.resolve({ streams });
        }

        return { streams: [] };
    } catch (error) {
        console.error('Error in stream handler:', error.message);
        return Promise.resolve({ streams: [] });
    }
});

function buildForwardHeaders(requestHeaders = {}, range) {
    const headers = {
        Referer: requestHeaders.Referer,
        Origin: requestHeaders.Origin,
        "User-Agent": requestHeaders["User-Agent"],
        "Accept-Language": requestHeaders["Accept-Language"],
        Accept: "*/*"
    };
    if (range) headers.Range = range;
    return headers;
}

function rewriteManifestUrls(manifestText, streamUrl, token) {
    const lines = String(manifestText).split('\n');
    return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
            return line.replace(/URI="([^"]+)"/, (_match, uri) => {
                const absolute = new URL(uri, streamUrl).toString();
                return `URI="${buildProxyUrl(token, absolute)}"`;
            });
        }
        if (trimmed.startsWith('#')) return line;
        const absolute = new URL(trimmed, streamUrl).toString();
        return buildProxyUrl(token, absolute);
    }).join('\n');
}

async function startServer() {
    const app = express();
    app.use(getRouter(builder.getInterface()));
    app.get('/proxy/:token', async (req, res) => {
        const session = proxySessionCache.get(req.params.token);
        const targetUrl = req.query.u;
        if (!session || !targetUrl || Array.isArray(targetUrl)) {
            return res.status(400).send('Invalid proxy request');
        }

        try {
            const upstream = await axios.get(targetUrl, {
                responseType: 'stream',
                timeout: 20000,
                validateStatus: () => true,
                headers: buildForwardHeaders(session.requestHeaders, req.headers.range),
                httpsAgent: insecureAgent
            });

            if (targetUrl.includes('.m3u8')) {
                const chunks = [];
                upstream.data.on('data', (chunk) => chunks.push(chunk));
                upstream.data.on('error', () => res.status(502).send('Proxy stream read error'));
                upstream.data.on('end', () => {
                    const manifest = Buffer.concat(chunks).toString('utf8');
                    const rewritten = rewriteManifestUrls(manifest, targetUrl, req.params.token);
                    res.status(upstream.status);
                    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
                    res.send(rewritten);
                });
                return;
            }

            res.status(upstream.status);
            const contentType = upstream.headers['content-type'];
            const contentLength = upstream.headers['content-length'];
            const acceptRanges = upstream.headers['accept-ranges'];
            const contentRange = upstream.headers['content-range'];
            if (contentType) res.setHeader('content-type', contentType);
            if (contentLength) res.setHeader('content-length', contentLength);
            if (acceptRanges) res.setHeader('accept-ranges', acceptRanges);
            if (contentRange) res.setHeader('content-range', contentRange);
            upstream.data.pipe(res);
        } catch (error) {
            logger.warn(`Proxy error: ${error.message}`);
            res.status(502).send('Proxy error');
        }
    });
    app.get('/', (_req, res) => {
        res.redirect('/manifest.json');
    });
    app.listen(PORT, '0.0.0.0', () => {
        logger.info(`Addon running on port ${PORT}`);
        prewarmPool();
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        logger.error(`Failed to start server: ${error.message}`);
    });
}

function flushStreamCachesForBenchmark() {
    streamCache.flushAll();
    proxySessionCache.flushAll();
}

module.exports = {
    extractAllStreams,
    fetchOmdbDetails,
    flushStreamCachesForBenchmark,
};