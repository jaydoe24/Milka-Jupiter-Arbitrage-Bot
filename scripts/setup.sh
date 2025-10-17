#!/bin/bash

echo "═══════════════════════════════════════════════════════"
echo "  Milka Jupiter Arbitrage Bot - Setup"
echo "═══════════════════════════════════════════════════════"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Installing..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    echo "✅ Docker installed"
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose not found. Installing..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "✅ Docker Compose installed"
fi

# Create .env from example if it doesn't exist
if [ ! -f config/.env ]; then
    echo "📝 Creating config/.env from example..."
    cp config/.env.example config/.env
    echo "⚠️  IMPORTANT: Edit config/.env with your settings!"
    echo "   nano config/.env"
fi

# Create logs directory
mkdir -p logs

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit config/.env with your RPC and wallet details"
echo "2. Run: ./scripts/start.sh"
echo ""