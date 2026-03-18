#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Railway deployment — 1 API server + 3 workers + Redis
#
# Prerequisites:
#   1. Railway CLI installed:  npm i -g @railway/cli
#   2. Authenticated:          railway login
#   3. Environment variables ready (see ENV_VARS section below)
#
# Usage:
#   chmod +x deploy-railway.sh
#   ./deploy-railway.sh
###############################################################################

PROJECT_NAME="jobsautomation-api"

# ── Shared env vars to set on EVERY service ─────────────────────────────────
# Fill these in or export them before running the script.
# REDIS_URL is auto-injected by Railway when you reference the Redis service.
SHARED_VARS=(
  "SUPABASE_URL"
  "SUPABASE_SERVICE_KEY"
  "SUPABASE_ANON_KEY"
  "DEEPSEEK_API_KEY"
  "JWT_SECRET"
)

echo "============================================"
echo "  Railway Deployment: $PROJECT_NAME"
echo "  Services: api-server + 3 workers + Redis"
echo "============================================"
echo ""

# ── 1. Create project ──────────────────────────────────────────────────────
echo ">>> Creating Railway project..."
railway init --name "$PROJECT_NAME"
echo ""

# ── 2. Add Redis ───────────────────────────────────────────────────────────
echo ">>> Adding Redis service..."
railway add --plugin redis
echo ""
echo "Redis added. Railway will provide REDIS_URL via reference variable."
echo ""

# ── 3. Create and deploy API server ───────────────────────────────────────
echo ">>> Creating api-server service..."
railway service create api-server
railway link --service api-server

# Tell Railway which Dockerfile to use
railway variables set RAILWAY_DOCKERFILE_PATH=Dockerfile.server
railway variables set PORT=8080

echo ">>> Deploying api-server..."
railway up --detach
echo ""

# ── 4. Create and deploy 3 workers ────────────────────────────────────────
for i in 1 2 3; do
  SERVICE_NAME="worker-${i}"
  echo ">>> Creating $SERVICE_NAME service..."
  railway service create "$SERVICE_NAME"
  railway link --service "$SERVICE_NAME"

  railway variables set RAILWAY_DOCKERFILE_PATH=Dockerfile.worker
  railway variables set WORKER_CONCURRENCY=2

  echo ">>> Deploying $SERVICE_NAME..."
  railway up --detach
  echo ""
done

# ── 5. Summary ─────────────────────────────────────────────────────────────
echo "============================================"
echo "  Deployment initiated!"
echo "============================================"
echo ""
echo "IMPORTANT — Set shared env vars on each service:"
echo ""
echo "For each service (api-server, worker-1, worker-2, worker-3), run:"
echo ""
echo '  railway link --service <service-name>'
echo '  railway variables set SUPABASE_URL="..." SUPABASE_SERVICE_KEY="..." SUPABASE_ANON_KEY="..." DEEPSEEK_API_KEY="..." JWT_SECRET="..."'
echo ""
echo "For REDIS_URL, use Railway variable references so each service"
echo "automatically gets the internal Redis URL:"
echo ""
echo '  railway link --service <service-name>'
echo '  railway variables set REDIS_URL="\${{Redis.REDIS_URL}}"'
echo ""
echo "Or set all at once with this helper loop:"
echo ""
cat << 'HELPER'
  for svc in api-server worker-1 worker-2 worker-3; do
    railway link --service "$svc"
    railway variables set \
      REDIS_URL="\${{Redis.REDIS_URL}}" \
      SUPABASE_URL="<your-url>" \
      SUPABASE_SERVICE_KEY="<your-key>" \
      SUPABASE_ANON_KEY="<your-anon-key>" \
      DEEPSEEK_API_KEY="<your-key>" \
      JWT_SECRET="<your-secret>"
  done
HELPER
echo ""
echo "To check deployment status:"
echo "  railway status"
echo ""
echo "To view logs:"
echo "  railway link --service <service-name>"
echo "  railway logs"
echo ""
echo "To generate a public domain for the API server:"
echo "  railway link --service api-server"
echo "  railway domain"
