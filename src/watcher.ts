import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../config/.env') });

// ─────────────────────────────────────────────
//  GRADUATION WATCHER
//  Polls Moralis for pump.fun + bonk.fun graduates
//  Polls DexScreener for bags.fm graduates
//  Writes new tokens to watchlist.json for the bot to scan
// ─────────────────────────────────────────────

const MORALIS_KEY    = process.env.MORALIS_API_KEY || '';
const WATCHLIST_PATH = path.join(__dirname, '../watchlist.json');
const SEEN_PATH      = path.join(__dirname, '../logs/watcher-seen.json');
const POLL_INTERVAL  = 30_000; // poll every 30 seconds
const MAX_WATCHLIST  = 50;     // cap watchlist size so bot doesn't slow down
const MAX_AGE_MS     = 2 * 60 * 60 * 1000; // only add tokens graduated in last 2 hours

// Moralis exchanges to watch
const MORALIS_EXCHANGES = [
  { id: 'pumpfun',  label: 'pump.fun'  },
  { id: 'bonkfun',  label: 'bonk.fun'  },
];

// ── LOGGER ────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [WATCHER] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, '../logs/watcher.log'), line + '\n');
  } catch { /* ignore */ }
}

// ── SEEN SET ──────────────────────────────────
// Tracks tokens we've already added so we don't re-add them on every poll

function loadSeen(): Set<string> {
  try {
    if (fs.existsSync(SEEN_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
      return new Set(data);
    }
  } catch { /* fresh start */ }
  return new Set();
}

function saveSeen(seen: Set<string>) {
  try {
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2));
  } catch { /* ignore */ }
}

// ── WATCHLIST R/W ─────────────────────────────

function loadWatchlist(): Array<{ mint: string; symbol: string; source?: string; graduatedAt?: string }> {
  try {
    if (fs.existsSync(WATCHLIST_PATH)) {
      return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    }
  } catch { /* empty */ }
  return [];
}

function saveWatchlist(list: Array<{ mint: string; symbol: string; source?: string; graduatedAt?: string }>) {
  try {
    fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2));
  } catch (e: any) {
    log(`ERROR saving watchlist: ${e.message}`);
  }
}

// ── ADD TO WATCHLIST ──────────────────────────

function addToWatchlist(
  seen: Set<string>,
  mint: string,
  symbol: string,
  source: string,
  graduatedAt: string
): boolean {
  if (seen.has(mint)) return false;

  // Only add if graduated recently
  const age = Date.now() - new Date(graduatedAt).getTime();
  if (age > MAX_AGE_MS) return false;

  const list = loadWatchlist();
  if (list.find(t => t.mint === mint)) return false;

  list.unshift({ mint, symbol, source, graduatedAt });

  // Trim to max size (remove oldest entries)
  while (list.length > MAX_WATCHLIST) list.pop();

  saveWatchlist(list);
  seen.add(mint);
  saveSeen(seen);

  const ageMin = Math.floor(age / 60_000);
  log(`✅ Added [${source}] ${symbol} (${mint.slice(0, 8)}...) graduated ${ageMin}m ago`);
  return true;
}

// ── MORALIS POLLER ────────────────────────────

async function pollMoralis(seen: Set<string>) {
  if (!MORALIS_KEY) {
    log('WARN: MORALIS_API_KEY not set — skipping pump.fun/bonk.fun');
    return;
  }

  for (const exchange of MORALIS_EXCHANGES) {
    try {
      const url = `https://solana-gateway.moralis.io/token/mainnet/exchange/${exchange.id}/graduated?limit=20`;
      const res = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'X-API-Key': MORALIS_KEY,
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        log(`WARN: Moralis ${exchange.label} returned ${res.status}`);
        continue;
      }

      const data: any = await res.json();
      const tokens = data?.result ?? [];
      let added = 0;

      for (const token of tokens) {
        const mint        = token.tokenAddress;
        const symbol      = token.symbol ?? '???';
        const graduatedAt = token.graduatedAt;
        if (!mint || !graduatedAt) continue;
        if (addToWatchlist(seen, mint, symbol, exchange.label, graduatedAt)) added++;
      }

      if (added > 0) log(`[${exchange.label}] Added ${added} new graduated token(s)`);
      else log(`[${exchange.label}] No new graduates (checked ${tokens.length} tokens)`);

    } catch (err: any) {
      log(`ERROR polling ${exchange.label}: ${err.message}`);
    }
  }
}

// ── BAGS.FM POLLER ────────────────────────────
// bags.fm tokens graduate to Meteora — we detect them via DexScreener
// by searching for recently added Solana pairs with very low age

async function pollBagsFm(seen: Set<string>) {
  try {
    // Search DexScreener for bags.fm graduated tokens
    // bags.fm tokens are identifiable: they graduate to Meteora DLMM pools
    const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return;

    const data: any = await res.json();
    const profiles = Array.isArray(data) ? data : [];
    let added = 0;

    const cutoff = Date.now() - MAX_AGE_MS;

    for (const profile of profiles) {
      if (profile.chainId !== 'solana') continue;
      // bags.fm URL pattern contains "bags.fm"
      const isBags = (profile.links ?? []).some((l: any) =>
        (l.url ?? '').includes('bags.fm') || (l.label ?? '').toLowerCase().includes('bags')
      ) || (profile.description ?? '').toLowerCase().includes('bags.fm');

      if (!isBags) continue;

      const mint = profile.tokenAddress;
      if (!mint || seen.has(mint)) continue;

      // Fetch pair data to get symbol and check it has liquidity
      const pairRes = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (!pairRes.ok) continue;
      const pairData: any = await pairRes.json();
      const pairs = (pairData?.pairs ?? []).filter((p: any) => p.chainId === 'solana');
      if (pairs.length === 0) continue;

      const pair      = pairs[0];
      const symbol    = pair.baseToken?.symbol ?? '???';
      const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : new Date().toISOString();

      if (pair.pairCreatedAt && pair.pairCreatedAt < cutoff) continue;
      if ((pair.liquidity?.usd ?? 0) < 5_000) continue;

      if (addToWatchlist(seen, mint, symbol, 'bags.fm', createdAt)) added++;
    }

    if (added > 0) log(`[bags.fm] Added ${added} new graduated token(s)`);
    else log(`[bags.fm] No new graduates found`);

  } catch (err: any) {
    log(`ERROR polling bags.fm: ${err.message}`);
  }
}

// ── MAIN LOOP ─────────────────────────────────

async function main() {
  // Ensure logs dir exists
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  log('═══════════════════════════════════════════════');
  log('  Graduation Watcher Started');
  log(`  Watching: pump.fun, bonk.fun, bags.fm`);
  log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
  log(`  Max token age: ${MAX_AGE_MS / 3_600_000}h`);
  log(`  Watchlist: ${WATCHLIST_PATH}`);
  log('═══════════════════════════════════════════════');

  const seen = loadSeen();
  log(`Loaded ${seen.size} previously seen tokens`);

  const poll = async () => {
    await pollMoralis(seen);
    await pollBagsFm(seen);
  };

  // Run immediately then on interval
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

main().catch(err => {
  console.error('Fatal watcher error:', err);
  process.exit(1);
});
