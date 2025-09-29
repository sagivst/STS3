#!/bin/bash


set -e

VM_FQDN="$1"
if [ -z "$VM_FQDN" ]; then
    echo "Usage: $0 <vm-fqdn>"
    echo "Example: $0 sts3-dev-vm-abc123.israelcentral.cloudapp.azure.com"
    exit 1
fi

BACKEND_URL="https://$VM_FQDN/api"
FRONTEND_URL="https://$VM_FQDN"
WS_URL="wss://$VM_FQDN/ws"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Testing STS3 Azure Deployment...${NC}"
echo "Backend URL: $BACKEND_URL"
echo "Frontend URL: $FRONTEND_URL"
echo "WebSocket URL: $WS_URL"
echo

echo -e "${YELLOW}Test 1: Backend Health Check${NC}"
HEALTH_RESPONSE=$(curl -s -w "%{http_code}" "$BACKEND_URL/health" -o /tmp/health_response.json)
HTTP_CODE="${HEALTH_RESPONSE: -3}"

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Backend health check passed${NC}"
    cat /tmp/health_response.json | jq '.'
else
    echo -e "${RED}✗ Backend health check failed (HTTP $HTTP_CODE)${NC}"
    cat /tmp/health_response.json 2>/dev/null || echo "No response body"
fi
echo

echo -e "${YELLOW}Test 2: Frontend Accessibility${NC}"
FRONTEND_RESPONSE=$(curl -s -w "%{http_code}" "$FRONTEND_URL" -o /dev/null)
HTTP_CODE="${FRONTEND_RESPONSE: -3}"

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ Frontend accessible${NC}"
else
    echo -e "${RED}✗ Frontend not accessible (HTTP $HTTP_CODE)${NC}"
fi
echo

echo -e "${YELLOW}Test 3: SSL Certificate${NC}"
SSL_INFO=$(echo | openssl s_client -servername "$VM_FQDN" -connect "$VM_FQDN:443" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ SSL certificate valid${NC}"
    echo "$SSL_INFO"
else
    echo -e "${RED}✗ SSL certificate issues${NC}"
fi
echo

echo -e "${YELLOW}Test 4: WebSocket Connection Test${NC}"
if command -v websocat &> /dev/null; then
    echo '{"type":"join_room","room":"test","language":"en"}' | timeout 5 websocat "$WS_URL" &>/dev/null
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ WebSocket connection successful${NC}"
    else
        echo -e "${RED}✗ WebSocket connection failed${NC}"
    fi
else
    echo -e "${YELLOW}⚠ WebSocket test skipped (websocat not available)${NC}"
fi
echo

echo -e "${YELLOW}Test 5: Performance Metrics${NC}"
LATENCY_RESPONSE=$(curl -s "$BACKEND_URL/latency" 2>/dev/null)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Latency endpoint accessible${NC}"
    echo "$LATENCY_RESPONSE" | jq '.' 2>/dev/null || echo "$LATENCY_RESPONSE"
else
    echo -e "${RED}✗ Latency endpoint not accessible${NC}"
fi
echo

echo -e "${YELLOW}Test 6: Individual Service Tests${NC}"

echo "Testing DeepL Translation..."
DEEPL_TEST=$(curl -s -X POST "$BACKEND_URL/test-deepl" \
    -H "Content-Type: application/json" \
    -d '{"text":"Hello world","source_lang":"EN","target_lang":"JA"}' 2>/dev/null)
if echo "$DEEPL_TEST" | jq -e '.translation' >/dev/null 2>&1; then
    echo -e "${GREEN}✓ DeepL translation working${NC}"
    echo "$DEEPL_TEST" | jq '.translation'
else
    echo -e "${RED}✗ DeepL translation failed${NC}"
fi

echo "Testing Azure TTS..."
AZURE_TTS_TEST=$(curl -s -X POST "$BACKEND_URL/test-azure-tts" \
    -H "Content-Type: application/json" \
    -d '{"text":"Hello world","language":"en-US"}' 2>/dev/null)
if echo "$AZURE_TTS_TEST" | jq -e '.audio_url' >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Azure TTS working${NC}"
else
    echo -e "${RED}✗ Azure TTS failed${NC}"
fi
echo

echo -e "${YELLOW}Test 7: Simple Load Test${NC}"
echo "Sending 5 concurrent requests to health endpoint..."
for i in {1..5}; do
    curl -s "$BACKEND_URL/health" >/dev/null &
done
wait
echo -e "${GREEN}✓ Load test completed${NC}"
echo

echo -e "${GREEN}=== Deployment Test Summary ===${NC}"
echo "Deployment URL: $FRONTEND_URL"
echo "Backend API: $BACKEND_URL"
echo "WebSocket: $WS_URL"
echo
echo "Next steps:"
echo "1. Test complete audio pipeline with real microphone"
echo "2. Monitor performance metrics"
echo "3. Configure SSL certificate if needed"
echo "4. Set up monitoring and alerting"

rm -f /tmp/health_response.json
