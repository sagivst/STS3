# STS3 Azure Deployment Guide

## Overview
This directory contains Azure deployment configurations optimized for zero-latency performance in the Israel region with free tier budget constraints.

## Quick Start

### Prerequisites
- Azure subscription with free tier credits
- Existing API keys (Deepgram, DeepL, Azure Speech)

### One-Command Deployment

```bash
# Clone and deploy everything at once
git clone https://github.com/sagivst/STS3.git
cd STS3/azure-deployment
chmod +x quick-deploy.sh
./quick-deploy.sh
```

This script will:
1. Install Azure CLI if needed
2. Deploy VM infrastructure to Israel Central region
3. Configure zero-latency optimizations
4. Set up API keys from existing credentials
5. Test the complete deployment
6. Provide you with all URLs and access information

### Manual Deployment Steps

If you prefer step-by-step deployment:

1. **Deploy infrastructure**
   ```bash
   chmod +x deploy-with-credentials.sh
   ./deploy-with-credentials.sh
   ```

2. **Update frontend URLs**
   ```bash
   ./update-frontend-urls.sh YOUR_VM_FQDN
   ```

3. **Test deployment**
   ```bash
   ./test-deployment.sh YOUR_VM_FQDN
   ```

## Architecture

### VM Configuration
- **Size**: Standard_B2s (2 vCPUs, 4GB RAM)
- **Storage**: 32GB Premium SSD
- **Network**: Accelerated networking enabled
- **Region**: Israel Central
- **OS**: Ubuntu 22.04 LTS

### Performance Optimizations
- **CPU Governor**: Performance mode
- **Network**: BBR congestion control
- **Nginx**: HTTP/2, gzip compression, connection pooling
- **Redis**: Session management and caching
- **Uvicorn**: 2 workers for concurrent processing

### Security Features
- **SSL/TLS**: Let's Encrypt certificates
- **Firewall**: UFW with minimal required ports
- **Key Management**: Azure Key Vault integration
- **Network**: Network Security Groups (NSG)

## Monitoring

### System Monitoring
```bash
# SSH to VM
ssh azureuser@YOUR_VM_IP

# Run monitoring script
./monitor-sts3.sh
```

### Service Status
```bash
# Check service status
sudo systemctl status sts3-backend
sudo systemctl status nginx
sudo systemctl status redis-server

# View logs
journalctl -u sts3-backend -f
tail -f /var/log/nginx/access.log
```

### Performance Metrics
- **Target Latency**: <2 seconds end-to-end
- **CPU Usage**: <80% average
- **Memory Usage**: <90% peak
- **Network**: <100ms to Azure services

## Cost Analysis

### Monthly Costs (Free Tier)
- **VM (B2s)**: ~$31/month
- **Storage (32GB Premium SSD)**: ~$5/month
- **Bandwidth**: ~$5-10/month
- **Total**: ~$41-46/month (within $200 free tier)

### Cost Optimization
- Auto-shutdown during off-hours
- Reserved instances for production
- Spot instances for development

## Troubleshooting

### Common Issues

1. **Backend not starting**
   ```bash
   sudo systemctl status sts3-backend
   journalctl -u sts3-backend --no-pager -n 20
   ```

2. **SSL certificate issues**
   ```bash
   sudo certbot renew --dry-run
   sudo nginx -t
   ```

3. **WebSocket connection failures**
   ```bash
   # Check nginx configuration
   sudo nginx -t
   # Check firewall
   sudo ufw status
   ```

4. **High latency**
   ```bash
   # Check network performance
   ping google.com
   # Check CPU usage
   htop
   # Check memory usage
   free -h
   ```

### Performance Tuning

1. **Scale up VM size**
   ```bash
   az vm resize --resource-group sts3-dev-rg --name sts3-dev-vm --size Standard_D2s_v5
   ```

2. **Add more workers**
   ```bash
   # Edit systemd service
   sudo systemctl edit sts3-backend
   # Add: ExecStart=/path/to/uvicorn app.main:app --workers 4
   ```

3. **Enable Redis clustering**
   ```bash
   # For high availability
   sudo apt install redis-sentinel
   ```

## Scaling

### Horizontal Scaling
- Azure Load Balancer
- Multiple VM instances
- Redis cluster for session sharing

### Vertical Scaling
- Upgrade to D-series VMs
- Add GPU for advanced audio processing
- Premium storage for better I/O

## Security

### Best Practices
- Regular security updates
- Key rotation schedule
- Network access restrictions
- Monitoring and alerting

### Compliance
- Data encryption at rest and in transit
- Audit logging enabled
- Access control with Azure AD

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review Azure Monitor logs
3. Contact the development team

## Version History

- **v1.0**: Initial Azure deployment with B2s VM
- **v1.1**: Added Key Vault integration
- **v1.2**: Performance optimizations for zero latency
