#!/usr/bin/env bash
# ============================================================
#  Deploy the Jobs Automation Azure infrastructure
#  (Function App + Service Bus queues) via Bicep.
#
#  Prereqs: az login, az CLI with bicep
#  Usage:   ./deploy-azure.sh <resource-group> <location>
# ============================================================
set -euo pipefail

RG="${1:-jobsautomation-rg}"
LOCATION="${2:-eastasia}"

echo "══ Deploying to resource group: ${RG} (${LOCATION}) ══"

# ── Ensure resource group ────────────────────────────────────
az group create --name "$RG" --location "$LOCATION" -o none

# ── Collect secrets (from env or prompt) ─────────────────────
: "${SUPABASE_URL:?Set SUPABASE_URL env var}"
: "${SUPABASE_SERVICE_KEY:?Set SUPABASE_SERVICE_KEY env var}"
: "${DEEP_SEEK_API:?Set DEEP_SEEK_API env var}"
: "${AZURE_FUNCTION_WEBHOOK_SECRET:?Set AZURE_FUNCTION_WEBHOOK_SECRET env var}"
CLOUDFLARE_PROXY_URL="${CLOUDFLARE_PROXY_URL:-}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"

# ── Deploy Bicep ─────────────────────────────────────────────
echo "══ Deploying Bicep (Function App + Service Bus) ══"
az deployment group create \
  --resource-group "$RG" \
  --template-file infra/main.bicep \
  --parameters \
    supabaseUrl="$SUPABASE_URL" \
    supabaseServiceKey="$SUPABASE_SERVICE_KEY" \
    supabaseAnonKey="$SUPABASE_ANON_KEY" \
    deepSeekApi="$DEEP_SEEK_API" \
    azureFunctionWebhookSecret="$AZURE_FUNCTION_WEBHOOK_SECRET" \
    cloudflareProxyUrl="$CLOUDFLARE_PROXY_URL" \
    environment=dev \
  -o json

echo "══ Deployment complete. Fetching outputs ══"
az deployment group show \
  --resource-group "$RG" \
  --name main \
  --query properties.outputs \
  -o json
