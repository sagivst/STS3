#!/bin/bash


VM_FQDN="$1"
if [ -z "$VM_FQDN" ]; then
    echo "Usage: $0 <vm-fqdn>"
    echo "Example: $0 sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com"
    exit 1
fi

BACKEND_URL="https://$VM_FQDN/api"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}STS3 Performance Monitor${NC}"
echo "Monitoring: $VM_FQDN"
echo "Started: $(date)"
echo "Target: <2 seconds end-to-end latency"
echo

test_latency() {
    local start_time=$(date +%s%3N)
    local response=$(curl -s -w "%{time_total}" "$BACKEND_URL/health" -o /dev/null)
    local end_time=$(date +%s%3N)
    local total_time=$((end_time - start_time))
    echo "$total_time"
}

get_service_metrics() {
    curl -s "$BACKEND_URL/latency" 2>/dev/null | jq -r '.deepgram, .deepl, .azure_tts' 2>/dev/null || echo "0 0 0"
}

check_system_resources() {
    ssh -o StrictHostKeyChecking=no azureuser@"$VM_FQDN" "
        echo 'CPU:' \$(top -bn1 | grep 'Cpu(s)' | awk '{print \$2 + \$4\"%\"}')
        echo 'Memory:' \$(free -h | awk 'NR==2{printf \"%.1f%%\", \$3*100/\$2}')
        echo 'Disk:' \$(df -h / | awk 'NR==2{print \$5}')
    " 2>/dev/null
}

echo -e "${YELLOW}Starting continuous monitoring (Ctrl+C to stop)...${NC}"
echo

while true; do
    clear
    echo -e "${BLUE}STS3 Performance Monitor - $(date)${NC}"
    echo "Target: <2000ms end-to-end | VM: $VM_FQDN"
    echo "=================================================="
    
    api_latency=$(test_latency)
    if [ "$api_latency" -lt 1000 ]; then
        latency_color=$GREEN
    elif [ "$api_latency" -lt 2000 ]; then
        latency_color=$YELLOW
    else
        latency_color=$RED
    fi
    
    echo -e "API Response Time: ${latency_color}${api_latency}ms${NC}"
    
    service_metrics=$(get_service_metrics)
    if [ "$service_metrics" != "0 0 0" ]; then
        deepgram_ms=$(echo "$service_metrics" | awk '{print $1}')
        deepl_ms=$(echo "$service_metrics" | awk '{print $2}')
        azure_tts_ms=$(echo "$service_metrics" | awk '{print $3}')
        total_services=$((deepgram_ms + deepl_ms + azure_tts_ms))
        
        echo "Service Latencies:"
        echo "  Deepgram STT: ${deepgram_ms}ms"
        echo "  DeepL Translation: ${deepl_ms}ms"
        echo "  Azure TTS: ${azure_tts_ms}ms"
        echo "  Total Services: ${total_services}ms"
    fi
    
    echo
    echo "System Resources:"
    check_system_resources
    
    echo
    health_status=$(curl -s "$BACKEND_URL/health" | jq -r '.status' 2>/dev/null || echo "unknown")
    if [ "$health_status" = "healthy" ]; then
        echo -e "Health Status: ${GREEN}$health_status${NC}"
    else
        echo -e "Health Status: ${RED}$health_status${NC}"
    fi
    
    echo
    if [ "$api_latency" -lt 2000 ]; then
        echo -e "Performance: ${GREEN}✓ Meeting zero-latency target${NC}"
    else
        echo -e "Performance: ${RED}✗ Exceeding latency target${NC}"
        echo "Recommendations:"
        echo "  - Check network connectivity"
        echo "  - Monitor CPU/memory usage"
        echo "  - Consider VM scaling"
    fi
    
    echo
    echo "Press Ctrl+C to stop monitoring..."
    
    sleep 5
done
