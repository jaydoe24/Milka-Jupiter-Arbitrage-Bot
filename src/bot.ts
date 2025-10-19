import { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../config/.env') });

/**
 * Production Solana MEV Arbitrage Bot
 * With Helius Sender Integration
 */

interface Config {
  rpcUrl: string;
  wsUrl: string;
  privateKey: string;
  tradeAmount: number;
  minProfitPercent: number;
  maxPriceImpact: number;
  slippageBps: number;
  enableLogging: boolean;
  logLevel: string;
  senderMode: string;
  senderTipLamports: number;
}

interface ArbitrageOpportunity {
  tokenMint: string;
  tokenSymbol: string;
  estimatedProfit: number;
  profitPercent: number;
  buyQuote: any;
  sellQuote: any;
}

interface TradeStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  lastTradeTime: number;
}

class Logger {
  private logLevel: string;
  private logDir: string;

  constructor(logLevel: string = 'info', logDir: string = './logs') {
    this.logLevel = logLevel;
    this.logDir = logDir;
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  private writeLog(level: string, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = data 
      ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(data)}`
      : `[${timestamp}] [${level}] ${message}`;
    
    const colors: any = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      warning: '\x1b[33m',
      error: '\x1b[31m',
      debug: '\x1b[90m'
    };
    
    console.log(`${colors[level] || ''}${logMessage}\x1b[0m`);
    
    const logFile = path.join(this.logDir, `${level}.log`);
    fs.appendFileSync(logFile, logMessage + '\n');
  }

  info(message: string, data?: any) { this.writeLog('info', message, data); }
  success(message: string, data?: any) { this.writeLog('success', message, data); }
  warning(message: string, data?: any) { this.writeLog('warning', message, data); }
  error(message: string, data?: any) { this.writeLog('error', message, data); }
  debug(message: string, data?: any) {
    if (this.logLevel === 'debug') {
      this.writeLog('debug', message, data);
    }
  }
}

class PerformanceTracker {
  private stats: TradeStats = {
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalProfit: 0,
    totalLoss: 0,
    netProfit: 0,
    lastTradeTime: 0
  };

  private statsFile: string;
  private logger: Logger;

  constructor(logger: Logger, statsFile: string = './logs/stats.json') {
    this.logger = logger;
    this.statsFile = statsFile;
    this.loadStats();
  }

  private loadStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        const data = fs.readFileSync(this.statsFile, 'utf8');
        this.stats = JSON.parse(data);
      }
    } catch (error) {
      this.logger.warning('Could not load stats, starting fresh');
    }
  }

  private saveStats() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      this.logger.error('Failed to save stats', error);
    }
  }

  recordTrade(success: boolean, profit: number) {
    this.stats.totalTrades++;
    this.stats.lastTradeTime = Date.now();
    
    if (success) {
      this.stats.successfulTrades++;
      if (profit > 0) {
        this.stats.totalProfit += profit;
      } else {
        this.stats.totalLoss += Math.abs(profit);
      }
    } else {
      this.stats.failedTrades++;
    }
    
    this.stats.netProfit = this.stats.totalProfit - this.stats.totalLoss;
    this.saveStats();
  }

  getStats(): TradeStats {
    return { ...this.stats };
  }

  printDailySummary() {
    const successRate = this.stats.totalTrades > 0 
      ? (this.stats.successfulTrades / this.stats.totalTrades * 100).toFixed(2)
      : '0.00';
    
    this.logger.info('═══════════════════════════════════════════════════');
    this.logger.info('                 DAILY SUMMARY                     ');
    this.logger.info('═══════════════════════════════════════════════════');
    this.logger.info(`Total Trades: ${this.stats.totalTrades}`);
    this.logger.info(`Successful: ${this.stats.successfulTrades} | Failed: ${this.stats.failedTrades}`);
    this.logger.info(`Success Rate: ${successRate}%`);
    this.logger.info(`Total Profit: ${this.stats.totalProfit.toFixed(4)} SOL`);
    this.logger.info(`Total Loss: ${this.stats.totalLoss.toFixed(4)} SOL`);
    this.logger.info(`Net Profit: ${this.stats.netProfit.toFixed(4)} SOL`);
    this.logger.info('═══════════════════════════════════════════════════');
  }
}

class JupiterArbitrageBotProduction {
  private connection: Connection;
  private wallet: Wallet;
  private config: Config;
  private logger: Logger;
  private performanceTracker: PerformanceTracker;
  
  private wsol: string = 'So11111111111111111111111111111111111111112';
  private isRunning: boolean = false;
  private lastTradeTime: number = 0;
  private minTimeBetweenTrades: number = 1000;
  
  // Circuit breaker
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailures: number = 5;
  private circuitBreakerTripped: boolean = false;

  // Helius Sender tip accounts
  private tipAccounts: string[] = [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShghqhAnLnzW862bkgBkgBgkEMcJNYrVAR4stB',
    '5VV1ws6t6DiNz5FogJVV2BpqiNWZvpbPBSFNNacJJfUc',
    '2nyhqdwcFK5JBVqQvXvL9JNqW2GNLvzJPkUBqiqgvqwK',
    'wyvKWWYZP8KFqUTpYLgqBCT6Xvh8p6cWzHHMMMECvgD',
    '3KKozDAaFaF4SJUE3jTg2zRG3n8J88ioQLy4JLw7zsVh',
    '4vieeGHPYPG2MyupPRCjj4dummN3wmypPRCYj4i1DmmN',
    '4TQkfNhMmAbsJfNLwrYdgcniBPJUWdWzFjLJUNQKecYr',
    '3MWeKLHhPKvFcUPd77aHcoBXC71jfmQCzVDYzgD5K46y'
  ];

  constructor() {
    this.config = this.loadConfig();
    this.logger = new Logger(this.config.logLevel);
    this.performanceTracker = new PerformanceTracker(this.logger);
    
    // Initialize Solana connection with Helius Sender endpoint
    this.connection = new Connection(this.config.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: this.config.wsUrl,
      confirmTransactionInitialTimeout: 60000
    });
    
    // Initialize wallet
    const keypair = Keypair.fromSecretKey(bs58.decode(this.config.privateKey));
    this.wallet = new Wallet(keypair);
    
    this.logger.info('═══════════════════════════════════════════════════');
    this.logger.info('   Jupiter Arbitrage Bot - Production Mode');
    this.logger.info('   With Helius Sender Integration');
    this.logger.info('═══════════════════════════════════════════════════');
    this.logger.info(`Wallet: ${this.wallet.publicKey.toBase58()}`);
    this.logger.info(`RPC: ${this.config.rpcUrl.substring(0, 40)}...`);
    this.logger.info(`Trade Amount: ${this.config.tradeAmount} SOL`);
    this.logger.info(`Min Profit: ${this.config.minProfitPercent}%`);
    this.logger.info(`Sender Mode: ${this.config.senderMode}`);
    this.logger.info('═══════════════════════════════════════════════════');
  }

  private loadConfig(): Config {
    const required = ['RPC_URL', 'PRIVATE_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    return {
      rpcUrl: process.env.RPC_URL!,
      wsUrl: process.env.WS_URL || process.env.RPC_URL!.replace('http', 'ws'),
      privateKey: process.env.PRIVATE_KEY!,
      tradeAmount: parseFloat(process.env.TRADE_AMOUNT || '0.05'),
      minProfitPercent: parseFloat(process.env.MIN_PROFIT_PERCENT || '0.5'),
      maxPriceImpact: parseFloat(process.env.MAX_PRICE_IMPACT || '1.0'),
      slippageBps: parseInt(process.env.SLIPPAGE_BPS || '50'),
      enableLogging: process.env.ENABLE_LOGGING !== 'false',
      logLevel: process.env.LOG_LEVEL || 'info',
      senderMode: process.env.SENDER_MODE || 'swqos_only',
      senderTipLamports: parseInt(process.env.SENDER_TIP_LAMPORTS || '5000')
    };
  }

  async start() {
    this.logger.info('Starting arbitrage bot...');
    
    // Check wallet balance
    const balance = await this.getBalance();
    this.logger.info(`Wallet Balance: ${balance.toFixed(4)} SOL`);
    
    if (balance < this.config.tradeAmount * 2) {
      this.logger.warning('Low balance! Recommended: 2x trade amount');
    }
    
    this.isRunning = true;
    
    // Start monitoring loop
    this.monitoringLoop();
    
    // Print daily summary every 24 hours
    setInterval(() => {
      this.performanceTracker.printDailySummary();
    }, 24 * 60 * 60 * 1000);
    
    // Health check every 5 minutes
    setInterval(() => {
      this.healthCheck();
    }, 5 * 60 * 1000);
  }

  private async monitoringLoop() {
    while (this.isRunning) {
      try {
        if (this.circuitBreakerTripped) {
          this.logger.warning('Circuit breaker tripped. Waiting 60 seconds...');
          await this.sleep(60000);
          this.circuitBreakerTripped = false;
          this.consecutiveFailures = 0;
          continue;
        }
        
        const tokens = await this.getTrendingTokens();
        
        for (const token of tokens) {
          if (!this.isRunning) break;
          
          try {
            const opportunity = await this.checkArbitrageOpportunity(token);
            
            if (opportunity && opportunity.profitPercent >= this.config.minProfitPercent) {
              if (Date.now() - this.lastTradeTime < this.minTimeBetweenTrades) {
                continue;
              }
              
              this.logger.info('🎯 OPPORTUNITY FOUND', {
                token: opportunity.tokenSymbol,
                profit: `${opportunity.estimatedProfit.toFixed(4)} SOL`,
                percent: `${opportunity.profitPercent.toFixed(2)}%`
              });
              
              await this.executeArbitrage(opportunity);
              this.lastTradeTime = Date.now();
            }
          } catch (error) {
            this.logger.debug(`Error checking ${token.symbol}`, error);
          }
        }
        
        await this.sleep(500);
        
      } catch (error) {
        this.logger.error('Error in monitoring loop', error);
        this.consecutiveFailures++;
        
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.circuitBreakerTripped = true;
          this.logger.error('🔴 CIRCUIT BREAKER TRIPPED - Too many failures');
        }
        
        await this.sleep(5000);
      }
    }
  }

  private async getTrendingTokens(): Promise<Array<{mint: string, symbol: string}>> {
    try {
      const response = await fetch('https://token.jup.ag/strict');
      const tokens = await response.json();
      
      const trending = tokens
        .filter((t: any) => {
          return t.daily_volume > 50000 &&
                 !t.tags?.includes('unknown') &&
                 t.symbol !== 'WSOL';
        })
        .slice(0, 30)
        .map((t: any) => ({
          mint: t.address,
          symbol: t.symbol
        }));
      
      return trending;
    } catch (error) {
      this.logger.error('Error fetching trending tokens', error);
      return [];
    }
  }

  private async checkArbitrageOpportunity(
    token: {mint: string, symbol: string}
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const amountInLamports = Math.floor(this.config.tradeAmount * 1e9);
      
      const buyQuote = await this.getJupiterQuote(
        this.wsol,
        token.mint,
        amountInLamports
      );
      
      if (!buyQuote || buyQuote.priceImpactPct > this.config.maxPriceImpact) {
        return null;
      }
      
      const sellQuote = await this.getJupiterQuote(
        token.mint,
        this.wsol,
        parseInt(buyQuote.outAmount)
      );
      
      if (!sellQuote || sellQuote.priceImpactPct > this.config.maxPriceImpact) {
        return null;
      }
      
      const finalAmount = parseInt(sellQuote.outAmount) / 1e9;
      const profit = finalAmount - this.config.tradeAmount;
      const profitPercent = (profit / this.config.tradeAmount) * 100;
      
      // Account for fees + Sender tip
      const txFees = 0.00002;
      const senderTip = this.config.senderTipLamports / 1e9;
      const netProfit = profit - txFees - (senderTip * 2); // 2 transactions
      
      if (netProfit > 0 && profitPercent >= this.config.minProfitPercent) {
        return {
          tokenMint: token.mint,
          tokenSymbol: token.symbol,
          estimatedProfit: netProfit,
          profitPercent: profitPercent,
          buyQuote: buyQuote,
          sellQuote: sellQuote
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<any> {
    try {
      const url = new URL('https://quote-api.jup.ag/v6/quote');
      url.searchParams.append('inputMint', inputMint);
      url.searchParams.append('outputMint', outputMint);
      url.searchParams.append('amount', amount.toString());
      url.searchParams.append('slippageBps', this.config.slippageBps.toString());
      url.searchParams.append('onlyDirectRoutes', 'false');
      url.searchParams.append('maxAccounts', '64');
      
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) return null;
      
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  private async executeArbitrage(opportunity: ArbitrageOpportunity) {
    const startTime = Date.now();
    
    try {
      this.logger.info('⚡ Executing arbitrage...', {
        token: opportunity.tokenSymbol
      });
      
      const buyTx = await this.executeSwap(opportunity.buyQuote);
      
      if (!buyTx) {
        this.logger.error('Buy transaction failed');
        this.performanceTracker.recordTrade(false, 0);
        return;
      }
      
      this.logger.success(`✅ Buy complete: ${buyTx.substring(0, 20)}...`);
      
      await this.sleep(1500);
      
      const sellTx = await this.executeSwap(opportunity.sellQuote);
      
      if (!sellTx) {
        this.logger.error('⚠️  Sell transaction failed - holding token');
        this.performanceTracker.recordTrade(false, 0);
        return;
      }
      
      this.logger.success(`✅ Sell complete: ${sellTx.substring(0, 20)}...`);
      
      const executionTime = Date.now() - startTime;
      this.logger.success(`💰 Arbitrage completed in ${executionTime}ms`, {
        profit: `${opportunity.estimatedProfit.toFixed(4)} SOL`,
        percent: `${opportunity.profitPercent.toFixed(2)}%`
      });
      
      this.performanceTracker.recordTrade(true, opportunity.estimatedProfit);
      this.consecutiveFailures = 0;
      
    } catch (error) {
      this.logger.error('Execution error', error);
      this.performanceTracker.recordTrade(false, 0);
      this.consecutiveFailures++;
    }
  }

  private async executeSwap(quote: any): Promise<string | null> {
    try {
      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto'
        })
      });
      
      const swapData = await swapResponse.json();
      
      if (!swapData.swapTransaction) {
        throw new Error('No swap transaction');
      }
      
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      
      // Add Helius Sender tip instruction
      transaction = await this.addSenderTip(transaction);
      
      transaction.sign([this.wallet.payer]);
      
      // Send via Helius Sender (skipPreflight MUST be true)
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: true,  // Required for Sender!
          maxRetries: 0
        }
      );
      
      const confirmation = await this.connection.confirmTransaction(
        signature,
        'confirmed'
      );
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }
      
      return signature;
    } catch (error) {
      this.logger.debug('Swap execution error', error);
      return null;
    }
  }

  private async addSenderTip(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    // Random tip account selection
    const randomTipAccount = this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)];
    
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: new PublicKey(randomTipAccount),
      lamports: this.config.senderTipLamports
    });
    
    // Rebuild transaction with tip
    const message = TransactionMessage.decompile(transaction.message);
    message.instructions.push(tipInstruction);
    
    const newMessage = message.compileToV0Message();
    const newTransaction = new VersionedTransaction(newMessage);
    
    return newTransaction;
  }

  private async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9;
  }

  private async healthCheck() {
    try {
      const balance = await this.getBalance();
      const stats = this.performanceTracker.getStats();
      
      this.logger.info('❤️  Health Check', {
        balance: `${balance.toFixed(4)} SOL`,
        trades: stats.totalTrades,
        netProfit: `${stats.netProfit.toFixed(4)} SOL`,
        isRunning: this.isRunning
      });
    } catch (error) {
      this.logger.error('Health check failed', error);
    }
  }

  stop() {
    this.logger.info('Stopping bot...');
    this.isRunning = false;
    this.performanceTracker.printDailySummary();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const bot = new JupiterArbitrageBotProduction();
  
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n👋 Received SIGTERM, shutting down...');
    bot.stop();
    process.exit(0);
  });
  
  await bot.start();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});