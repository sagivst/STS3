#!/bin/bash


VM_FQDN="$1"
if [ -z "$VM_FQDN" ]; then
    echo "Usage: $0 <vm-fqdn>"
    echo "Example: $0 sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com"
    exit 1
fi

FRONTEND_ENV="../translation-frontend/.env"

echo "Updating frontend URLs for Azure deployment..."
echo "VM FQDN: $VM_FQDN"

sed -i "s|sts3-dev-vm-placeholder\.israelcentral\.cloudapp\.azure\.com|$VM_FQDN|g" "$FRONTEND_ENV"

echo "Updated frontend configuration:"
cat "$FRONTEND_ENV"

echo "Frontend URLs updated successfully!"
echo "Next steps:"
echo "1. Rebuild frontend: cd ../translation-frontend && npm run build"
echo "2. Deploy to Azure Static Web Apps or copy to VM"
