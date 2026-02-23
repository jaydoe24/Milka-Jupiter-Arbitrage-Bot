import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../config/.env') });

// ─────────────────────────────────────────────
//  CONSTANTS — from official Helius Sender docs
//  https://www.helius.dev/docs/sending-transactions/sender
// ─────────────────────────────────────────────

// Official Helius Sender tip accounts (verified from docs + your dashboard screenshot)
const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

// Sender regional endpoints (use HTTP regional for VPS — lower latency than HTTPS global)
const SENDER_ENDPOINTS: Record<string, string> = {
  ewr:    'http://ewr-sender.helius-rpc.com/fast',  // Newark     — closest to US-East validators
  slc:    'http://slc-sender.helius-rpc.com/fast',  // Salt Lake City
  lon:    'http://lon-sender.helius-rpc.com/fast',  // London
  fra:    'http://fra-sender.helius-rpc.com/fast',  // Frankfurt
  ams:    'http://ams-sender.helius-rpc.com/fast',  // Amsterdam
  sg:     'http://sg-sender.helius-rpc.com/fast',   // Singapore
  tyo:    'http://tyo-sender.helius-rpc.com/fast',  // Tokyo
  global: 'https://sender.helius-rpc.com/fast',     // Global HTTPS fallback
};

// Minimum tip per official docs: 0.0002 SOL = 200_000 lamports
const MIN_TIP_LAMPORTS = 200_000;

// ─────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────

interface Config {
  rpcUrl: string;
  wsUrl: string;
  privateKey: string;
  tradeAmountSol: number;
  minProfitPercent: number;
  maxPriceImpact: number;
  slippageBps: number;
  logLevel: string;
  telegramToken: string;
  telegramChatId: string;
  isDevnet: boolean;
  senderRegion: string;
}

interface TokenCandidate {
  mint: string;
  symbol: string;
  volume24h: number;
}

interface ArbitrageOpportunity {
  tokenMint: string;
  tokenSymbol: string;
  buyQuote: any;
  sellQuote: any;
  estimatedProfitSol: number;
  profitPercent: number;
}

interface TradeStats {
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  simulationSkipped: number;
  totalProfitSol: number;
  totalLossSol: number;
  netProfitSol: number;
  startTime: number;
}

// ─────────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────────

class Logger {
  private logDir: string;
  private level: string;

  constructor(level = 'info', logDir = './logs') {
    this.level  = level;
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  private write(level: string, msg: string, data?: any) {
    const ts   = new Date().toISOString();
    const line = data
      ? `[${ts}] [${level.toUpperCase()}] ${msg} | ${JSON.stringify(data)}`
      : `[${ts}] [${level.toUpperCase()}] ${msg}`;
    const colors: Record<string, string> = {
      info: '\x1b[36m', success: '\x1b[32m',
      warn: '\x1b[33m', error:   '\x1b[31m', debug: '\x1b[90m',
    };
    console.log(`${colors[level] ?? ''}${line}\x1b[0m`);
    fs.appendFileSync(path.join(this.logDir, `${level}.log`), line + '\n');
  }

  info(msg: string, data?: any)    { this.write('info',    msg, data); }
  success(msg: string, data?: any) { this.write('success', msg, data); }
  warn(msg: string, data?: any)    { this.write('warn',    msg, data); }
  error(msg: string, data?: any)   { this.write('error',   msg, data); }
  debug(msg: string, data?: any)   { if (this.level === 'debug') this.write('debug', msg, data); }
}

// ─────────────────────────────────────────────
//  PERFORMANCE TRACKER
// ─────────────────────────────────────────────

class PerformanceTracker {
  private stats: TradeStats;
  private file: string;
  private log: Logger;

  constructor(log: Logger, file = './logs/stats.json') {
    this.log  = log;
    this.file = file;
    this.stats = this.load();
  }

