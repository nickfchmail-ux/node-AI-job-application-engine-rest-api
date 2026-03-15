# Playwright official image includes all Chromium system dependencies
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Install Playwright Chromium browser
RUN npx playwright install chromium

# Copy source
COPY . .

# Expose port (Railway sets $PORT automatically)
EXPOSE 3000

# Runs HTTP API server + pipeline worker in the same container.
# Both share the browser pool (browserPool.ts) and connect to the same Redis.
# To scale workers independently, deploy a second Railway service from this
# image with CMD ["npx", "ts-node", "src/worker.ts"] and no EXPOSE.
CMD ["npm", "run", "start:all"]
