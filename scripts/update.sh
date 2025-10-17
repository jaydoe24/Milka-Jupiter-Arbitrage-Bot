#!/bin/bash

echo "🔄 Updating Milka Jupiter Arbitrage Bot..."

# Pull latest changes from GitHub
git pull origin main

# Rebuild Docker container
cd "$(dirname "$0")/.." && docker-compose -f docker/docker-compose.yml up -d --build

echo "✅ Update complete!"
echo ""
echo "View logs: ./scripts/logs.sh"