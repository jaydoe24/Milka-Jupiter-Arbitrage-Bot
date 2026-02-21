# 🚀 Milka Bot — Deployment Guide (Step by Step)

Follow this exactly. Every command is copy-pasteable.

---

## STEP 1 — SSH into your VPS

```bash
ssh root@YOUR_VPS_IP
```

---

## STEP 2 — Clone / update your GitHub repo

If first time:
```bash
cd ~
git clone https://github.com/jaydoe24/Milka-Jupiter-Arbitrage-Bot.git
cd Milka-Jupiter-Arbitrage-Bot
```

If already cloned:
```bash
cd ~/Milka-Jupiter-Arbitrage-Bot
git pull origin main
```

---

## STEP 3 — Create your config file

```bash
cp config/.env.example config/.env
nano config/.env
```

Fill in these values:
- `NETWORK=devnet`              ← devnet FIRST, always
- `RPC_URL=` your Helius devnet URL
- `WS_URL=`  your Helius devnet WSS URL
- `PRIVATE_KEY=` your burner wallet base58 key
- `TRADE_AMOUNT=0.02`           ← small for devnet testing

Save: `Ctrl+X` → `Y` → `Enter`

---

## STEP 4 — Airdrop devnet SOL to your burner wallet

```bash
solana airdrop 2 YOUR_WALLET_ADDRESS --url devnet
```

If solana CLI not installed:
```bash
sh -c "$(curl -sSfL https://release.solana.com/v1.18.4/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

---

## STEP 5 — Build and start the bot (Docker)

```bash
chmod +x scripts/*.sh
./scripts/start.sh
```

This builds the Docker image and starts the container.

---

## STEP 6 — Watch the logs

```bash
./scripts/logs.sh
```

**What you should see on devnet:**
```
[INFO] Milka Jupiter Arbitrage Bot  🔵 DEVNET
[INFO] Wallet: YOUR_WALLET_ADDRESS
[INFO] Balance: 2.0000 SOL
[INFO] Scanning 35 tokens...
[DEBUG] No opportunity: BONK (profit: -0.000023 SOL)
[DEBUG] No opportunity: WIF  (profit: -0.000011 SOL)
```

Seeing logs = bot is working. No opportunities on devnet is NORMAL —
devnet has no real liquidity. The scan cycle itself is what you're verifying.

---

## STEP 7 — Verify it's healthy

```bash
docker ps
```
Should show: `milka-jupiter-arbitrage-bot` with status `Up X minutes`

```bash
cat logs/info.log | tail -20
```

---

## STEP 8 — Switch to mainnet

Once devnet logs look clean (no crashes, scans running):

```bash
nano config/.env
```

Change:
```
NETWORK=mainnet
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
TRADE_AMOUNT=0.02    ← keep small for first 24h
```

Restart:
```bash
./scripts/stop.sh
./scripts/start.sh
./scripts/logs.sh
```

**On mainnet you should see opportunities within minutes.**

---

## STEP 9 — Optional: Set up Telegram alerts

1. Open Telegram → message `@BotFather`
2. Send `/newbot` → follow prompts → copy the token
3. Message `@userinfobot` → copy your chat ID
4. Add to `config/.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   ```
5. Restart the bot

---

## Commands reference

| Command | What it does |
|---------|-------------|
| `./scripts/start.sh` | Build + start bot |
| `./scripts/stop.sh` | Stop bot |
| `./scripts/logs.sh` | Live log stream |
| `./scripts/update.sh` | Pull latest code + restart |
| `docker ps` | Check container status |
| `cat logs/stats.json` | See trade statistics |

---

## Troubleshooting

**"Missing env vars"**
→ Check `config/.env` exists and has RPC_URL + PRIVATE_KEY filled in

**"Balance too low"**
→ Fund your wallet with at least `TRADE_AMOUNT + 0.05` SOL

**"Simulation failed, skipping" (many times)**
→ Normal — bot is protecting you from bad trades. Lower `MIN_PROFIT_PERCENT` to `0.3` if you want to see more attempts.

**"SELL FAILED — token stranded"**
→ Check wallet on Solscan. Manually sell the token. Then check RPC latency.

**Container keeps restarting**
→ `docker logs milka-jupiter-arbitrage-bot` to see the error

---

## What "good" mainnet logs look like

```
[INFO]    Scanning 38 tokens...
[INFO]    🎯 OPPORTUNITY: POPCAT | profit: 0.000312 SOL | pct: 0.62%
[SUCCESS] ✅ BUY  : 4xKp9mN...
[SUCCESS] ✅ SELL : 8zRq2nL...
[SUCCESS] 💰 PROFIT: 0.000289 SOL (0.58%) in 1843ms
[INFO]    Scanning 38 tokens...
[DEBUG]   No opportunity: WIF  (profit: -0.000011 SOL)
```

---

Ready. Follow these 9 steps and report back what you see in the logs.
