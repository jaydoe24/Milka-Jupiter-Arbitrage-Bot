#!/bin/bash

echo "📋 Showing bot logs (Ctrl+C to exit)..."
echo ""

cd "$(dirname "$0")/.." && docker-compose -f docker/docker-compose.yml logs -f --tail=100