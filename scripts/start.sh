#!/bin/bash

# Navigate to the project directory
cd "$(dirname "$0")/.."

# Load environment variables from .env file
if [ -f .env ]; then
    export $(cat .env | xargs)
fi

# Start the TypeScript compiler in watch mode
tsc -w &

# Run the bot
node dist/index.js