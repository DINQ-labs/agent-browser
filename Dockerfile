# agent-browser HTTP bridge runtime image (Node.js daemon + Express bridge).
#
# Build from repo root:
#   docker build -t agent-browser-bridge .
# Run:
#   docker run --rm -p 3000:3000 agent-browser-bridge

FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=0

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xvfb \
    xauth \
    # Chromium system dependencies (Playwright/Patchright)
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libgtk-3-0 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    libxcb1 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY bridge/package.json bridge/pnpm-lock.yaml bridge/tsconfig.json ./bridge/

# Install deps first for better layer caching
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN BETTER_SQLITE_DIR="$(find node_modules/.pnpm -maxdepth 1 -type d -name 'better-sqlite3@*' | head -n1)/node_modules/better-sqlite3" \
    && cd "$BETTER_SQLITE_DIR" \
    && npm run install
RUN pnpm -C bridge install --frozen-lockfile --ignore-scripts

COPY src ./src
COPY bin ./bin
COPY bridge/src ./bridge/src

RUN pnpm run build
RUN pnpm -C bridge run build

# Download browser runtimes into the image
RUN pnpm exec patchright install chromium \
    && pnpm exec camoufox-js fetch

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# Run the bridge with an embedded Xvfb so headed sessions work in containers.
# Avoids relying on xvfb-run's SIGUSR1 readiness handshake as PID 1.
ENV DISPLAY=:99
ENTRYPOINT ["sh", "-lc", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 & exec node bridge/dist/server.js"]
