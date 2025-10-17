export function calculateProfitMargin(costPrice: number, sellingPrice: number): number {
    if (costPrice <= 0) {
        throw new Error("Cost price must be greater than zero.");
    }
    return ((sellingPrice - costPrice) / costPrice) * 100;
}

export function priceDifference(price1: number, price2: number): number {
    return Math.abs(price1 - price2);
}

export function averagePrice(prices: number[]): number {
    if (prices.length === 0) {
        throw new Error("Price array cannot be empty.");
    }
    const total = prices.reduce((acc, price) => acc + price, 0);
    return total / prices.length;
}