import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config({ path: path.join(__dirname, '../config/.env') });

// ─────────────────────────────────────────────
//  GRADUATION WATCHER v3
//
//  pump.fun  → Official pump.fun WebSocket API (free, real-time, no rate limits)
//  bonk.fun  → DexScreener: new Raydium LaunchLab pairs
//  bags.fm   → DexScreener: new Meteora DBC pairs
//
//  No Moralis dependency — zero API limits.
// ─────────────────────────────────────────────

const WATCHLIST_PATH = path.join(__dirname, '../watchlist.json');
const SEEN_PATH      = path.join(__dirname, '../logs/watcher-seen.json');
const POLL_INTERVAL  = 30_000;
const MAX_WATCHLIST  = 50;
const MAX_AGE_MS     = 2 * 60 * 60 * 1000;
const PUMPFUN_WS     = 'wss://advanced-api.pump.fun/';

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
  log(`✅ Added [${source}] ${symbol} (${mint.slice(0, 8)}...) graduated ${ageMin}m ago`);
  return true;
}

// ── PUMP.FUN WEBSOCKET ────────────────────────────────────────────────────────

function startPumpFunWatcher(seen: Set<string>) {
  let reconnectDelay = 2_000;

  function connect() {
    log('[pump.fun] Connecting to WebSocket...');
    const ws = new WebSocket(PUMPFUN_WS, {
      headers: { 'Origin': 'https://pump.fun' },
    });

    ws.on('open', () => {
      log('[pump.fun] ✅ Connected — listening for graduations');
      reconnectDelay = 2_000;
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.txType === 'graduated' || msg.type === 'graduated' || msg.graduatedAt) {
          const mint      = msg.mint || msg.tokenAddress || msg.address;
          const symbol    = msg.symbol || msg.ticker || '???';
          const graduated = msg.graduatedAt || new Date().toISOString();
          if (mint) addToWatchlist(seen, mint, symbol, 'pump.fun', graduated);
        }
      } catch { }
    });

    ws.on('error', (err: any) => {
      log(`[pump.fun] WS error: ${err.message}`);
    });

    ws.on('close', (code: number) => {
      log(`[pump.fun] Closed (${code}) — reconnecting in ${reconnectDelay / 1000}s`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(ping);
    }, 30_000);
  }

  connect();
}

// ── DEXSCREENER PUMP.FUN FALLBACK ────────────────────────────────────────────

async function pollPumpFunFallback(seen: Set<string>) {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=pump&chainId=solana',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return;
    const data: any = await res.json();
    const pairs = (data?.pairs ?? []).filter((p: any) =>
      p.chainId === 'solana' &&
      (p.dexId === 'pump' || p.dexId === 'raydium') &&
      p.pairCreatedAt &&
      (Date.now() - p.pairCreatedAt) < MAX_AGE_MS &&
      (p.liquidity?.usd ?? 0) > 5_000 &&
      (p.info?.websites ?? []).some((w: any) => (w.url ?? '').includes('pump.fun'))
    );
    let added = 0;
    for (const pair of pairs) {
      const mint      = pair.baseToken?.address;
      const symbol    = pair.baseToken?.symbol ?? '???';
      const graduated = new Date(pair.pairCreatedAt).toISOString();
      if (mint && addToWatchlist(seen, mint, symbol, 'pump.fun-dex', graduated)) added++;
    }
    if (added > 0) log(`[pump.fun fallback] Added ${added} token(s)`);
  } catch (err: any) { log(`[pump.fun fallback] Error: ${err.message}`); }
}

// ── BONK.FUN ─────────────────────────────────────────────────────────────────

async function pollBonkFun(seen: Set<string>) {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=SOL&chainId=solana',
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) { log(`WARN: DexScreener bonk.fun returned ${res.status}`); return; }
    const data: any = await res.json();
    const pairs = (data?.pairs ?? []).filter((p: any) =>
      p.chainId === 'solana' &&
      p.dexId === 'raydium-launchlab' &&
      p.pairCreatedAt &&
      (Date.now() - p.pairCreatedAt) < MAX_AGE_MS &&
      (p.liquidity?.usd ?? 0) > 10_000
    );
    let added = 0;
    for (const pair of pairs) {
      const mint      = pair.baseToken?.address;
      const symbol    = pair.baseToken?.symbol ?? '???';
      const graduated = new Date(pair.pairCreatedAt).toISOString();
      const isBonk    = (pair.info?.websites ?? []).some((w: any) =>
        (w.url ?? '').includes('bonk.fun') || (w.url ?? '').includes('letsbonk')
      );
      const source = isBonk ? 'bonk.fun' : 'raydium-launchlab';
      if (mint && addToWatchlist(seen, mint, symbol, source, graduated)) added++;
    }
    if (added > 0) log(`[bonk.fun] Added ${added} token(s)`);
    else log(`[bonk.fun] No new graduates (${pairs.length} recent pairs checked)`);
  } catch (err: any) { log(`ERROR polling bonk.fun: ${err.message}`); }
}

// ── BAGS.FM ───────────────────────────────────────────────────────────────────

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
    if (added > 0) log(`[bags.fm] Added ${added} token(s)`);
    else log(`[bags.fm] No new graduates (checked ${checked} profiles)`);
  } catch (err: any) { log(`ERROR polling bags.fm: ${err.message}`); }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  log('═══════════════════════════════════════════════');
  log('  Graduation Watcher v3');
  log('  pump.fun  → WebSocket API (real-time, free)');
  log('  bonk.fun  → DexScreener (Raydium LaunchLab)');
  log('  bags.fm   → DexScreener (Meteora DBC)');
  log(`  Poll: ${POLL_INTERVAL / 1000}s | Max age: ${MAX_AGE_MS / 3_600_000}h | Cap: ${MAX_WATCHLIST}`);
  log('═══════════════════════════════════════════════');

  const seen = loadSeen();
  log(`Loaded ${seen.size} previously seen tokens`);

  startPumpFunWatcher(seen);

  const pollAll = async () => {
    await pollPumpFunFallback(seen);
    await pollBonkFun(seen);
    await pollBagsFm(seen);
  };

  await pollAll();
  setInterval(pollAll, POLL_INTERVAL);
}

main().catch(err => { console.error('Fatal watcher error:', err); process.exit(1); });
