#!/bin/bash


set -e

RESOURCE_GROUP="sts3-dev-rg"
LOCATION="israelcentral"
DEPLOYMENT_NAME="sts3-deployment-$(date +%s)"
TEMPLATE_FILE="deploy.bicep"
SSH_KEY_PATH="$HOME/.ssh/id_rsa.pub"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting STS3 Azure Deployment...${NC}"

if ! command -v az &> /dev/null; then
    echo -e "${RED}Azure CLI is not installed. Installing Azure CLI...${NC}"
    curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
fi

if ! az account show &> /dev/null; then
    echo -e "${YELLOW}Not logged in to Azure. Please login first.${NC}"
    az login --use-device-code
fi

if [ ! -z "$AZURE_SUBSCRIPTION_ID" ]; then
    echo -e "${GREEN}Setting Azure subscription: $AZURE_SUBSCRIPTION_ID${NC}"
    az account set --subscription "$AZURE_SUBSCRIPTION_ID"
fi

if [ ! -f "$SSH_KEY_PATH" ]; then
    echo -e "${YELLOW}SSH key not found. Generating new SSH key...${NC}"
    ssh-keygen -t rsa -b 4096 -f "$HOME/.ssh/id_rsa" -N ""
fi

SSH_PUBLIC_KEY=$(cat "$SSH_KEY_PATH")

echo -e "${GREEN}Creating resource group: $RESOURCE_GROUP${NC}"
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION"

echo -e "${GREEN}Deploying infrastructure...${NC}"
DEPLOYMENT_OUTPUT=$(az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE_FILE" \
    --parameters \
        location="$LOCATION" \
        namePrefix="sts3" \
        environment="dev" \
        vmSize="Standard_B2s" \
        adminUsername="azureuser" \
        sshPublicKey="$SSH_PUBLIC_KEY" \
    --name "$DEPLOYMENT_NAME" \
    --output json)

VM_IP=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.vmPublicIpAddress.value')
VM_FQDN=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.vmFqdn.value')
SSH_COMMAND=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.sshCommand.value')
BACKEND_URL=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.backendUrl.value')
STORAGE_ACCOUNT=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.storageAccountName.value')
KEY_VAULT=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.keyVaultName.value')

echo -e "${GREEN}Deployment completed successfully!${NC}"
echo
echo -e "${YELLOW}Deployment Information:${NC}"
echo "Resource Group: $RESOURCE_GROUP"
echo "VM Public IP: $VM_IP"
echo "VM FQDN: $VM_FQDN"
echo "SSH Command: $SSH_COMMAND"
echo "Backend URL: $BACKEND_URL"
echo "Storage Account: $STORAGE_ACCOUNT"
echo "Key Vault: $KEY_VAULT"
echo

echo -e "${GREEN}Waiting for VM to be ready...${NC}"
sleep 60

echo -e "${GREEN}Testing SSH connection...${NC}"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 azureuser@"$VM_IP" "echo 'SSH connection successful'"

echo -e "${GREEN}Setting up Key Vault secrets...${NC}"

if [ ! -z "$DEEPGRAM_API_KEY" ]; then
    echo -e "${GREEN}Setting Deepgram API key in Key Vault...${NC}"
    az keyvault secret set --vault-name "$KEY_VAULT" --name "deepgram-api-key" --value "$DEEPGRAM_API_KEY"
fi

if [ ! -z "$DEEPL_API_KEY" ]; then
    echo -e "${GREEN}Setting DeepL API key in Key Vault...${NC}"
    az keyvault secret set --vault-name "$KEY_VAULT" --name "deepl-api-key" --value "$DEEPL_API_KEY"
fi

if [ ! -z "$AZURE_SPEECH_KEY" ]; then
    echo -e "${GREEN}Setting Azure Speech key in Key Vault...${NC}"
    az keyvault secret set --vault-name "$KEY_VAULT" --name "azure-speech-key" --value "$AZURE_SPEECH_KEY"
fi

echo -e "${YELLOW}Manual steps required:${NC}"
echo "1. Configure SSL certificate:"
echo "   $SSH_COMMAND"
echo "   sudo certbot --nginx -d $VM_FQDN"
echo
echo "2. Update frontend environment:"
echo "   Update VITE_API_URL to: https://$VM_FQDN/api"
echo
echo "3. Monitor deployment:"
echo "   $SSH_COMMAND"
echo "   ./monitor-sts3.sh"

cat > deployment-info.json << EOF
{
  "resourceGroup": "$RESOURCE_GROUP",
  "vmPublicIp": "$VM_IP",
  "vmFqdn": "$VM_FQDN",
  "sshCommand": "$SSH_COMMAND",
  "backendUrl": "$BACKEND_URL",
  "storageAccount": "$STORAGE_ACCOUNT",
  "keyVault": "$KEY_VAULT",
  "deploymentDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo -e "${GREEN}Deployment information saved to deployment-info.json${NC}"
echo -e "${GREEN}STS3 Azure deployment completed!${NC}"
