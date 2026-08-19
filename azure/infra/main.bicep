// ============================================================
//  Service Bus provisioning — main.bicep
//
//  Creates:
//    - Service Bus namespace (Standard tier)
//    - scrape-requests queue
//    - jobs queue
//    - Storage account (Function App host)
//    - Function App (Node 20, Consumption)
//    - Managed identity + RBAC (Service Bus Data Sender/Receiver)
//    - App Settings wiring (Supabase, DeepSeek, Cloudflare, secrets)
// ============================================================

param location string = resourceGroup().location
param functionAppName string = 'jobsautomation-fn'
param serviceBusNamespaceName string = 'jobsautomation-sbns'
// (environment param removed — unused)

@secure()
param supabaseUrl string

@secure()
param supabaseServiceKey string

@secure()
param deepSeekApi string

@secure()
param azureFunctionWebhookSecret string

param cloudflareProxyUrl string = ''
param supabaseAnonKey string = ''

// ── Storage account (required by Functions runtime) ─────────────
// Storage account names must be 3–24 chars, lowercase alphanumeric only.
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${take(functionAppName, 8)}${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ── Service Bus namespace (Standard) ───────────────────────────
resource serviceBusNamespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: serviceBusNamespaceName
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    minimumTlsVersion: '1.2'
  }
}

// ── Queues ─────────────────────────────────────────────────────
resource scrapeRequestsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: 'scrape-requests'
  parent: serviceBusNamespace
  properties: {
    maxSizeInMegabytes: 1024
    defaultMessageTimeToLive: 'P2D'                 // 2 days
    maxDeliveryCount: 5
    duplicateDetectionHistoryTimeWindow: 'PT10M'    // 10 min dedup
    deadLetteringOnMessageExpiration: true
    enablePartitioning: true
    lockDuration: 'PT1M'
  }
}

resource jobsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: 'jobs'
  parent: serviceBusNamespace
  properties: {
    maxSizeInMegabytes: 1024
    defaultMessageTimeToLive: 'P2D'
    maxDeliveryCount: 5
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    deadLetteringOnMessageExpiration: true
    enablePartitioning: true
    lockDuration: 'PT5M'  // job processing (DeepSeek) can be slow
  }
}

resource resumeBuildsQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: 'resume-builds'
  parent: serviceBusNamespace
  properties: {
    maxSizeInMegabytes: 1024
    defaultMessageTimeToLive: 'P2D'
    maxDeliveryCount: 5
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    deadLetteringOnMessageExpiration: true
    enablePartitioning: true
    lockDuration: 'PT5M'  // resume generation (DeepSeek) can be slow
  }
}

// ── Function App ───────────────────────────────────────────────
resource serverFarm 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'Y1'          // Consumption
    tier: 'Dynamic'
  }
  kind: 'functionapp'
  properties: {
    reserved: true // required for Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: serverFarm.id
    siteConfig: {
      linuxFxVersion: 'Node|22'
      appSettings: [
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        // Identity-based storage connection (no connection string in code)
        { name: 'AzureWebJobsStorage__accountName', value: storageAccount.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        {
          name: 'ServiceBus__fullyQualifiedNamespace'
          // strip scheme (https://) — @azure/service-bus wants bare hostname
          value: replace(replace(serviceBusNamespace.properties.serviceBusEndpoint, 'https://', ''), '/', '')
        }
        { name: 'ServiceBus__credential', value: 'managedidentity' }
        { name: 'SUPABASE_URL', value: supabaseUrl }
        { name: 'SUPABASE_SERVICE_KEY', value: supabaseServiceKey }
        { name: 'SUPABASE_ANON_KEY', value: supabaseAnonKey }
        { name: 'DEEP_SEEK_API', value: deepSeekApi }
        { name: 'DEEP_SEEK_MODEL', value: 'deepseek-v4-flash' }
        { name: 'CLOUDFLARE_PROXY_URL', value: cloudflareProxyUrl }
        { name: 'GENERATED_RESUME_BUCKET', value: 'generated-resumes' }
        { name: 'RESUME_BUCKET', value: 'resume' }
        { name: 'AZURE_FUNCTION_WEBHOOK_SECRET', value: azureFunctionWebhookSecret }
      ]
    }
  }
}

// ── RBAC: Function App identity → Service Bus ──────────────────
resource sbSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBusNamespace.id, functionAppName, 'sender')
  scope: serviceBusNamespace
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/69a216fc-b8fb-44d8-bc22-1f3c2cd27a39' // Azure Service Bus Data Sender
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource sbReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBusNamespace.id, functionAppName, 'receiver')
  scope: serviceBusNamespace
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0' // Azure Service Bus Data Receiver
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function App identity → Storage (Blob Data Contributor) ──
resource storageBlobContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionAppName, 'storageblob')
  scope: storageAccount
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ────────────────────────────────────────────────────
output functionAppName_out string = functionAppName
output functionAppDefaultHostName string = functionApp.properties.defaultHostName
output serviceBusNamespaceName_out string = serviceBusNamespaceName
output serviceBusEndpoint string = serviceBusNamespace.properties.serviceBusEndpoint
