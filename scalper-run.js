/**
 * TradingView → Bitget Bridge Scalper
 *
 * TradingView IS the signal engine — no internal indicators here.
 * The SMC Scalper Pine Script ("SMC Scalper v1.0") must be loaded on
 * the TradingView chart. This script cycles through each symbol by
 * switching the TV chart, reads the latest signal label drawn by the
 * Pine Script, then executes the corresponding trade on Bitget spot.
 *
 * Setup:
 *   1. Open TradingView Desktop with --remote-debugging-port=9222
 *   2. Add the SMC Scalper Pine Script to your chart
 *   3. Fill in Bitget credentials + settings in .env
 *   4. node scalper-run.js
 */

import { getPineLabels }                        from './src/core/data.js';
import { setSymbol, getState }                  from './src/core/chart.js';
import {
  isConfigured, getBalances, getPrice,
  placeOrder, getOrder,
  placeSellWithRetry, validateSymbols,
}                                               from './src/core/bitget.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// ── Config (all overridable via .env) ─────────────────────────────────────────

const PAPER_TRADE       = process.env.PAPER_TRADE      !== 'false'; // default ON
const PAPER_USDT_START  = parseFloat(process.env.PAPER_USDT_START  || '1000');
const TRADE_SIZE_USDT   = parseFloat(process.env.TRADE_SIZE_USDT   || '1');
const INTERVAL_MS       = parseInt(process.env.INTERVAL_MS         || '30000'); // 30s between full cycles
const CHART_SETTLE_MS   = parseInt(process.env.CHART_SETTLE_MS     || '2000');  // wait after switching symbol
const STUDY_FILTER      = process.env.STUDY_FILTER                 || 'SMC Scalper';

// ── Symbol table ──────────────────────────────────────────────────────────────
// tvSymbol  : the symbol name to set in TradingView (exchange-prefixed if needed)
// pair      : the Bitget spot symbol
// coin      : base asset name (used for sell sizing + lock retry)
// decimals  : precision for sell quantity

