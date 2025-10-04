#!/bin/bash

# STS3 Installation Script for Azure VM
# Run this script on your Azure VM as root or with sudo

set -e

echo "🚀 Installing STS3 Updates..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root or with sudo${NC}"
    exit 1
fi

# 1. Update Frontend
echo -e "${BLUE}📦 Updating Frontend...${NC}"
if [ -d "/var/www/sts3" ]; then
    rm -rf /var/www/sts3/*
    cp -r frontend-dist/* /var/www/sts3/
    echo -e "${GREEN}✓ Frontend updated${NC}"
else
    echo -e "${RED}✗ /var/www/sts3 directory not found${NC}"
    echo "Creating directory..."
    mkdir -p /var/www/sts3
    cp -r frontend-dist/* /var/www/sts3/
fi

# 2. Update Backend
echo -e "${BLUE}📦 Updating Backend...${NC}"
if [ -d "/opt/sts3-backend" ]; then
    rm -rf /opt/sts3-backend/app
    cp -r backend-app /opt/sts3-backend/app
    echo -e "${GREEN}✓ Backend updated${NC}"
else
    echo -e "${RED}✗ /opt/sts3-backend directory not found${NC}"
    echo "Creating directory..."
    mkdir -p /opt/sts3-backend
    cp -r backend-app /opt/sts3-backend/app
fi

# 3. Set proper permissions
echo -e "${BLUE}🔒 Setting permissions...${NC}"
chown -R www-data:www-data /var/www/sts3
chown -R azureuser:azureuser /opt/sts3-backend
chmod -R 755 /var/www/sts3
echo -e "${GREEN}✓ Permissions set${NC}"

# 4. Restart services
echo -e "${BLUE}🔄 Restarting services...${NC}"
if systemctl is-active --quiet sts3-backend; then
    systemctl restart sts3-backend
    echo -e "${GREEN}✓ Backend service restarted${NC}"
else
    echo -e "${RED}⚠ Backend service not found - you may need to set it up first${NC}"
fi

if systemctl is-active --quiet nginx; then
    systemctl restart nginx
    echo -e "${GREEN}✓ Nginx restarted${NC}"
else
    echo -e "${RED}⚠ Nginx not found${NC}"
fi

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo -e "${BLUE}Access your application:${NC}"
echo "Frontend: https://$(hostname -f)"
echo "Backend API: https://$(hostname -f)/api"
