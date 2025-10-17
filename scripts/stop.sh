#!/bin/bash

echo "🛑 Stopping Milka Jupiter Arbitrage Bot..."

cd "$(dirname "$0")/.." && docker-compose -f docker/docker-compose.yml down

echo "✅ Bot stopped"