const SYMBOLS = [
  { tvSymbol: 'BTCUSDT', pair: 'BTCUSDT', coin: 'BTC', decimals: 6 },
  { tvSymbol: 'ETHUSDT', pair: 'ETHUSDT', coin: 'ETH', decimals: 4 },
  { tvSymbol: 'XRPUSDT', pair: 'XRPUSDT', coin: 'XRP', decimals: 2 },
  { tvSymbol: 'SOLUSDT', pair: 'SOLUSDT', coin: 'SOL', decimals: 2 },
  { tvSymbol: 'BNBUSDT', pair: 'BNBUSDT', coin: 'BNB', decimals: 3 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function floorTo(n, d) { return Math.floor(n * 10 ** d) / 10 ** d; }
function sleep(ms)     { return new Promise((r) => setTimeout(r, ms)); }
function pad(s, n)     { return String(s).padEnd(n); }
function pnlStr(n)     { return (n >= 0 ? '+' : '') + n.toFixed(4); }

/** Parse the most recent Pine Script label → action + metadata */
function parseLatestSignal(labels = []) {
  if (!labels.length) return { action: 'flat', text: null, price: null };
  // Labels are returned oldest-first; the last entry is the most recent signal
  const latest = labels[labels.length - 1];
  const text   = (latest.text || '').trim();
  const price  = latest.price ?? null;
  if (/buy/i.test(text))  return { action: 'buy',  text, price };
  if (/sell/i.test(text)) return { action: 'sell', text, price };
  return { action: 'flat', text, price };
}

/** Unique key for a signal — used to avoid re-executing the same label twice */
function signalKey(text, price) {
  return `${text}@${price ?? '?'}`;
}

async function waitForFill(orderId, pair, retries = 5) {
  for (let i = 0; i < retries; i++) {
    await sleep(1000);
    try {
      const data   = await getOrder(orderId, pair);
      const filled = parseFloat(data?.baseVolume || 0);
      if (filled > 0) return filled;
    } catch { /* retry */ }
  }
  return 0;
}

// ── Paper trading ─────────────────────────────────────────────────────────────

const paper = {
  usdt:      PAPER_USDT_START,
  positions: new Map(), // pair → { qty, entryPrice, cost }
  trades:    [],
};

function paperBuy(pair, usdtAmount, price, decimals) {
  const qty        = floorTo(usdtAmount / price, decimals);
  paper.usdt      -= usdtAmount;
  paper.positions.set(pair, { qty, entryPrice: price, cost: usdtAmount });
  paper.trades.push({ ts: new Date().toISOString(), pair, side: 'buy', qty, price, cost: usdtAmount });
  return { qty, cost: usdtAmount };
}

function paperSell(pair, qty, price) {
  const proceeds = qty * price;
  const pos      = paper.positions.get(pair);
  const pnl      = pos ? (price - pos.entryPrice) * qty : 0;
  paper.usdt    += proceeds;
  paper.positions.delete(pair);
  paper.trades.push({ ts: new Date().toISOString(), pair, side: 'sell', qty, price, proceeds, pnl });
  return { proceeds, pnl };
}

// ── Signal reading from TradingView ───────────────────────────────────────────

/**
 * Switch TradingView to `tvSymbol`, wait for the Pine Script to settle,
 * then return the latest signal from the SMC Scalper indicator.
 */
async function readTVSignal(tvSymbol) {
  await setSymbol({ symbol: tvSymbol });
  await sleep(CHART_SETTLE_MS); // Pine needs time to recalculate on the new symbol

  const result = await getPineLabels({ study_filter: STUDY_FILTER, max_labels: 5 });
  const study  = result?.studies?.[0];

  if (!study) {
    return { action: 'flat', text: null, price: null, studyFound: false };
  }

  return { ...parseLatestSignal(study.labels), studyFound: true, labelCount: study.total_labels };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!isConfigured()) {
    console.error('❌  Bitget credentials missing. Add BITGET_API_KEY, BITGET_SECRET_KEY and BITGET_PASSPHRASE to .env');
    process.exit(1);
  }

  // ── Symbol availability check ─────────────────────────────────────────────
  console.log('\n🔍  Checking symbol availability on Bitget spot market...');
  let activeSymbols;
  try {
    const { available, unavailable } = await validateSymbols(SYMBOLS.map((s) => s.pair));
    if (unavailable.length) {
      console.warn(`  ⚠  Not on Bitget spot: ${unavailable.join(', ')} — skipping`);
    }
    if (!available.length) {
      console.error('  ❌  No symbols available. Exiting.');
      process.exit(1);
    }
    activeSymbols = SYMBOLS.filter((s) => available.includes(s.pair));
    console.log(`  ✅  Active: ${activeSymbols.map((s) => s.pair).join(', ')}`);
  } catch (err) {
    console.error(`  ❌  Symbol check failed: ${err.message}`);
    process.exit(1);
  }

  // ── TradingView connection check ──────────────────────────────────────────
  console.log('\n📡  Checking TradingView connection...');
  try {
    const state = await getState();
    console.log(`  ✅  TradingView connected — currently on ${state.symbol} (${state.resolution}m)`);
    const hasSMC = state.studies?.some((s) => s.name?.includes('SMC'));
    if (!hasSMC) {
      console.warn(`  ⚠  "${STUDY_FILTER}" not detected on current chart.`);
      console.warn(`     Add the SMC Scalper Pine Script indicator to your TradingView chart before trading.`);
    }
  } catch (err) {
    console.error(`  ❌  TradingView not reachable: ${err.message}`);
    console.error(`     Make sure TradingView is running with --remote-debugging-port=9222`);
    process.exit(1);
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  const modeTag = PAPER_TRADE
    ? `📄  PAPER MODE  (virtual $${PAPER_USDT_START.toFixed(2)} USDT — no real orders)`
    : `🔴  LIVE MODE   (real orders on Bitget)`;

  console.log(`\n🤖  TradingView → Bitget Bridge Scalper`);
  console.log(`    Signal engine : TradingView Pine Script ("${STUDY_FILTER}")`);
  console.log(`    ${modeTag}`);
  console.log(`Symbols  : ${activeSymbols.map((s) => s.pair).join(', ')}`);
  console.log(`Interval : ${INTERVAL_MS / 1000}s between cycles  |  Chart settle: ${CHART_SETTLE_MS / 1000}s`);
  console.log(`Trade    : $${TRADE_SIZE_USDT.toFixed(2)} per symbol`);
  console.log(`\nPress Ctrl+C to stop.\n`);

  // ── State ─────────────────────────────────────────────────────────────────
  const state      = new Map(activeSymbols.map((s) => [s.pair, { holding: 'usdt', buyQty: 0 }]));
  const lastActed  = new Map(); // pair → signal key we last executed
  const log        = [];
  let   cycle      = 0;

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log('\n\n⛔  Stopping scalper...');
    await printSummary(activeSymbols, state);
    persistLog(log);
    process.exit(0);
  });

  // ── Main loop (runs indefinitely) ─────────────────────────────────────────
  while (true) {
    cycle++;
    const ts = new Date().toISOString();

    console.log(`\n${'─'.repeat(66)}`);
    console.log(`Cycle ${cycle}  ${ts}${PAPER_TRADE ? '  [PAPER]' : '  [LIVE]'}`);
    console.log('─'.repeat(66));

    // Current balance
    let usdtBalance = PAPER_TRADE ? paper.usdt : 0;
    if (!PAPER_TRADE) {
      try {
        const assets  = await getBalances(['USDT']);
        usdtBalance   = parseFloat(assets[0]?.available || 0);
      } catch (err) {
        console.warn(`  ⚠  Balance fetch failed: ${err.message}`);
      }
    }
    console.log(`  USDT balance: $${usdtBalance.toFixed(4)}  |  Trade size: $${TRADE_SIZE_USDT.toFixed(2)}\n`);

    for (const sym of activeSymbols) {
      const { tvSymbol, pair, coin, decimals } = sym;
      const s     = state.get(pair);
      const entry = { cycle, ts, pair, paper: PAPER_TRADE, holding: s.holding };

      try {
        // ── Read signal from TradingView ────────────────────────────────────
        const { action, text, price, studyFound } = await readTVSignal(tvSymbol);

        if (!studyFound) {
          console.log(`  ${pad(pair, 9)} ⚠  "${STUDY_FILTER}" not found on chart — add indicator in TradingView`);
          entry.error = 'study_not_found';
          log.push(entry);
          continue;
        }

        // Dedup — skip if this is the same signal we already acted on
        const key     = signalKey(text, price);
        const prevKey = lastActed.get(pair);
        const isNew   = key !== prevKey && action !== 'flat';

        console.log(
          `  ${pad(pair, 9)}` +
          `tv_signal=${pad(action.toUpperCase(), 5)}  ` +
          `label="${text ?? 'none'}"  ` +
          `${isNew ? '🆕' : '↩ same'}  ` +
          `holding=${s.holding.toUpperCase()}`
        );

        Object.assign(entry, { action, tvLabel: text, tvPrice: price, isNew });

        if (!isNew || action === 'flat') {
          entry.skipped = true;
          entry.skipReason = action === 'flat' ? 'no_signal' : 'duplicate_signal';
          log.push(entry);
          continue;
        }

        // ── Get current Bitget price for paper fills ────────────────────────
        let currentPrice = price; // use Pine label price as fallback
        try {
          const ticker = await getPrice(pair);
          currentPrice = ticker.last;
        } catch { /* use Pine price */ }

        // ── BUY ─────────────────────────────────────────────────────────────
        if (action === 'buy' && s.holding === 'usdt') {
          const alloc = TRADE_SIZE_USDT;
          if ((PAPER_TRADE ? paper.usdt : usdtBalance) < alloc) {
            console.log(`    ⏭  Skip BUY — insufficient USDT ($${(PAPER_TRADE ? paper.usdt : usdtBalance).toFixed(2)} < $${alloc})`);
            entry.skipped = true; entry.skipReason = 'insufficient_usdt';
          } else if (PAPER_TRADE) {
            const { qty, cost } = paperBuy(pair, alloc, currentPrice, decimals);
            s.holding = 'coin'; s.buyQty = qty;
            console.log(`    📄 PAPER BUY  $${cost.toFixed(4)} → ${qty.toFixed(decimals)} ${coin} @ ${currentPrice.toFixed(5)}`);
            Object.assign(entry, { side: 'buy', cost, qty, fillPrice: currentPrice, orderPlaced: true });
            lastActed.set(pair, key);
          } else {
            const size = alloc.toFixed(4);
            const data = await placeOrder({ symbol: pair, side: 'buy', size, orderType: 'market' });
            const oid  = data?.orderId;
            console.log(`    ✅ BUY placed — ${oid}`);
            const filled = await waitForFill(oid, pair);
            s.holding = 'coin'; s.buyQty = filled;
            console.log(`    📦 Filled: ${filled.toFixed(decimals)} ${coin}`);
            Object.assign(entry, { side: 'buy', size, orderId: oid, filledQty: filled, orderPlaced: true });
            lastActed.set(pair, key);
          }

        // ── SELL ─────────────────────────────────────────────────────────────
        } else if (action === 'sell' && s.holding === 'coin' && s.buyQty > 0) {
          const qty = floorTo(s.buyQty, decimals);
          if (PAPER_TRADE) {
            const { proceeds, pnl } = paperSell(pair, qty, currentPrice);
            s.holding = 'usdt'; s.buyQty = 0;
            console.log(`    📄 PAPER SELL ${qty.toFixed(decimals)} ${coin} @ ${currentPrice.toFixed(5)} → $${proceeds.toFixed(4)}  PnL: ${pnlStr(pnl)}`);
            Object.assign(entry, { side: 'sell', qty, proceeds, pnl, fillPrice: currentPrice, orderPlaced: true });
            lastActed.set(pair, key);
          } else {
            const result = await placeSellWithRetry(pair, qty, { coinSymbol: coin });
            if (result.ok) {
              console.log(`    ✅ SELL placed — ${result.orderId}  (${result.soldQty} ${coin})`);
              s.holding = 'usdt'; s.buyQty = 0;
              Object.assign(entry, { side: 'sell', qty, orderId: result.orderId, soldQty: result.soldQty, orderPlaced: true });
              lastActed.set(pair, key);
            } else {
              console.log(`    ❌ SELL failed — ${result.error}`);
              Object.assign(entry, { side: 'sell', orderPlaced: false, error: result.error });
            }
          }

        // ── Signal exists but can't act (e.g. buy signal while already holding) ──
        } else {
          console.log(`    ⏭  Skip — signal=${action} but holding=${s.holding}`);
          entry.skipped = true; entry.skipReason = `signal=${action}_holding=${s.holding}`;
          lastActed.set(pair, key); // still mark as seen so we don't retry
        }

      } catch (err) {
        console.error(`    ❌ Error (${pair}): ${err.message}`);
        entry.error = err.message;
      }

      log.push(entry);
    }

    console.log(`\n  ⏱  Next cycle in ${INTERVAL_MS / 1000}s...`);
    await sleep(INTERVAL_MS);
  }
}

