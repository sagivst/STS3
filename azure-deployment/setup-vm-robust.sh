#!/bin/bash

set -e

echo "Starting STS3 application setup..."
echo "Ubuntu version: $(lsb_release -d)"

retry_command() {
    local max_attempts=3
    local delay=5
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if "$@"; then
            return 0
        else
            echo "Attempt $attempt failed. Retrying in $delay seconds..."
            sleep $delay
            attempt=$((attempt + 1))
        fi
    done
    
    echo "Command failed after $max_attempts attempts: $*"
    return 1
}

echo "Updating package lists..."
retry_command sudo apt-get update

echo "Installing essential packages..."
sudo apt-get install -y \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    gnupg \
    lsb-release \
    curl \
    wget

echo "Adding universe repository..."
sudo add-apt-repository universe -y
retry_command sudo apt-get update

echo "Installing Python and development tools..."
sudo apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    git \
    unzip \
    htop \
    build-essential

echo "Installing audio libraries..."
sudo apt-get install -y \
    libasound2-dev \
    portaudio19-dev \
    ffmpeg

echo "Installing utilities..."
sudo apt-get install -y jq

echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "Installing nginx..."
sudo apt-get install -y nginx

echo "Installing certbot..."
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

echo "Installing Redis..."
sudo apt-get install -y redis-server

echo "Installing Poetry..."
curl -sSL https://install.python-poetry.org | python3 -
export PATH="/home/azureuser/.local/bin:$PATH"
echo 'export PATH="/home/azureuser/.local/bin:$PATH"' >> /home/azureuser/.bashrc

echo "Cloning STS3 repository..."
cd /home/azureuser
git clone -b devin/1758881542-individual-component-tests https://github.com/sagivst/STS3.git
cd STS3

echo "Checking repository structure..."
ls -la
echo "Looking for backend directory..."
find . -name "*backend*" -o -name "*translation*" -type d

echo "Setting up backend..."
if [ -d "translation-backend" ]; then
    cd translation-backend
elif [ -d "backend" ]; then
    cd backend
else
    echo "ERROR: Could not find backend directory"
    ls -la
    exit 1
fi
python3 -m venv venv
source venv/bin/activate

pip install --upgrade pip
pip install poetry

pip install azure-keyvault-secrets azure-identity azure-storage-blob

poetry install

cat > .env << 'EOF'
AZURE_KEY_VAULT_URL=https://sts3-dev-kv-${UNIQUE_SUFFIX}.vault.azure.net/
AZURE_STORAGE_ACCOUNT=sts3devstorage${UNIQUE_SUFFIX}
AZURE_STORAGE_CONTAINER=audio-files
AZURE_SPEECH_REGION=germanywestcentral

ENVIRONMENT=production
LOG_LEVEL=INFO
REDIS_URL=redis://localhost:6379

CORS_ORIGINS=["https://${FRONTEND_DOMAIN}"]

UVICORN_WORKERS=2
UVICORN_HOST=0.0.0.0
UVICORN_PORT=8000

AUDIO_SAMPLE_RATE=16000
AUDIO_CHUNK_SIZE=1024
MAX_AUDIO_DURATION=300

DEEPGRAM_MAX_CONCURRENT=3
DEEPL_RATE_LIMIT=50
AZURE_TTS_RATE_LIMIT=25
EOF

sudo tee /etc/systemd/system/sts3-backend.service > /dev/null << 'EOF'
[Unit]
Description=STS3 Backend Service
After=network.target redis.service

[Service]
Type=exec
User=azureuser
Group=azureuser
WorkingDirectory=/home/azureuser/STS3/translation-backend
Environment=PATH=/home/azureuser/STS3/translation-backend/venv/bin
EnvironmentFile=/home/azureuser/STS3/translation-backend/.env
ExecStart=/home/azureuser/STS3/translation-backend/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "Setting up frontend..."
cd ..
if [ -d "translation-frontend" ]; then
    cd translation-frontend
