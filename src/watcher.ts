import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../config/.env') });

// ─────────────────────────────────────────────
//  GRADUATION WATCHER v2
//
//  pump.fun  → Moralis pumpfun graduated endpoint (most reliable)
//  bonk.fun  → DexScreener: new Raydium LaunchLab pairs (bonk.fun uses Raydium LaunchLab)
//  bags.fm   → DexScreener: new Meteora DBC pairs (bags.fm graduates to Meteora)
//
//  All new tokens written to watchlist.json for the arb bot to scan.
// ─────────────────────────────────────────────

const MORALIS_KEY    = process.env.MORALIS_API_KEY || '';
const WATCHLIST_PATH = path.join(__dirname, '../watchlist.json');
const SEEN_PATH      = path.join(__dirname, '../logs/watcher-seen.json');
const POLL_INTERVAL  = 30_000;
const MAX_WATCHLIST  = 50;
const MAX_AGE_MS     = 2 * 60 * 60 * 1000;

const DEX_RAYDIUM_LAUNCHLAB = 'raydium-launchlab';

function log(msg: string) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [WATCHER] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(__dirname, '../logs/watcher.log'), line + '\n'); } catch { }
}

function loadSeen(): Set<string> {
  try {
    if (fs.existsSync(SEEN_PATH)) return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')));
  } catch { }
  return new Set();
}

function saveSeen(seen: Set<string>) {
  try { fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen], null, 2)); } catch { }
}

type WatchlistEntry = { mint: string; symbol: string; source?: string; graduatedAt?: string };

function loadWatchlist(): WatchlistEntry[] {
  try {
    if (fs.existsSync(WATCHLIST_PATH)) return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
  } catch { }
  return [];
}

function saveWatchlist(list: WatchlistEntry[]) {
  try { fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2)); }
  catch (e: any) { log(`ERROR saving watchlist: ${e.message}`); }
}

function addToWatchlist(seen: Set<string>, mint: string, symbol: string, source: string, graduatedAt: string): boolean {
  if (seen.has(mint)) return false;
  const age = Date.now() - new Date(graduatedAt).getTime();
  if (isNaN(age) || age > MAX_AGE_MS) return false;
  const list = loadWatchlist();
  if (list.find(t => t.mint === mint)) { seen.add(mint); return false; }
  list.unshift({ mint, symbol, source, graduatedAt });
  while (list.length > MAX_WATCHLIST) list.pop();
  saveWatchlist(list);
  seen.add(mint);
  saveSeen(seen);
  const ageMin = Math.floor(age / 60_000);
  log(`\u2705 Added [${source}] ${symbol} (${mint.slice(0, 8)}...) graduated ${ageMin}m ago`);
  return true;
}

async function pollPumpFun(seen: Set<string>) {
  if (!MORALIS_KEY) { log('WARN: MORALIS_API_KEY not set'); return; }
  try {
    const res = await fetch('https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated?limit=20', {
      headers: { 'accept': 'application/json', 'X-API-Key': MORALIS_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { log(`WARN: Moralis pump.fun returned ${res.status}`); return; }
    const data: any = await res.json();
    const tokens = data?.result ?? [];
    let added = 0;
    for (const token of tokens) {
      if (addToWatchlist(seen, token.tokenAddress, token.symbol ?? '???', 'pump.fun', token.graduatedAt)) added++;
    }
    if (added > 0) log(`[pump.fun] Added ${added} new graduated token(s)`);
    else log(`[pump.fun] No new graduates (checked ${tokens.length} tokens)`);
  } catch (err: any) { log(`ERROR polling pump.fun: ${err.message}`); }
}

async function pollBonkFun(seen: Set<string>) {
  try {
    // bonk.fun uses Raydium LaunchLab — search for recent LaunchLab pairs
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=SOL&chainId=solana', {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { log(`WARN: DexScreener bonk.fun returned ${res.status}`); return; }
    const data: any = await res.json();
    const pairs = (data?.pairs ?? []).filter((p: any) =>
      p.chainId === 'solana' &&
      p.dexId === DEX_RAYDIUM_LAUNCHLAB &&
      p.pairCreatedAt &&
      (Date.now() - p.pairCreatedAt) < MAX_AGE_MS &&
      (p.liquidity?.usd ?? 0) > 10_000
    );
    let added = 0;
    for (const pair of pairs) {
      const mint        = pair.baseToken?.address;
      const symbol      = pair.baseToken?.symbol ?? '???';
      const graduatedAt = new Date(pair.pairCreatedAt).toISOString();
      const isBonk = (pair.info?.websites ?? []).some((w: any) =>
        (w.url ?? '').includes('bonk.fun') || (w.url ?? '').includes('letsbonk')
      );
      const source = isBonk ? 'bonk.fun' : 'raydium-launchlab';
      if (mint && addToWatchlist(seen, mint, symbol, source, graduatedAt)) added++;
    }
    if (added > 0) log(`[bonk.fun/launchlab] Added ${added} new graduated token(s)`);
    else log(`[bonk.fun/launchlab] No new graduates (found ${pairs.length} recent pairs)`);
  } catch (err: any) { log(`ERROR polling bonk.fun: ${err.message}`); }
}

async function pollBagsFm(seen: Set<string>) {
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { log(`WARN: DexScreener bags.fm returned ${res.status}`); return; }
    const profiles: any[] = await res.json();
    let checked = 0, added = 0;
    for (const profile of profiles) {
      if (profile.chainId !== 'solana') continue;
      const isBags =
        (profile.links ?? []).some((l: any) =>
          (l.url ?? '').toLowerCase().includes('bags.fm') ||
          (l.label ?? '').toLowerCase().includes('bags')
        ) || (profile.description ?? '').toLowerCase().includes('bags.fm');
      if (!isBags) continue;
      checked++;
      const mint = profile.tokenAddress;
      if (!mint || seen.has(mint)) continue;
      const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!pairRes.ok) continue;
      const pairData: any = await pairRes.json();
      const pairs = (pairData?.pairs ?? []).filter((p: any) =>
        p.chainId === 'solana' && (p.liquidity?.usd ?? 0) > 5_000
      );
      if (pairs.length === 0) continue;
      const pair      = pairs[0];
      const symbol    = pair.baseToken?.symbol ?? '???';
      const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : new Date().toISOString();
      if (addToWatchlist(seen, mint, symbol, 'bags.fm', createdAt)) added++;
    }
    if (added > 0) log(`[bags.fm] Added ${added} new graduated token(s)`);
    else log(`[bags.fm] No new graduates (checked ${checked} bags.fm profiles)`);
  } catch (err: any) { log(`ERROR polling bags.fm: ${err.message}`); }
}

async function main() {
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  log('═══════════════════════════════════════════════');
  log('  Graduation Watcher v2');
  log('  pump.fun  → Moralis API');
  log('  bonk.fun  → DexScreener (Raydium LaunchLab)');
  log('  bags.fm   → DexScreener (Meteora DBC)');
  log(`  Poll: ${POLL_INTERVAL / 1000}s | Max age: ${MAX_AGE_MS / 3_600_000}h | Cap: ${MAX_WATCHLIST}`);
  log('═══════════════════════════════════════════════');
  const seen = loadSeen();
  log(`Loaded ${seen.size} previously seen tokens`);
  const poll = async () => {
    await pollPumpFun(seen);
    await pollBonkFun(seen);
    await pollBagsFm(seen);
  };
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

main().catch(err => { console.error('Fatal watcher error:', err); process.exit(1); });
