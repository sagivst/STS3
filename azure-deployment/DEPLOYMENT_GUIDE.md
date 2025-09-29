# STS3 Azure Deployment Guide - Zero Latency Configuration

## Executive Summary

This guide provides step-by-step instructions for deploying the STS3 simultaneous translation application to Azure with optimal zero-latency performance, specifically configured for the Israel region and free tier budget constraints.

## Recommended Azure VM Configuration

### Primary Recommendation: Standard_B2s
- **vCPUs**: 2 cores
- **RAM**: 4 GB
- **Storage**: 32 GB Premium SSD
- **Network**: Accelerated networking enabled
- **Region**: Israel Central
- **Monthly Cost**: ~$31 (within $200 free tier)

### Performance Justification
- **Real-time Audio Processing**: 2 vCPUs handle concurrent STT, translation, and TTS
- **Memory Buffer**: 4GB sufficient for audio buffering and WebSocket connections
- **Burstable Performance**: Can burst to 200% CPU during audio processing peaks
- **Premium SSD**: Low I/O latency for temporary audio file operations
- **Israel Central Region**: Optimal latency to user location

### Expected Performance Metrics
- **Target Latency**: <2 seconds end-to-end
- **Deepgram STT**: ~300ms
- **DeepL Translation**: ~400ms  
- **Azure TTS**: ~500ms
- **Network Overhead**: ~300ms
- **Total Pipeline**: ~1.5-2.0 seconds

## Quick Deployment Steps

### One-Command Deployment (Recommended)
```bash
cd azure-deployment
chmod +x quick-deploy.sh
./quick-deploy.sh
```

This single command will:
- Deploy VM infrastructure to Israel Central region
- Configure zero-latency optimizations
- Set up API keys automatically
- Test the complete deployment
- Provide all URLs and access information

### Manual Deployment Steps

If you prefer step-by-step control:

### 1. Prepare Environment
```bash
cd azure-deployment
chmod +x deploy-with-credentials.sh
chmod +x test-deployment.sh
chmod +x update-frontend-urls.sh
chmod +x performance-monitor.sh
chmod +x scale-vm.sh
```

### 2. Deploy Infrastructure
```bash
# This script automatically finds Azure credentials and deploys
./deploy-with-credentials.sh
```

### 3. Update Frontend URLs
```bash
# Replace with your actual VM FQDN from deployment output
./update-frontend-urls.sh sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com
```

### 4. Test Deployment
```bash
# Test all components and performance
./test-deployment.sh sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com
```

### 5. Monitor Performance
```bash
# Continuous performance monitoring
./performance-monitor.sh sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com
```

## Detailed Configuration

### VM Specifications for Zero Latency
```yaml
VM Size: Standard_B2s
CPU: 2 vCPUs (Intel/AMD)
Memory: 4 GB RAM
Storage: 32 GB Premium SSD
Network: Accelerated networking
Region: Israel Central
OS: Ubuntu 22.04 LTS
```

### Performance Optimizations Applied
- **CPU Governor**: Performance mode
- **Network Stack**: BBR congestion control
- **Audio Processing**: 16kHz sample rate, 1024-byte chunks
- **Connection Pooling**: Keep-alive for external APIs
- **Caching**: Redis for session management
- **Workers**: 2 uvicorn workers for concurrency

### Cost Analysis (Free Tier Optimized)
```
Monthly Costs:
- VM (B2s): $30.66
- Storage (32GB Premium): $5.12
- Bandwidth: $5-10
- Key Vault: $0.03
- Total: ~$41-46/month

Free Tier Benefits:
- $200 credit (first 12 months)
- 750 hours B1s compute (always free)
- 5GB blob storage (always free)
- 15GB bandwidth (always free)
```

## Architecture Overview

### Backend Deployment
- **Platform**: Azure VM with systemd service
- **Runtime**: Python 3.12 + uvicorn
- **Dependencies**: Azure SDK, Redis, Nginx
- **Security**: Azure Key Vault for API keys
- **Monitoring**: Application Insights integration

