export const config = {
    apiKey: process.env.API_KEY || 'your-api-key-here',
    jupiterApiUrl: 'https://api.jupiter.com',
    solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    tradingPairs: ['SOL/USDC', 'ETH/USDC'],
    profitThreshold: 0.01,
    slippageTolerance: 0.005,
    orderBookRefreshInterval: 5000,
};