#!/bin/bash


RESOURCE_GROUP="sts3-dev-rg"
VM_NAME="sts3-dev-vm"
CURRENT_SIZE="$1"
TARGET_SIZE="$2"

if [ -z "$TARGET_SIZE" ]; then
    echo "Usage: $0 <current-size> <target-size>"
    echo
    echo "Available VM sizes for zero-latency performance:"
    echo "  Standard_B1ms  - 1 vCPU, 2GB RAM  (~\$15/month) - Testing only"
    echo "  Standard_B2s   - 2 vCPU, 4GB RAM  (~\$31/month) - Single user"
    echo "  Standard_D2s_v5 - 2 vCPU, 8GB RAM  (~\$70/month) - Multiple users"
    echo "  Standard_D4s_v5 - 4 vCPU, 16GB RAM (~\$140/month) - Production"
    echo
    echo "Example: $0 Standard_B2s Standard_D2s_v5"
    exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Scaling STS3 VM for Zero-Latency Performance${NC}"
echo "Resource Group: $RESOURCE_GROUP"
echo "VM Name: $VM_NAME"
echo "Current Size: $CURRENT_SIZE"
echo "Target Size: $TARGET_SIZE"
echo

case "$TARGET_SIZE" in
    "Standard_B1ms"|"Standard_B2s"|"Standard_D2s_v5"|"Standard_D4s_v5")
        echo -e "${GREEN}✓ Valid VM size selected${NC}"
        ;;
    *)
        echo -e "${RED}✗ Invalid VM size. Use one of the recommended sizes.${NC}"
        exit 1
        ;;
esac

if ! command -v az &> /dev/null; then
    echo -e "${RED}Azure CLI is not installed${NC}"
    exit 1
fi

if ! az account show &> /dev/null; then
    echo -e "${YELLOW}Please login to Azure first: az login${NC}"
    exit 1
fi

echo -e "${YELLOW}Stopping VM...${NC}"
az vm stop --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"

echo -e "${YELLOW}Deallocating VM...${NC}"
az vm deallocate --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"

echo -e "${YELLOW}Resizing VM to $TARGET_SIZE...${NC}"
az vm resize --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --size "$TARGET_SIZE"

echo -e "${YELLOW}Starting VM...${NC}"
az vm start --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"

echo -e "${YELLOW}Waiting for VM to be ready...${NC}"
sleep 60

VM_INFO=$(az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --show-details --output json)
VM_IP=$(echo "$VM_INFO" | jq -r '.publicIps')
VM_FQDN=$(echo "$VM_INFO" | jq -r '.fqdns')

echo -e "${GREEN}VM scaling completed successfully!${NC}"
echo
echo "VM Details:"
echo "  Size: $TARGET_SIZE"
echo "  Public IP: $VM_IP"
echo "  FQDN: $VM_FQDN"
echo

case "$TARGET_SIZE" in
    "Standard_B1ms")
        echo "Performance Expectations:"
        echo "  - Suitable for: Testing only"
        echo "  - Concurrent users: 1"
        echo "  - Expected latency: 2-3 seconds"
        echo "  - Monthly cost: ~\$15"
        ;;
    "Standard_B2s")
        echo "Performance Expectations:"
        echo "  - Suitable for: Single user testing"
        echo "  - Concurrent users: 1-2"
        echo "  - Expected latency: 1.5-2 seconds"
        echo "  - Monthly cost: ~\$31"
        ;;
    "Standard_D2s_v5")
        echo "Performance Expectations:"
        echo "  - Suitable for: Multiple users"
        echo "  - Concurrent users: 3-5"
        echo "  - Expected latency: 1-1.5 seconds"
        echo "  - Monthly cost: ~\$70"
        ;;
    "Standard_D4s_v5")
        echo "Performance Expectations:"
        echo "  - Suitable for: Production workload"
        echo "  - Concurrent users: 5-10"
        echo "  - Expected latency: <1 second"
        echo "  - Monthly cost: ~\$140"
        ;;
esac

echo
echo "Next steps:"
echo "1. Test the application: https://$VM_FQDN"
echo "2. Monitor performance: ./performance-monitor.sh $VM_FQDN"
echo "3. Run load tests if needed"