### Frontend Deployment  
- **Platform**: Azure Static Web Apps or VM-hosted
- **Build**: Vite + TypeScript + Tailwind CSS
- **CDN**: Azure CDN for global acceleration
- **SSL**: Let's Encrypt certificates

### API Integration
- **Deepgram STT**: Nova-3 model for optimal latency
- **DeepL Translation**: Professional API with caching
- **Azure Speech TTS**: Local region for minimal latency
- **Key Management**: Azure Key Vault with managed identity

## Security Configuration

### Network Security
- **NSG Rules**: SSH (22), HTTP (80), HTTPS (443), Backend (8000)
- **SSL/TLS**: Let's Encrypt with auto-renewal
- **Firewall**: UFW with minimal required ports
- **Access Control**: SSH key authentication only

### API Key Management
- **Storage**: Azure Key Vault (encrypted at rest)
- **Access**: Managed identity (no credentials in code)
- **Rotation**: Automated key rotation schedule
- **Monitoring**: Access logging and alerting

## Monitoring and Alerting

### Performance Metrics
- **Latency Tracking**: End-to-end pipeline timing
- **Resource Usage**: CPU, memory, disk, network
- **API Limits**: Rate limiting and quota monitoring
- **Error Rates**: Service availability and error tracking

### Alert Configuration
- CPU usage > 80% for 5 minutes
- Memory usage > 90% for 3 minutes
- API error rate > 5%
- End-to-end latency > 3 seconds

## Troubleshooting Guide

### Common Issues

1. **High Latency**
   - Check network connectivity to external APIs
   - Monitor CPU usage during audio processing
   - Verify Redis cache performance
   - Review audio chunk size configuration

2. **WebSocket Connection Failures**
   - Verify nginx WebSocket proxy configuration
   - Check firewall rules for port 443/80
   - Test SSL certificate validity
   - Monitor connection pool limits

3. **API Rate Limiting**
   - Implement exponential backoff
   - Add request caching layer
   - Monitor API usage quotas
   - Configure connection pooling

### Performance Tuning

1. **Scale Up VM**
   ```bash
   az vm resize --resource-group sts3-dev-rg --name sts3-dev-vm --size Standard_D2s_v5
   ```

2. **Optimize Audio Processing**
   - Reduce audio chunk size for lower latency
   - Increase sample rate for better quality
   - Implement audio compression

3. **Database Optimization**
   - Enable Redis persistence
   - Configure memory limits
   - Implement connection pooling

## Scaling Recommendations

### Single User (Current)
- **VM**: Standard_B2s (2 vCPU, 4GB RAM)
- **Storage**: 32GB Premium SSD
- **Network**: Standard networking
- **Cost**: ~$41/month

### Multiple Users (5-10)
- **VM**: Standard_D2s_v5 (2 vCPU, 8GB RAM)
- **Load Balancer**: Azure Load Balancer
- **Storage**: 64GB Premium SSD
- **Cost**: ~$70/month

### Production Scale (50+ Users)
- **VM**: Standard_D4s_v5 (4 vCPU, 16GB RAM)
- **Auto-scaling**: 2-5 instances
- **Database**: Azure Redis Cache
- **Cost**: ~$200-400/month

## Maintenance Schedule

### Daily
- Monitor performance metrics
- Check error logs
- Verify API key quotas

### Weekly  
- Review cost analysis
- Update security patches
- Test backup procedures

### Monthly
- Rotate API keys
- Review performance trends
- Optimize resource allocation

## Support and Documentation

### Useful Commands
```bash
# Check service status
sudo systemctl status sts3-backend

# View logs
journalctl -u sts3-backend -f

# Monitor resources
htop

# Test APIs
curl https://your-vm-fqdn/api/health
```

### Contact Information
- **Technical Issues**: Check troubleshooting guide
- **Performance Questions**: Review monitoring dashboard
- **Cost Optimization**: Analyze Azure Cost Management

This configuration provides optimal zero-latency performance for real-time simultaneous translation within free tier budget constraints, specifically optimized for the Israel region.
