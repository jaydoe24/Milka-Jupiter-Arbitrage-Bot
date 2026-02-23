# Use Node.js 20 LTS
FROM node:20-alpine
# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git
# Set working directory
WORKDIR /app
# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
# Install dependencies
RUN npm install && npm cache clean --force
# Copy source code
COPY src/ ./src/
# Build TypeScript
RUN npm run build
# Create logs directory
RUN mkdir -p logs
# Set environment
ENV NODE_ENV=production
# Run bot
CMD ["node", "dist/bot.js"]
