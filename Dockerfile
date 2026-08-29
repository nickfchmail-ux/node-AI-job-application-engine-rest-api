# Node LTS — API server only (no Playwright / Chromium / worker)
FROM node:18-alpine

WORKDIR /app

# Playwright is a repo dependency but this server never launches a browser
# (scraping runs on Azure Functions). Skip the browser download so the
# free-tier Render build finishes quickly instead of timing out.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build TypeScript once — saves memory at runtime
RUN npx tsc

# Render sets $PORT automatically
ENV NODE_OPTIONS="--max-old-space-size=200"

EXPOSE 8080

# Run the API server (serves /auth, /stats, /jobs + Socket.io WebSocket push)
CMD ["node", "dist/server.js"]