  private load(): TradeStats {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch { /* fresh start */ }
    return {
      totalTrades: 0, successfulTrades: 0, failedTrades: 0,
      simulationSkipped: 0, totalProfitSol: 0, totalLossSol: 0,
      netProfitSol: 0, startTime: Date.now(),
    };
  }

  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.stats, null, 2)); } catch { /* ignore */ }
  }

  record(success: boolean, profitSol: number) {
    this.stats.totalTrades++;
    if (success) {
      this.stats.successfulTrades++;
      profitSol > 0 ? (this.stats.totalProfitSol += profitSol) : (this.stats.totalLossSol += Math.abs(profitSol));
    } else {
      this.stats.failedTrades++;
    }
    this.stats.netProfitSol = this.stats.totalProfitSol - this.stats.totalLossSol;
    this.save();
  }

  recordSimSkip() { this.stats.simulationSkipped++; this.save(); }
  get(): TradeStats { return { ...this.stats }; }

  summary() {
    const s    = this.stats;
    const rate = s.totalTrades > 0 ? ((s.successfulTrades / s.totalTrades) * 100).toFixed(1) : '0.0';
    const upH  = ((Date.now() - s.startTime) / 3_600_000).toFixed(1);
    this.log.info('═══════════════════ SUMMARY ═══════════════════');
    this.log.info(`Uptime        : ${upH}h`);
    this.log.info(`Total trades  : ${s.totalTrades}`);
    this.log.info(`Success rate  : ${rate}%`);
    this.log.info(`Sim skipped   : ${s.simulationSkipped}`);
    this.log.info(`Profit        : +${s.totalProfitSol.toFixed(6)} SOL`);
    this.log.info(`Loss          : -${s.totalLossSol.toFixed(6)} SOL`);
    this.log.info(`Net           : ${s.netProfitSol.toFixed(6)} SOL`);
    this.log.info('═══════════════════════════════════════════════');
  }
}

// ─────────────────────────────────────────────
//  TELEGRAM
// ─────────────────────────────────────────────

class Telegram {
  private token: string;
  private chatId: string;
  private enabled: boolean;

  constructor(token: string, chatId: string) {
    this.token   = token;
    this.chatId  = chatId;
    this.enabled = !!(token && chatId && token !== 'disabled');
  }

  async send(msg: string) {
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: this.chatId, text: msg, parse_mode: 'HTML' }),
      });
    } catch { /* never crash bot on Telegram failure */ }
  }
}

// ─────────────────────────────────────────────
//  MAIN BOT
// ─────────────────────────────────────────────

class MilkaArbitrageBot {
  private connection: Connection;
  private wallet: Wallet;
  private cfg: Config;
  private log: Logger;
  private tracker: PerformanceTracker;
  private tg: Telegram;

  private readonly WSOL          = 'So11111111111111111111111111111111111111112';
  private readonly JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
  private readonly JUPITER_SWAP  = 'https://quote-api.jup.ag/v6/swap';

  private isRunning           = false;
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 5;

  // Dynamic tip — fetched from Jito floor API, cached 5 min
  private cachedTipLamports = MIN_TIP_LAMPORTS;
  private tipCacheTime      = 0;

  constructor() {
    this.cfg     = this.loadConfig();
    this.log     = new Logger(this.cfg.logLevel);
    this.tracker = new PerformanceTracker(this.log);
    this.tg      = new Telegram(this.cfg.telegramToken, this.cfg.telegramChatId);

    this.connection = new Connection(this.cfg.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: this.cfg.wsUrl,
      confirmTransactionInitialTimeout: 60_000,
    });

    const keypair = Keypair.fromSecretKey(bs58.decode(this.cfg.privateKey));
    this.wallet   = new Wallet(keypair);

