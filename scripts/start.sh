#!/bin/bash

echo "🚀 Starting Milka Jupiter Arbitrage Bot..."

# Check if .env exists
if [ ! -f config/.env ]; then
    echo "❌ config/.env not found!"
    echo "   Run: ./scripts/setup.sh first"
    exit 1
fi

# Build and start Docker container
cd "$(dirname "$0")/.." && docker-compose -f docker/docker-compose.yml up -d --build

echo ""
echo "✅ Bot started successfully!"
echo ""
echo "View logs: ./scripts/logs.sh"
echo "Check status: docker ps"
echo "Stop bot: ./scripts/stop.sh"
echo ""