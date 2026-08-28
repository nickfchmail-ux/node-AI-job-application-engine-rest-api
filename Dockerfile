# Node LTS — API server only (no Playwright / Chromium / worker)
FROM node:18-alpine

WORKDIR /app

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
