export interface ArbitrageOpportunity {
    id: string;
    profit: number;
    sourceExchange: string;
    targetExchange: string;
    asset: string;
    priceDifference: number;
}

export interface Trade {
    id: string;
    asset: string;
    amount: number;
    price: number;
    exchange: string;
    timestamp: Date;
}

export interface Config {
    jupiterApiKey: string;
    solanaCluster: string;
    tradingPairs: string[];
    profitThreshold: number;
}

export interface OrderBook {
    bids: Array<{ price: number; amount: number }>;
    asks: Array<{ price: number; amount: number }>;
}

export interface Exchange {
    name: string;
    apiUrl: string;
    tradingFee: number;
}