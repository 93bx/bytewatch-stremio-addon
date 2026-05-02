const { addonBuilder } = require('stremio-addon-sdk');
const { extractor } = require('../unified-extractor');
const { logger } = require('../logger');
const axios = require('axios');
const NodeCache = require('node-cache');

const builder = new addonBuilder({
    id: 'org.bytetan.bytewatch',
    name: 'Bytewatch Stremio Addon',
    description: 'A Node.js-powered Stremio addon that scrapes multiple streaming sites using Puppeteer',
    version: '1.0.0',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    logo: 'https://www.bytetan.com/static/img/logo.png',
    idPrefixes: ['tt']
});

// Setup cache to reduce load (cache for 2 hours)
const streamCache = new NodeCache({ stdTTL: 7200, checkperiod: 120 });

// Landing page HTML
const landingPageHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ByteWatch - Stremio Addon</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
    }

    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
      animation: fadeInUp 0.8s ease-out;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 2rem;
      border-radius: 20px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2rem;
      font-weight: bold;
      box-shadow: 0 10px 30px rgba(99, 102, 241, 0.3);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .description {
      font-size: 1.1rem;
      color: #a1a1aa;
      margin-bottom: 3rem;
      line-height: 1.6;
    }

    .install-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 2rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      text-decoration: none;
      border-radius: 50px;
      font-weight: 600;
      font-size: 1.1rem;
      transition: all 0.3s ease;
      box-shadow: 0 4px 20px rgba(99, 102, 241, 0.4);
      position: relative;
      overflow: hidden;
    }

    .install-btn::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      transition: left 0.5s;
    }

    .install-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 25px rgba(99, 102, 241, 0.6);
    }

    .install-btn:hover::before {
      left: 100%;
    }

    .install-icon {
      width: 20px;
      height: 20px;
    }

    .features {
      margin-top: 3rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
    }

    .feature {
      padding: 1.5rem;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: transform 0.3s ease;
    }

    .feature:hover {
      transform: translateY(-5px);
    }

    .feature-icon {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }

    .feature h3 {
      font-size: 1.1rem;
      margin-bottom: 0.5rem;
      color: #e4e4e7;
    }

    .feature p {
      font-size: 0.9rem;
      color: #a1a1aa;
    }

    .github-link {
      margin-top: 2rem;
      opacity: 0.7;
      transition: opacity 0.3s ease;
    }

    .github-link:hover {
      opacity: 1;
    }

    .github-link a {
      color: #a1a1aa;
      text-decoration: none;
      font-size: 0.9rem;
    }

    @media (max-width: 768px) {
      .container {
        padding: 1rem;
      }
      
      h1 {
        font-size: 2rem;
      }
      
      .logo {
        width: 60px;
        height: 60px;
        font-size: 1.5rem;
      }
      
      .features {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">BW</div>
    
    <h1>ByteWatch</h1>
    
    <p class="description">
      Stream movies and TV shows directly in Stremio from multiple sources. 
      One addon, unlimited entertainment.
    </p>
    
    <a href="#" class="install-btn" id="installBtn">
      <svg class="install-icon" fill="currentColor" viewBox="0 0 20 20">
        <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-2 0V5H5v10h10v-1a1 1 0 112 0v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4z"/>
        <path d="M13 6a1 1 0 011 1v6l2-2a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4A1 1 0 119.414 8.414L11 10.586V7a1 1 0 011-1z"/>
      </svg>
      Install in Stremio
    </a>
    
    <div class="features">
      <div class="feature">
        <div class="feature-icon">🎬</div>
        <h3>Movies & TV Shows</h3>
        <p>Access content from multiple streaming sources</p>
      </div>
      
      <div class="feature">
        <div class="feature-icon">⚡</div>
        <h3>Fast & Reliable</h3>
        <p>Optimized for speed with smart caching</p>
      </div>
      
      <div class="feature">
        <div class="feature-icon">🔒</div>
        <h3>Open Source</h3>
        <p>Transparent and community-driven</p>
      </div>
    </div>
    
    <div class="github-link">
      <a href="https://github.com/Sz19-pixel/bytewatch-stremio-addon" target="_blank">
        View on GitHub →
      </a>
    </div>
  </div>

  <script>
    // Set the install button URL to the current domain + manifest
    document.getElementById('installBtn').href = 'stremio://' + window.location.hostname + '/manifest.json';
    
    // Add click tracking (optional)
    document.getElementById('installBtn').addEventListener('click', function() {
      console.log('Install button clicked');
    });
  </script>
</body>
</html>
`;

// Fetch movie data
async function fetchOmdbDetails(imdbId){
  try {
    const response = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=b1e4f11`);
     if (response.data.Response === 'False') {
      throw new Error(response.data || 'Failed to fetch data from OMDB API');
     }
    return response.data;
  } catch (e) {
    console.log(`Error fetching metadata: ${e}`)
    return null
  }
}

