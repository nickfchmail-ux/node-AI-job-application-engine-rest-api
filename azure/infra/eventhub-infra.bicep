// ============================================================
//  eventhub-infra.bicep — incremental Event Hubs provisioning
//  for an EXISTING Function App.
//
//  Deployed SEPARATELY from main.bicep so it never touches the
//  Function App's existing appSettings (which are managed outside
//  Bicep in this environment).
//
//  Creates:
//    - Event Hubs namespace (Standard) + `jobs` event hub
//    - $Default consumer group
//    - RBAC: Data Sender + Data Receiver to the function identity
//
//  The Function App's EventHub__fullyQualifiedNamespace +
//  EventHub__credential=managedidentity app settings are set via
//  `az functionapp config appsettings set` after deploy.
// ============================================================

param location string = resourceGroup().location
param eventHubNamespaceName string = 'jobsautomation-ehns'
param eventHubName string = 'jobs'
param functionAppName string = 'jobsautomation-fn'

// The Function App must exist (we bind RBAC to its identity).
resource functionApp 'Microsoft.Web/sites@2023-01-01' existing = {
  name: functionAppName
}

resource eventHubNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: eventHubNamespaceName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
    capacity: 1
  }
  properties: {
    minimumTlsVersion: '1.2'
  }
}

resource eventHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  name: eventHubName
  parent: eventHubNamespace
  properties: {
    partitionCount: 16
    retentionDescription: {
      retentionTimeInHours: 1
      cleanupPolicy: 'Delete'
    }
  }
}

resource ehConsumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  name: '$Default'
  parent: eventHub
}

// ── RBAC: Function App identity → Event Hubs ──────────────────
resource ehSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(eventHubNamespace.id, functionAppName, 'eh-sender')
  scope: eventHubNamespace
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/2b629674-e913-4c01-ae53-ef4638d8f975' // Azure Event Hubs Data Sender
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource ehReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(eventHubNamespace.id, functionAppName, 'eh-receiver')
  scope: eventHubNamespace
  properties: {
    roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/a638d3c7-ab3a-418d-83e6-5f17a39d4fde' // Azure Event Hubs Data Receiver
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output eventHubNamespaceName_out string = eventHubNamespaceName
output eventHubEndpoint string = eventHubNamespace.properties.serviceBusEndpoint
output eventHubName_out string = eventHub.name
output functionAppPrincipalId string = functionApp.identity.principalId
