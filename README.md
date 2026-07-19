# Bytewatch Stremio Addon

A Node.js-powered Stremio addon that scrapes streaming providers with a **real, headful browser** (`puppeteer-real-browser`) and serves verified stream links to Stremio through a single stream handler.

---

## Features

- Two providers scraped in parallel: **vidcore** (`vidcore.net`) and **vidfast** (`vidfast.vc`)
- Real headful browser scraping via `puppeteer-real-browser` (bypasses common anti-bot checks)
- Aggressive allow-list ad/pop-up blocking (keeps the player + media CDN, blocks everything else)
- Multi-server extraction: switches to an alternate in-player server (best-effort) to surface a second distinct stream per provider
- Extracted links are **verified** (reachable + valid HLS/MP4) before being returned
- Cross-provider de-duplication so the same media link is never listed twice
- Stream links are proxied through the addon to inject the required `Referer`/`Origin`/`User-Agent`
- Caching via `node-cache`, logging via `winston`

> IMDB IDs are used directly by both providers, so no TMDB lookup is needed in the hot path.

---

## Project Structure

```
bytewatch-stremio-addon/
│
├── index.js               # Entry point: manifest, stream handler, proxy, cache
├── unified-extractor.js   # Scraper logic: providers, ad-blocking, multi-server, verify
├── browser-pool.js        # Shared headful browser pool (puppeteer-real-browser)
├── logger.js              # Winston logger setup
├── Dockerfile             # Production image (Chrome + Xvfb)
├── package.json           # Metadata and dependencies
└── README.md              # Documentation
```

---

## Requirements

Because scraping runs a **headful** Chrome, the environment must provide a display:

- **Node.js v18+**
- **Google Chrome / Chromium** (installed automatically in Docker; `postinstall` also downloads a puppeteer-managed build)
- **Linux servers:** an X server. `puppeteer-real-browser` starts **Xvfb** automatically (the `xvfb` binary must be installed).
- **RAM:** ~1.5 GB+ under load. On low-RAM VMs **add swap** (headful Chrome can OOM without it).

---

## Configuration (Environment Variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP port. |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | **Public** base URL used to build proxied stream links. In production set this to your real `https://…` URL. |
| `SOURCES` | `vidcore,vidfast` | Comma list of enabled providers (subset of `vidcore`,`vidfast`). |
| `STREAM_CACHE_TTL` | `300` | Stream cache seconds. CDN tokens are session/IP-bound and short-lived. |
| `OMDB_API_KEY` | (built-in) | OMDB key used only for the stream description text. |
| `MULTISERVER` | on | Set `0` to disable alternate-server extraction. |
| `SERVER_SWITCH_BUDGET_MS` | `12000` | Best-effort time budget for switching to a 2nd server. |
| `BROWSER_POOL` | on | Set `0` to launch a fresh browser per request instead of pooling. |
| `POOL_CONCURRENCY` | `2` | Max concurrent scraping tabs. |
| `POOL_PREWARM` | off | Set `1` to warm the browser at startup. |
| `VERIFY_MODE` | `fast` | `fast` \| `balanced` \| `strict` link verification. |
| `STREAM_TIMING` | off | Set `1` to log per-stage timing. |

---

## Local Development

```bash
git clone https://github.com/93bx/bytewatch-stremio-addon.git
cd bytewatch-stremio-addon
npm install          # postinstall downloads the puppeteer Chrome build
node index.js
```

Open `http://localhost:7000/manifest.json`. To add it to Stremio, the manifest URL must be reachable on `127.0.0.1` **or** over HTTPS.

> On Linux desktops without a display, install `xvfb` (`sudo apt install xvfb`) — the browser runs headful inside a virtual framebuffer.

---

## Deploy to a VPS (Docker, recommended)

The included `Dockerfile` installs Chrome + Xvfb and runs the headful browser correctly. These steps target a fresh Ubuntu server (e.g. 2 vCPU / ~3.4 GB RAM). Stremio requires **HTTPS** for non-localhost addons, so a domain + reverse proxy (Caddy, for automatic TLS) is included.

### 1. Add swap (important — the server has none)

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm swap is active
```

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

### 3. Build and run the addon

```bash
git clone https://github.com/93bx/bytewatch-stremio-addon.git
cd bytewatch-stremio-addon
sudo docker build -t bytewatch .

sudo docker run -d --name bytewatch \
  --restart unless-stopped \
  --shm-size=1g \
  -p 127.0.0.1:8080:8080 \
  -e PORT=8080 \
  -e PUBLIC_BASE_URL=https://YOUR_DOMAIN \
  -e POOL_CONCURRENCY=2 \
  bytewatch
```

- `--shm-size=1g` gives Chrome enough shared memory.
- Bind to `127.0.0.1` so only the local reverse proxy can reach it.
- Replace `YOUR_DOMAIN` with the domain that points to this server.

Check it: `curl -s localhost:8080/manifest.json | head`.

### 4. HTTPS with Caddy (automatic certificates)

Point a DNS `A` record for `YOUR_DOMAIN` at the server, then:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Set `/etc/caddy/Caddyfile` to:

```
YOUR_DOMAIN {
    reverse_proxy 127.0.0.1:8080
}
```

Then `sudo systemctl reload caddy`. Caddy fetches a Let's Encrypt certificate automatically.

### 5. Add to Stremio

Open `https://YOUR_DOMAIN/manifest.json` to confirm it loads, then paste that URL into Stremio → Add-ons.

### Updating

```bash
cd bytewatch-stremio-addon && git pull
sudo docker build -t bytewatch . && sudo docker rm -f bytewatch
# re-run the docker run command from step 3
```

Logs: `sudo docker logs -f bytewatch`.

---

## Notes

- Provider/scraper logic lives in `unified-extractor.js`; the browser lifecycle in `browser-pool.js`.
- Caching is in-memory (`node-cache`) — restarting clears it.
- The addon **must** run headful; pure-headless serverless platforms (e.g. Vercel functions) are not compatible.

---

## License

ISC License. Use freely and modify as needed.