// ── Summary + log helpers ─────────────────────────────────────────────────────

async function printSummary(activeSymbols, state) {
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`📊  Session summary  ${PAPER_TRADE ? '[PAPER]' : '[LIVE]'}`);
  console.log('═'.repeat(66));

  if (PAPER_TRADE) {
    let totalValue = paper.usdt;
    for (const sym of activeSymbols) {
      const pos = paper.positions.get(sym.pair);
      if (pos) {
        try {
          const { last } = await getPrice(sym.pair);
          const value     = pos.qty * last;
          totalValue     += value;
          console.log(`  ${pad(sym.pair, 9)} HOLDING ${pos.qty.toFixed(sym.decimals)} ${sym.coin}  entry=$${pos.entryPrice.toFixed(5)}  now=$${last.toFixed(5)}  PnL: ${pnlStr((last - pos.entryPrice) * pos.qty)}`);
        } catch {
          console.log(`  ${pad(sym.pair, 9)} HOLDING ${pos.qty.toFixed(sym.decimals)} ${sym.coin}`);
        }
      } else {
        console.log(`  ${pad(sym.pair, 9)} FLAT`);
      }
    }
    const realised = paper.trades.filter((t) => t.side === 'sell').reduce((s, t) => s + t.pnl, 0);
    console.log(`\n  Start : $${PAPER_USDT_START.toFixed(4)}`);
    console.log(`  Cash  : $${paper.usdt.toFixed(4)}`);
    console.log(`  Total : $${totalValue.toFixed(4)}`);
    console.log(`  PnL   : ${pnlStr(realised)} (realised)`);
    if (paper.trades.length) {
      console.log(`\n  Trade history:`);
      paper.trades.forEach((t) => {
        if (t.side === 'buy')
          console.log(`    BUY  ${t.pair}  ${t.qty.toFixed(4)} @ ${t.price.toFixed(5)}  cost=$${t.cost.toFixed(4)}`);
        else
          console.log(`    SELL ${t.pair}  ${t.qty.toFixed(4)} @ ${t.price.toFixed(5)}  proceeds=$${t.proceeds.toFixed(4)}  PnL=${pnlStr(t.pnl)}`);
      });
    }
  }
  console.log('═'.repeat(66));
}

function persistLog(log) {
  const logPath  = 'safety-check-log.json';
  const existing = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : [];
  writeFileSync(logPath, JSON.stringify([...existing, ...log], null, 2));
  console.log(`✅  Log saved → ${logPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
