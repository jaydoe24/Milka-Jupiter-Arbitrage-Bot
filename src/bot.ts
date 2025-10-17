// This file contains the main bot code, including the logic for executing arbitrage strategies and managing the bot's lifecycle.

import { ArbitrageStrategy } from './strategies/arbitrageStrategy';
import { ExchangeConnector } from './connectors/exchangeConnector';
import { loadConfig } from './config/default';

class MilkaJupiterArbitrageBot {
    private strategy: ArbitrageStrategy;
    private connector: ExchangeConnector;
    private config: any;

    constructor() {
        this.config = loadConfig();
        this.connector = new ExchangeConnector(this.config);
        this.strategy = new ArbitrageStrategy(this.connector);
    }

    public async start() {
        console.log('Starting Milka Jupiter Arbitrage Bot...');
        await this.connector.connect();
        this.runArbitrage();
    }

    private async runArbitrage() {
        try {
            while (true) {
                const opportunities = await this.strategy.findOpportunities();
                if (opportunities.length > 0) {
                    await this.strategy.executeOpportunities(opportunities);
                }
                await this.sleep(5000); // Wait for 5 seconds before checking again
            }
        } catch (error) {
            console.error('Error in arbitrage execution:', error);
        }
    }

    private sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const bot = new MilkaJupiterArbitrageBot();
bot.start();