elif [ -d "frontend" ]; then
    cd frontend
else
    echo "ERROR: Could not find frontend directory"
    ls -la
    exit 1
fi
npm install
npm run build

echo "Configuring nginx..."
sudo tee /etc/nginx/sites-available/sts3 > /dev/null << 'EOF'
upstream backend {
    server 127.0.0.1:8000;
    keepalive 32;
}

server {
    listen 80;
    server_name _;
    
    location / {
        root /home/azureuser/STS3/translation-frontend/dist;
        try_files $uri $uri/ /index.html;
        
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
    
    location /api/ {
        proxy_pass http://backend/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    location /ws {
        proxy_pass http://backend/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
    
    location /health {
        proxy_pass http://backend/health;
        access_log off;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/sts3 /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo "Configuring Redis..."
sudo tee -a /etc/redis/redis.conf > /dev/null << 'EOF'

maxmemory 256mb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
save 60 10000
EOF

echo "Starting services..."
sudo systemctl enable redis-server
sudo systemctl start redis-server
sudo systemctl enable nginx
sudo systemctl start nginx
sudo systemctl enable sts3-backend
sudo systemctl start sts3-backend

echo "Configuring firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

cat > /home/azureuser/monitor-sts3.sh << 'EOF'
#!/bin/bash

echo "=== STS3 System Status ==="
echo "Date: $(date)"
echo

echo "=== Service Status ==="
systemctl is-active sts3-backend
systemctl is-active nginx
systemctl is-active redis-server
echo

echo "=== Resource Usage ==="
echo "CPU Usage:"
top -bn1 | grep "Cpu(s)" | awk '{print $2 + $4"%"}'
echo "Memory Usage:"
free -h | awk 'NR==2{printf "%.1f%%\n", $3*100/$2}'
echo "Disk Usage:"
df -h / | awk 'NR==2{print $5}'
echo

echo "=== Network Connections ==="
netstat -tuln | grep -E ':80|:443|:8000|:6379'
echo

echo "=== Backend Health ==="
curl -s http://localhost:8000/health || echo "Backend health check failed"
echo

echo "=== Recent Logs ==="
echo "Backend logs (last 5 lines):"
journalctl -u sts3-backend --no-pager -n 5
echo
echo "Nginx error logs (last 5 lines):"
tail -n 5 /var/log/nginx/error.log 2>/dev/null || echo "No nginx errors"
EOF

chmod +x /home/azureuser/monitor-sts3.sh

cat > /home/azureuser/tune-performance.sh << 'EOF'
#!/bin/bash

echo "Applying performance optimizations..."

echo 'net.core.rmem_max = 16777216' | sudo tee -a /etc/sysctl.conf
echo 'net.core.wmem_max = 16777216' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_rmem = 4096 87380 16777216' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_wmem = 4096 65536 16777216' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv4.tcp_congestion_control = bbr' | sudo tee -a /etc/sysctl.conf

sudo sysctl -p

echo 'performance' | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

echo "Performance tuning applied!"
EOF

chmod +x /home/azureuser/tune-performance.sh

/home/azureuser/tune-performance.sh

sudo tee /etc/logrotate.d/sts3 > /dev/null << 'EOF'
/var/log/sts3/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 azureuser azureuser
    postrotate
        systemctl reload sts3-backend
    endscript
}
EOF

sudo mkdir -p /var/log/sts3
sudo chown azureuser:azureuser /var/log/sts3

chown -R azureuser:azureuser /home/azureuser/STS3

touch /home/azureuser/STS3/setup-complete

echo "STS3 setup completed successfully!"
echo "Next steps:"
echo "1. Configure SSL certificate with: sudo certbot --nginx"
echo "2. Set environment variables in /home/azureuser/STS3/translation-backend/.env"
echo "3. Restart services: sudo systemctl restart sts3-backend nginx"
echo "4. Monitor with: /home/azureuser/monitor-sts3.sh"