// Fetch TMDB ID
async function fetchTmdbId(imdbId){
  try {
      const response = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`,
          {
              method: 'GET',
              headers: {
                  accept: 'application/json',
                  Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3M2EyNzkwNWM1Y2IzNjE1NDUyOWNhN2EyODEyMzc0NCIsIm5iZiI6MS43MjM1ODA5NTAwMDg5OTk4ZSs5LCJzdWIiOiI2NmJiYzIxNjI2NmJhZmVmMTQ4YzVkYzkiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.y7N6qt4Lja5M6wnFkqqo44mzEMJ60Pzvm0z_TfA1vxk'
              }
          });
      return response.data;
  } catch (e) {
      console.log(`Error fetching metadata: ${e}`)
      return null
  }
}

// Main extraction function
async function extractAllStreams({type, imdbId, season, episode}) {
    const streams = {};
    const tmdbRes = await fetchTmdbId(imdbId);

    const id = type === 'movie'
        ? tmdbRes['movie_results'][0]?.id
        : tmdbRes['tv_results'][0]?.id;

    if (!id) {
        console.warn('❌ TMDB ID not found');
        return streams;
    }

    const [
        fmoviesResult,
        vidoraResult,
        videasyResult,
    ] = await Promise.allSettled([
        extractor('fmovies', type, id, season, episode),
        extractor('vidora', type, id, season, episode),
        extractor('videasy', type, id, season, episode),
    ]);

    if (fmoviesResult.status === 'fulfilled' && fmoviesResult.value) {
        for (const label in fmoviesResult.value) {
            streams[label] = fmoviesResult.value[label];
        }
    } else {
        console.warn('❌ Fmovies extraction failed:', fmoviesResult.reason?.message);
    }

    if (vidoraResult.status === 'fulfilled' && vidoraResult.value) {
        for (const label in vidoraResult.value) {
            streams[label] = vidoraResult.value[label];
        }
    } else {
        console.warn('❌ Vidora extraction failed:', vidoraResult.reason?.message);
    }

    if (videasyResult.status === 'fulfilled' && videasyResult.value) {
        for (const label in videasyResult.value) {
            streams[label] = videasyResult.value[label];
        }
    } else {
        console.warn('❌ VideasyResult extraction failed:', vidoraResult.reason?.message);
    }

    return streams;
}

// Function to handle streams for movies
async function getMovieStreams(imdbId) {
    const cacheKey = `movie:${imdbId}`;
    const metadata = await fetchOmdbDetails(imdbId);

    // Check cache first
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`Using cached stream for movie ${imdbId}`);
        return Object.entries(cached).map(([name, url]) => ({
            name,
            url,
            description: `${metadata.Title} (${metadata.Year})`
        }));
    }
    const streams = await extractAllStreams({ type: 'movie', imdbId });
    streamCache.set(cacheKey, streams);

    return Object.entries(streams).map(([name, url]) => ({
        name,
        url,
        description: `${metadata.Title} (${metadata.Year})`
    }));
}

// Function to handle streams for TV series
async function getSeriesStreams(imdbId, season, episode) {
    const cacheKey = `series:${imdbId}:${season}:${episode}`;
    const metadata = await fetchOmdbDetails(imdbId);

    // Check cache first
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`Using cached stream for series ${imdbId} S${season}E${episode}`);
        return Object.entries(cached).map(([name, url]) => ({
            name,
            url,
            description: `${metadata.Title} S${season}E${episode}`
        }));
    }

    const streams = await extractAllStreams({ type: 'series', imdbId, season, episode });
    // streamCache.set(cacheKey, streams);
    return Object.entries(streams).map(([name, url]) => ({
        name,
        url,
        description: `${metadata.Title} S${season}E${episode}`
    }));
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

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes cache
}

// Vercel serverless function handler
module.exports = async (req, res) => {
    // Set CORS headers for all requests
    setCorsHeaders(res);

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const path = req.url || '/';
        logger.info(`Request: ${req.method} ${path}`);

        // Handle root path - serve landing page
        if (path === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.status(200).send(landingPageHTML);
            return;
        }

        // Handle manifest requests
        if (path === '/manifest.json') {
            const manifest = builder.getInterface().manifest;
            res.setHeader('Content-Type', 'application/json');
            res.status(200).json(manifest);
            return;
        }

        // Handle stream requests
        if (path.startsWith('/stream/')) {
            const pathParts = path.split('/');
            const type = pathParts[2];
            const id = pathParts[3];

            if (!type || !id) {
                logger.warn(`Invalid stream request: missing type or id`);
                res.status(400).json({
                    error: 'Missing type or id parameter',
                    streams: []
                });
                return;
            }

            const result = await builder.getInterface().get('stream', type, id);
            res.setHeader('Content-Type', 'application/json');
            res.status(200).json(result);
            return;
        }

        // Handle health check
        if (path === '/health') {
            res.status(200).json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                cache: {
                    keys: streamCache.keys().length,
                    stats: streamCache.getStats()
                }
            });
            return;
        }

        // 404 for unknown routes
        res.status(404).json({
            error: 'Not found',
            availableRoutes: ['/manifest.json', '/stream/{type}/{id}', '/health']
        });

    } catch (error) {
        logger.error(`API Error: ${error.message}`);
        res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
        });
    }
}