    const net = this.cfg.isDevnet ? '🔵 DEVNET' : '🔴 MAINNET';
    this.log.info('═══════════════════════════════════════════════');
    this.log.info(`  Milka Arbitrage Bot  ${net}`);
    this.log.info(`  Sender: ${this.getSenderEndpoint()}`);
    this.log.info('═══════════════════════════════════════════════');
    this.log.info(`Wallet     : ${this.wallet.publicKey.toBase58()}`);
    this.log.info(`Trade size : ${this.cfg.tradeAmountSol} SOL`);
    this.log.info(`Min profit : ${this.cfg.minProfitPercent}%`);
    this.log.info(`Telegram   : ${this.cfg.telegramToken !== 'disabled' ? 'ON' : 'OFF'}`);
    this.log.info('═══════════════════════════════════════════════');
  }

  // ── CONFIG ──────────────────────────────────

  private loadConfig(): Config {
    const missing = ['RPC_URL', 'PRIVATE_KEY'].filter(k => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
    return {
      rpcUrl:           process.env.RPC_URL!,
      wsUrl:            process.env.WS_URL || process.env.RPC_URL!.replace('https', 'wss'),
      privateKey:       process.env.PRIVATE_KEY!,
      tradeAmountSol:   parseFloat(process.env.TRADE_AMOUNT       || '0.05'),
      minProfitPercent: parseFloat(process.env.MIN_PROFIT_PERCENT || '0.5'),
      maxPriceImpact:   parseFloat(process.env.MAX_PRICE_IMPACT   || '1.0'),
      slippageBps:      parseInt(  process.env.SLIPPAGE_BPS       || '50'),
      logLevel:         process.env.LOG_LEVEL                     || 'info',
      telegramToken:    process.env.TELEGRAM_BOT_TOKEN            || 'disabled',
      telegramChatId:   process.env.TELEGRAM_CHAT_ID              || '',
      isDevnet:         process.env.NETWORK                       === 'devnet',
      senderRegion:     process.env.SENDER_REGION                 || 'ewr',
    };
  }

  private getSenderEndpoint(): string {
    if (this.cfg.isDevnet) return this.cfg.rpcUrl; // Sender is mainnet-only
    return SENDER_ENDPOINTS[this.cfg.senderRegion] ?? SENDER_ENDPOINTS.global;
  }

  // ── START ────────────────────────────────────

  async start() {
    const balance = await this.getBalance();
    this.log.info(`Balance: ${balance.toFixed(4)} SOL`);

    if (balance < this.cfg.tradeAmountSol + 0.05) {
      this.log.warn(`⚠️  Low balance. Recommended minimum: ${(this.cfg.tradeAmountSol + 0.05).toFixed(3)} SOL`);
    }

    await this.warmSenderConnection();

    await this.tg.send(
      `🤖 <b>Milka Bot Started</b>\n` +
      `Network: ${this.cfg.isDevnet ? 'Devnet' : 'Mainnet'}\n` +
      `Wallet: <code>${this.wallet.publicKey.toBase58()}</code>\n` +
      `Balance: ${balance.toFixed(4)} SOL\n` +
      `Sender: ${this.getSenderEndpoint()}`
    );

    this.isRunning = true;
    setInterval(() => this.tracker.summary(),      60 * 60 * 1_000); // Hourly summary
    setInterval(() => this.healthCheck(),           5  * 60 * 1_000); // Health check every 5 min
    setInterval(() => this.warmSenderConnection(),  30 * 1_000);       // Keep Sender warm every 30s

    await this.mainLoop();
  }

  stop() {
    this.log.info('Shutting down...');
    this.isRunning = false;
    this.tracker.summary();
    this.tg.send('🛑 <b>Milka Bot Stopped</b>');
  }

  // ── MAIN LOOP ────────────────────────────────

  private async mainLoop() {
    let circuitCooldown = false;

    while (this.isRunning) {
      try {
        if (circuitCooldown) {
          this.log.warn('Circuit breaker: cooling down 60s...');
          await this.tg.send('⚠️ Circuit breaker tripped. Cooling 60s...');
          await this.sleep(60_000);
          circuitCooldown = false;
          this.consecutiveFailures = 0;
        }

        const tokens = await this.getTokenCandidates();
        this.log.debug(`Scanning ${tokens.length} tokens...`);

        for (const token of tokens) {
          if (!this.isRunning) break;
          const opp = await this.findOpportunity(token);
          if (!opp) continue;

          this.log.info(`🎯 OPPORTUNITY: ${opp.tokenSymbol}`, {
            profit: `${opp.estimatedProfitSol.toFixed(6)} SOL`,
            pct:    `${opp.profitPercent.toFixed(2)}%`,
          });

          await this.execute(opp);
          this.consecutiveFailures = 0;
          await this.sleep(2_000);
        }

        await this.sleep(500);

      } catch (err: any) {
        this.log.error('Main loop error', err?.message);
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.MAX_FAILURES) circuitCooldown = true;
        await this.sleep(5_000);
      }
    }
  }

  // ── TOKEN CANDIDATES ─────────────────────────
  // DexScreener first (volatile memecoins), Jupiter strict as fallback

  private async getTokenCandidates(): Promise<TokenCandidate[]> {
    const candidates: TokenCandidate[] = [];

    try {
      const res = await fetch(
        'https://api.dexscreener.com/latest/dex/tokens/solana?limit=50',
        { signal: AbortSignal.timeout(5_000) }
      );
      if (res.ok) {
        const data: any = await res.json();
        for (const p of (data?.pairs ?? []) as any[]) {
          if (
            p.chainId === 'solana' &&
            p.volume?.h24   > 100_000 &&
            p.liquidity?.usd > 20_000 &&
            p.baseToken?.address !== this.WSOL
          ) {
            candidates.push({ mint: p.baseToken.address, symbol: p.baseToken.symbol ?? '???', volume24h: p.volume.h24 });
          }
        }
      }
    } catch { this.log.debug('DexScreener failed, using fallback'); }

    if (candidates.length === 0) {
      try {
        const res = await fetch('https://token.jup.ag/strict', { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          const tokens: any[] = await res.json();
          tokens
            .filter((t: any) => t.daily_volume > 100_000 && t.address !== this.WSOL)
            .sort((a: any, b: any) => b.daily_volume - a.daily_volume)
            .slice(0, 40)
            .forEach((t: any) => candidates.push({ mint: t.address, symbol: t.symbol, volume24h: t.daily_volume }));
        }
      } catch { /* give up this cycle */ }
    }

    const seen = new Set<string>();
    return candidates
      .filter(c => { if (seen.has(c.mint)) return false; seen.add(c.mint); return true; })
      .slice(0, 40);
  }

  // ── OPPORTUNITY DETECTION ────────────────────

  private async findOpportunity(token: TokenCandidate): Promise<ArbitrageOpportunity | null> {
    try {
      const inLamports = Math.floor(this.cfg.tradeAmountSol * 1e9);

      // Quote A: WSOL → TOKEN
      const buyUrl = new URL(this.JUPITER_QUOTE);
      buyUrl.searchParams.set('inputMint',   this.WSOL);
      buyUrl.searchParams.set('outputMint',  token.mint);
      buyUrl.searchParams.set('amount',      inLamports.toString());
      buyUrl.searchParams.set('slippageBps', this.cfg.slippageBps.toString());
      buyUrl.searchParams.set('maxAccounts', '64');

      const buyRes = await fetch(buyUrl.toString(), { signal: AbortSignal.timeout(3_000) });
      if (!buyRes.ok) return null;
      const buyQuote: any = await buyRes.json();
      if (!buyQuote?.outAmount) return null;
      if (parseFloat(buyQuote.priceImpactPct ?? '999') > this.cfg.maxPriceImpact) return null;

      // Quote B: TOKEN → WSOL (exact out amount from A)
      const sellUrl = new URL(this.JUPITER_QUOTE);
      sellUrl.searchParams.set('inputMint',   token.mint);
      sellUrl.searchParams.set('outputMint',  this.WSOL);
      sellUrl.searchParams.set('amount',      buyQuote.outAmount);
      sellUrl.searchParams.set('slippageBps', this.cfg.slippageBps.toString());
      sellUrl.searchParams.set('maxAccounts', '64');

      const sellRes = await fetch(sellUrl.toString(), { signal: AbortSignal.timeout(3_000) });
      if (!sellRes.ok) return null;
      const sellQuote: any = await sellRes.json();
      if (!sellQuote?.outAmount) return null;
      if (parseFloat(sellQuote.priceImpactPct ?? '999') > this.cfg.maxPriceImpact) return null;

      const outLamports    = parseInt(sellQuote.outAmount);
      const grossProfitSol = (outLamports - inLamports) / 1e9;

      // Full fee model:
      //   2× Helius Sender tip (one per tx), min 0.0002 SOL each
      //   2× base tx fee (~0.000005 SOL each)
      //   2× priority fee estimate (~0.0001 SOL each — Jupiter sets this dynamically)
      const tipSol       = (await this.getDynamicTipLamports()) / 1e9;
      const totalFees    = (tipSol * 2) + (0.000005 * 2) + (0.0001 * 2);
      const netProfit    = grossProfitSol - totalFees;
      const profitPct    = (netProfit / this.cfg.tradeAmountSol) * 100;

      if (netProfit <= 0 || profitPct < this.cfg.minProfitPercent) return null;

      return { tokenMint: token.mint, tokenSymbol: token.symbol, buyQuote, sellQuote, estimatedProfitSol: netProfit, profitPercent: profitPct };
    } catch {
      return null;
    }
  }

  // ── EXECUTE ──────────────────────────────────

  private async execute(opp: ArbitrageOpportunity) {
    const t0 = Date.now();
    try {
      const [buyTx, sellTx] = await Promise.all([
        this.buildSwapTx(opp.buyQuote),
        this.buildSwapTx(opp.sellQuote),
      ]);

      if (!buyTx || !sellTx) {
        this.log.warn(`${opp.tokenSymbol}: failed to build transactions`);
        this.tracker.record(false, 0);
        return;
      }

      // Simulate buy before spending fees
      const simOk = await this.simulate(buyTx);
      if (!simOk) {
        this.log.debug(`${opp.tokenSymbol}: simulation rejected`);
        this.tracker.recordSimSkip();
        return;
      }

      // BUY via Helius Sender
      const buySig = await this.sendViaSender(buyTx);
      if (!buySig) {
        this.log.warn(`${opp.tokenSymbol}: BUY tx failed`);
        this.tracker.record(false, 0);
        return;
      }
      this.log.success(`✅ BUY  : https://solscan.io/tx/${buySig}`);

      await this.sleep(800); // Brief wait for buy to land

      // SELL via Helius Sender
      const sellSig = await this.sendViaSender(sellTx);
      if (!sellSig) {
        this.log.error(`⚠️  ${opp.tokenSymbol}: SELL FAILED — token stranded!`);
        await this.tg.send(
          `🚨 <b>SELL FAILED — ACTION NEEDED</b>\n` +
          `Token: <b>${opp.tokenSymbol}</b>\n` +
          `Mint: <code>${opp.tokenMint}</code>\n` +
          `Buy tx: <a href="https://solscan.io/tx/${buySig}">view</a>\n` +
          `👉 Manually sell on Jupiter: https://jup.ag/swap/${opp.tokenMint}-SOL`
        );
        this.tracker.record(false, 0);
        return;
      }

      const ms = Date.now() - t0;
      this.log.success(`✅ SELL : https://solscan.io/tx/${sellSig}`);
      this.log.success(`💰 ${opp.estimatedProfitSol.toFixed(6)} SOL (${opp.profitPercent.toFixed(2)}%) in ${ms}ms`);

      await this.tg.send(
        `💰 <b>Profitable Trade!</b>\n` +
        `Token: <b>${opp.tokenSymbol}</b>\n` +
        `Profit: <b>${opp.estimatedProfitSol.toFixed(6)} SOL</b> (${opp.profitPercent.toFixed(2)}%)\n` +
        `Time: ${ms}ms\n` +
        `Buy: <a href="https://solscan.io/tx/${buySig}">view</a>  |  ` +
        `Sell: <a href="https://solscan.io/tx/${sellSig}">view</a>`
      );

      this.tracker.record(true, opp.estimatedProfitSol);

    } catch (err: any) {
      this.log.error(`Execute error: ${opp.tokenSymbol}`, err?.message);
      this.tracker.record(false, 0);
      this.consecutiveFailures++;
    }
  }

  // ── BUILD SWAP TX ────────────────────────────
  // Jupiter builds the swap, we add:
  //   1. Helius Sender tip instruction (mandatory, min 0.0002 SOL)
  // Jupiter's `dynamicComputeUnitLimit` + `prioritizationFeeLamports: auto`
  // handle ComputeBudget instructions automatically.

  private async buildSwapTx(quote: any): Promise<VersionedTransaction | null> {
    try {
      const swapRes = await fetch(this.JUPITER_SWAP, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          quoteResponse:             quote,
          userPublicKey:             this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol:          true,
          dynamicComputeUnitLimit:   true,   // Jupiter auto-sets compute units
          prioritizationFeeLamports: 'auto', // Jupiter auto-sets priority fee
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!swapRes.ok) return null;
      const data: any = await swapRes.json();
      if (!data?.swapTransaction) return null;

      const txBuf = Buffer.from(data.swapTransaction, 'base64');
      const tx    = VersionedTransaction.deserialize(txBuf);

      // ── Fetch Address Lookup Tables (ALTs) ──────────────────────────
      // Jupiter v1 uses ALTs to compress transactions. We MUST fetch and
      // pass them when decompiling/recompiling, otherwise all compressed
      // addresses expand to full pubkeys and the tx exceeds the 1232-byte
      // size limit, causing every trade to fail silently.
      const altKeys    = tx.message.addressTableLookups.map(a => a.accountKey);
      const altResults = await Promise.all(
        altKeys.map(key => this.connection.getAddressLookupTable(key).then(r => r.value))
      );
      const validAlts  = altResults.filter(Boolean) as AddressLookupTableAccount[];

      // Add Helius Sender tip instruction
      const tipLamports = await this.getDynamicTipLamports();
      const tipAccount  = HELIUS_TIP_ACCOUNTS[
        Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)
      ];

      const msg = TransactionMessage.decompile(tx.message, {
        addressLookupTableAccounts: validAlts,
      });
      msg.instructions.push(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey:   new PublicKey(tipAccount),
          lamports:   tipLamports,
        })
      );

      return new VersionedTransaction(msg.compileToV0Message(validAlts));

    } catch (err: any) {
      this.log.debug('buildSwapTx error', err?.message);
      return null;
    }
  }

  // ── SIMULATE ─────────────────────────────────

  private async simulate(tx: VersionedTransaction): Promise<boolean> {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.message.recentBlockhash = blockhash;
      const result = await this.connection.simulateTransaction(tx, {
        commitment:             'processed',
        replaceRecentBlockhash: true,
      });
      if (result.value.err) { this.log.debug('Simulation rejected', result.value.err); return false; }
      return true;
    } catch { return false; }
  }

  // ── SEND VIA HELIUS SENDER ───────────────────
  // Official requirements (from docs):
  //   - POST to Sender endpoint (NOT standard RPC)
  //   - skipPreflight: true  (MANDATORY)
  //   - maxRetries: 0        (handle retries ourselves)
  //   - Must include both tip + priority fee

  private async sendViaSender(tx: VersionedTransaction): Promise<string | null> {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');
      tx.message.recentBlockhash = blockhash;
      tx.sign([this.wallet.payer]);

      const base64Tx = Buffer.from(tx.serialize()).toString('base64');
      const endpoint = this.getSenderEndpoint();

      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0',
          id:      Date.now().toString(),
          method:  'sendTransaction',
          params:  [
            base64Tx,
            {
              encoding:      'base64',
              skipPreflight: true, // REQUIRED by Helius Sender
              maxRetries:    0,    // We confirm manually below
            },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
      });

      const json: any = await res.json();
      if (json.error) { this.log.debug('Sender error', json.error); return null; }

      const signature: string = json.result;
      const confirmed = await this.confirmTx(signature, lastValidBlockHeight);
      return confirmed ? signature : null;

    } catch (err: any) {
      this.log.debug('sendViaSender error', err?.message);
      return null;
    }
  }

  // ── CONFIRM ───────────────────────────────────

  private async confirmTx(sig: string, lastValidBlockHeight: number): Promise<boolean> {
    const timeout = 15_000;
    const start   = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const height = await this.connection.getBlockHeight('confirmed');
        if (height > lastValidBlockHeight) { this.log.debug(`Blockhash expired: ${sig.substring(0, 12)}...`); return false; }

        const status = await this.connection.getSignatureStatuses([sig]);
        const s      = status?.value?.[0];
        if (s?.err) { this.log.debug('On-chain error', s.err); return false; }
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return true;
      } catch { /* retry */ }
      await this.sleep(500);
    }

    this.log.debug(`Confirmation timeout: ${sig.substring(0, 12)}...`);
    return false;
  }

  // ── DYNAMIC TIP ───────────────────────────────
  // 75th percentile from Jito floor API, minimum 0.0002 SOL

  private async getDynamicTipLamports(): Promise<number> {
    const now = Date.now();
    if (now - this.tipCacheTime < 5 * 60_000) return this.cachedTipLamports;

    try {
      const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        const data: any = await res.json();
        const tip75     = data?.[0]?.landed_tips_75th_percentile;
        if (typeof tip75 === 'number') {
          this.cachedTipLamports = Math.max(Math.ceil(tip75 * 1e9), MIN_TIP_LAMPORTS);
          this.tipCacheTime      = now;
          this.log.debug(`Dynamic tip: ${this.cachedTipLamports} lamports (${(this.cachedTipLamports / 1e9).toFixed(6)} SOL)`);
        }
      }
    } catch { this.log.debug('Jito tip fetch failed, using cached'); }

    return this.cachedTipLamports;
  }

  // ── CONNECTION WARMING ────────────────────────
  // Per Helius docs: ping every 30s to keep connection warm

  private async warmSenderConnection() {
    if (this.cfg.isDevnet) return;
    try {
      const pingUrl = this.getSenderEndpoint().replace('/fast', '/ping');
      await fetch(pingUrl, { signal: AbortSignal.timeout(2_000) });
      this.log.debug('Sender connection warmed');
    } catch { /* best-effort */ }
  }

  // ── HELPERS ───────────────────────────────────

  private async getBalance(): Promise<number> {
    return (await this.connection.getBalance(this.wallet.publicKey)) / 1e9;
  }

  private async healthCheck() {
    try {
      const bal   = await this.getBalance();
      const stats = this.tracker.get();
      this.log.info('❤️  Health', {
        balance:   `${bal.toFixed(4)} SOL`,
        trades:    stats.totalTrades,
        netProfit: `${stats.netProfitSol.toFixed(6)} SOL`,
        failures:  this.consecutiveFailures,
      });
      if (bal < 0.05) await this.tg.send(`⚠️ <b>LOW BALANCE</b>: ${bal.toFixed(4)} SOL — top up soon!`);
    } catch { /* ignore */ }
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}

// ─────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────

async function main() {
  const bot = new MilkaArbitrageBot();
  process.on('SIGINT',  () => { bot.stop(); process.exit(0); });
  process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
  await bot.start();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
