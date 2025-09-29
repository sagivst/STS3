#!/bin/bash


set -e

echo "🚀 Starting STS3 Quick Azure Deployment..."
echo "📍 Target Region: Israel Central"
echo "💰 Budget: Free Tier ($200 limit)"
echo "⚡ Performance: Zero Latency Optimized"
echo "🖥️  VM Configuration: Standard_B2s (2 vCPU, 4GB RAM, 32GB SSD)"
echo "💵 Estimated Cost: ~$41/month (within free tier)"
echo

chmod +x deploy-with-credentials.sh
chmod +x test-deployment.sh
chmod +x update-frontend-urls.sh

echo "🏗️  Step 1: Deploying Azure infrastructure..."
./deploy-with-credentials.sh

if [ ! -f "deployment-info.json" ]; then
    echo "❌ Deployment failed - no deployment info found"
    exit 1
fi

VM_FQDN=$(jq -r '.vmFqdn' deployment-info.json)
if [ "$VM_FQDN" = "null" ] || [ -z "$VM_FQDN" ]; then
    echo "❌ Could not extract VM FQDN from deployment"
    exit 1
fi

echo "✅ Infrastructure deployed successfully!"
echo "🌐 VM FQDN: $VM_FQDN"
echo

echo "🔧 Step 2: Updating frontend URLs..."
./update-frontend-urls.sh "$VM_FQDN"
echo "✅ Frontend URLs updated!"
echo

echo "⏳ Step 3: Waiting for VM setup to complete (this may take 5-10 minutes)..."
echo "   The VM is installing dependencies and configuring services..."

for i in {1..20}; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 azureuser@"$VM_FQDN" "test -f /home/azureuser/STS3/setup-complete" 2>/dev/null; then
        echo "✅ VM setup completed!"
        break
    fi
    echo "   Waiting... ($i/20)"
    sleep 30
done

echo "🧪 Step 4: Testing deployment..."
./test-deployment.sh "$VM_FQDN"

echo
echo "🎉 STS3 Azure Deployment Complete!"
echo
echo "📋 Deployment Summary:"
echo "   Frontend: https://$VM_FQDN"
echo "   Backend API: https://$VM_FQDN/api"
echo "   WebSocket: wss://$VM_FQDN/ws"
echo "   SSH Access: ssh azureuser@$VM_FQDN"
echo
echo "🔧 VM Configuration:"
echo "   Size: Standard_B2s (2 vCPUs, 4GB RAM)"
echo "   Storage: 32GB Premium SSD"
echo "   Region: Israel Central"
echo "   OS: Ubuntu 22.04 LTS"
echo "   Network: Accelerated networking enabled"
echo "   Performance: Burstable up to 200% CPU"
echo
echo "⚡ Performance Targets:"
echo "   End-to-end Latency: <2 seconds"
echo "   Deepgram STT: ~300ms"
echo "   DeepL Translation: ~400ms"
echo "   Azure TTS: ~500ms"
echo
echo "💰 Estimated Monthly Cost: ~$41-46 (within $200 free tier)"
echo
echo "🎯 Next Steps:"
echo "1. Test the complete audio pipeline with your mobile device"
echo "2. Monitor performance metrics at https://$VM_FQDN/api/health"
echo "3. Configure SSL certificate if needed: sudo certbot --nginx"
echo "4. Set up monitoring and alerting"
echo
echo "📚 For detailed configuration and troubleshooting, see:"
echo "   - DEPLOYMENT_GUIDE.md"
echo "   - vm-recommendations.md"
echo "   - README.md"
