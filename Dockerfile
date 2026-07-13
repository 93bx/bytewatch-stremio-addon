FROM node:20-bookworm-slim

# Install system deps needed to run a real Chrome browser headlessly via Xvfb
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends \
        wget \
        gnupg2 \
        ca-certificates \
        xvfb \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm install

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
ENV DISPLAY=:99
# System Chrome installed via apt above — used as a stable fallback path
ENV CHROME_PATH=/usr/bin/google-chrome-stable
# Northflank/most PaaS providers inject PORT at runtime; 8080 is a sane default
ENV PORT=8080

EXPOSE 8080

# Resolve the puppeteer-downloaded Chrome binary at container start (its exact
# version-pinned path changes between installs) and fall back to system Chrome
# if that lookup fails, then start the app.
CMD ["/bin/sh", "-c", "export CHROME_PATH=$(find /root/.cache/puppeteer -type f -name chrome 2>/dev/null | head -n 1); export CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome-stable}; echo \"Using Chrome at: $CHROME_PATH\"; node index.js"]
