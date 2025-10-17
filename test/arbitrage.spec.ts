import { ArbitrageStrategy } from '../src/strategies/arbitrageStrategy';

describe('ArbitrageStrategy', () => {
    let strategy: ArbitrageStrategy;

    beforeEach(() => {
        strategy = new ArbitrageStrategy();
    });

    it('should identify arbitrage opportunities correctly', () => {
        const marketData = [
            { price: 100, exchange: 'ExchangeA' },
            { price: 95, exchange: 'ExchangeB' }
        ];
        const opportunities = strategy.identifyOpportunities(marketData);
        expect(opportunities).toEqual([{ profit: 5, from: 'ExchangeB', to: 'ExchangeA' }]);
    });

    it('should execute trades correctly', async () => {
        const tradeDetails = { from: 'ExchangeB', to: 'ExchangeA', amount: 1 };
        const result = await strategy.executeTrade(tradeDetails);
        expect(result).toBeTruthy();
    });

    it('should calculate profit margins correctly', () => {
        const profit = strategy.calculateProfit(100, 95);
        expect(profit).toBe(5);
    });
});