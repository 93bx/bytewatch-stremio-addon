const { connect } = require("puppeteer-real-browser");
const logger = require("./logger");

const CONNECT_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--disable-dev-shm-usage",
  "--disable-features=IsolateOrigins,site-per-process",
  "--enable-popup-blocking",
];

function poolEnabled() {
  return process.env.BROWSER_POOL !== "0";
}

function maxConcurrentPages() {
  const n = Number(process.env.POOL_CONCURRENCY || 2);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

function maxPoolAgeMs() {
  const n = Number(process.env.POOL_MAX_AGE_MS || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    }).then(() => {
      this.active += 1;
    });
  }

  release() {
    this.active -= 1;
    if (this.waiters.length > 0 && this.active < this.max) {
      const resolve = this.waiters.shift();
      resolve();
    }
  }
}

let browserInstance = null;
let browserCreatedAt = 0;
let connectPromise = null;
const slotSemaphore = new Semaphore(maxConcurrentPages());

async function connectBrowser() {
  // Keep the initial page open as a keep-alive tab. puppeteer-real-browser
  // (headful) fails to create new targets if the browser has zero pages, so
  // closing it here would break subsequent browser.newPage() calls.
  const { browser } = await connect({
    headless: false,
    turnstile: true,
    args: CONNECT_ARGS,
    customConfig: {},
    connectOption: {},
    disableXvfb: false,
    ignoreAllFlags: false,
  });
  browserCreatedAt = Date.now();
  browser.on("disconnected", () => {
    browserInstance = null;
    connectPromise = null;
    browserCreatedAt = 0;
  });
  return browser;
}

async function getBrowser() {
  const maxAge = maxPoolAgeMs();
  if (
    browserInstance &&
    maxAge > 0 &&
    Date.now() - browserCreatedAt > maxAge
  ) {
    try {
      await browserInstance.close();
    } catch (_) {
      /* ignore */
    }
    browserInstance = null;
    connectPromise = null;
  }

  if (browserInstance) return browserInstance;
  if (!connectPromise) {
    connectPromise = connectBrowser()
      .then((b) => {
        browserInstance = b;
        return b;
      })
      .catch((err) => {
        connectPromise = null;
        throw err;
      });
  }
  return connectPromise;
}

/**
 * Run fn with a fresh page from the shared browser. Serializes only by POOL_CONCURRENCY.
 */
async function withPooledPage(fn) {
  if (!poolEnabled()) {
    const { browser, page } = await connect({
      headless: false,
      turnstile: true,
      args: CONNECT_ARGS,
      customConfig: {},
      connectOption: {},
      disableXvfb: false,
      ignoreAllFlags: false,
    });
    try {
      return await fn(page);
    } finally {
      try {
        await page.close();
      } catch (_) {
        /* ignore */
      }
      try {
        await browser.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  await slotSemaphore.acquire();
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    return await fn(page);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {
        /* ignore */
      }
    }
    slotSemaphore.release();
  }
}

/** Warm browser in background (first stream is faster). */
function prewarmPool() {
  if (!poolEnabled()) return;
  if (process.env.POOL_PREWARM !== "1") return;
  getBrowser().catch((err) => {
    logger.warn(`POOL_PREWARM failed: ${err.message}`);
  });
}

module.exports = {
  withPooledPage,
  prewarmPool,
  poolEnabled,
  getBrowser,
};
