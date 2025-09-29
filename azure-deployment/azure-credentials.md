# Azure Deployment Credentials

## Required Credentials for Azure Deployment

To deploy the STS3 application to Azure, you need the following credentials:

### Azure Service Principal
- **Subscription ID**: Your Azure subscription identifier
- **Tenant ID**: Your Azure Active Directory tenant identifier  
- **Client ID**: Service principal application identifier
- **Client Secret**: Service principal password/secret

### Azure CLI Authentication
Alternatively, you can use Azure CLI authentication:
```bash
az login
az account set --subscription "your-subscription-id"
```

### Environment Variables
Set these environment variables for deployment:
```bash
export AZURE_SUBSCRIPTION_ID="your-subscription-id"
export AZURE_TENANT_ID="your-tenant-id"
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
```

### API Keys for Azure Key Vault
The following API keys will be stored in Azure Key Vault:
- **DEEPGRAM_API_KEY**: For speech-to-text service
- **DEEPL_API_KEY**: For translation service
- **AZURE_SPEECH_KEY**: For text-to-speech service

## Deployment Process

1. **Authenticate with Azure**
   ```bash
   az login
   ```

2. **Set subscription**
   ```bash
   az account set --subscription "your-subscription-id"
   ```

3. **Run deployment script**
   ```bash
   cd azure-deployment
   chmod +x deploy.sh
   ./deploy.sh
   ```

4. **Configure API keys in Key Vault**
   ```bash
   az keyvault secret set --vault-name "sts3-dev-kv-xxxxx" --name "deepgram-api-key" --value "YOUR_DEEPGRAM_KEY"
   az keyvault secret set --vault-name "sts3-dev-kv-xxxxx" --name "deepl-api-key" --value "YOUR_DEEPL_KEY"
   az keyvault secret set --vault-name "sts3-dev-kv-xxxxx" --name "azure-speech-key" --value "YOUR_AZURE_SPEECH_KEY"
   ```

## Security Notes

- Never commit credentials to version control
- Use Azure Key Vault for production secrets
- Rotate credentials regularly
- Use managed identities when possible
- Restrict access with RBAC policies

## Troubleshooting

If deployment fails:
1. Verify Azure CLI is installed and authenticated
2. Check subscription permissions
3. Ensure resource quotas are available
4. Review deployment logs for specific errors

For credential issues:
1. Verify service principal has Contributor role
2. Check subscription and tenant IDs are correct
3. Ensure client secret hasn't expired
4. Test authentication with `az account show`
