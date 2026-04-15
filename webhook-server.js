/**
 * TradingView → Bitget Webhook Bridge
 * Deployed on Railway — no local machine required.
 *
 * Flow:
 *   TradingView alert fires → POST /webhook/:secret → execute Bitget trade
 *
 * TradingView alert message format (set this when creating each alert):
 *   {"signal":"buy","symbol":"{{ticker}}","price":{{close}},"setup":"A"}
 *   {"signal":"sell","symbol":"{{ticker}}","price":{{close}},"setup":"A"}
 *
 * Environment variables (set in Railway dashboard):
 *   WEBHOOK_SECRET      — secret token in the webhook URL (required)
 *   BITGET_API_KEY      — Bitget API key
 *   BITGET_SECRET_KEY   — Bitget secret key
 *   BITGET_PASSPHRASE   — Bitget passphrase
 *   PAPER_TRADE         — true (default) | false
 *   PAPER_USDT_START    — virtual starting balance (default 1000)
 *   TRADE_SIZE_USDT     — fixed $ per trade (default 1)
 *   PORT                — set automatically by Railway
 */

import express          from 'express';
import {
  isConfigured, getBalances, getPrice,
  placeOrder, getOrder, placeSellWithRetry,
  placeStopLoss, cancelPlanOrders,
}                       from './src/core/bitget.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT             || 3000;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET   || '';
const PAPER_TRADE      = process.env.PAPER_TRADE      !== 'false';
const PAPER_USDT_START = parseFloat(process.env.PAPER_USDT_START || '1000');
const TRADE_SIZE_USDT  = parseFloat(process.env.TRADE_SIZE_USDT  || '1');
const MAX_BUYS         = parseInt(process.env.MAX_BUYS           || '1');
const STOP_LOSS_PCT    = parseFloat(process.env.STOP_LOSS_PCT    || '0.5');
const SL_CHECK_MS      = parseInt(process.env.SL_CHECK_MS        || '30000');

if (!WEBHOOK_SECRET) {
  console.warn('⚠  WEBHOOK_SECRET is not set. Set it in Railway to secure your endpoint.');
}

// ── Symbol config ─────────────────────────────────────────────────────────────

const SYMBOLS = {
  BTCUSDT: { coin: 'BTC', decimals: 6 },
  ETHUSDT: { coin: 'ETH', decimals: 4 },
  XRPUSDT: { coin: 'XRP', decimals: 2 },
  SOLUSDT: { coin: 'SOL', decimals: 2 },
  BNBUSDT: { coin: 'BNB', decimals: 3 },
};

// ── Runtime state (in-memory, resets on redeploy) ────────────────────────────

const state = new Map(
  Object.keys(SYMBOLS).map((pair) => [pair, { holding: 'usdt', buyQty: 0, buyCount: 0, entryPrice: null }])
);

const paper = {
  usdt:      PAPER_USDT_START,
  positions: new Map(),
  trades:    [],
};

const recentSignals = []; // last 50 received webhooks for the status page

// ── Helpers ───────────────────────────────────────────────────────────────────

function floorTo(n, d) { return Math.floor(n * 10 ** d) / 10 ** d; }

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function waitForFill(orderId, pair, retries = 10) {
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const data   = await getOrder(orderId, pair);
      const filled = parseFloat(data?.baseVolume || 0);
      log(`   Fill check ${i + 1}/${retries} — orderId=${orderId} filled=${filled}`);
      if (filled > 0) return filled;
    } catch (err) { log(`   Fill check error: ${err.message}`); }
  }
  log(`⚠  waitForFill gave up after ${retries} attempts — orderId=${orderId}`);
  return 0;
}

// ── Paper trading ─────────────────────────────────────────────────────────────

function paperBuy(pair, usdtAmount, price, decimals) {
  const qty   = floorTo(usdtAmount / price, decimals);
  paper.usdt -= usdtAmount;
  paper.positions.set(pair, { qty, entryPrice: price, cost: usdtAmount, ts: new Date().toISOString() });
  paper.trades.push({ ts: new Date().toISOString(), pair, side: 'buy', qty, price, cost: usdtAmount });
  return { qty };
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

// ── Signal parsing ────────────────────────────────────────────────────────────

/**
 * Parse incoming webhook body.
 * Accepts JSON: { signal, symbol, price, setup }
 * Also accepts plain text containing "buy"/"sell" + a symbol.
 */
function parseWebhook(body) {
  // JSON format (preferred)
  if (typeof body === 'object' && body !== null) {
    const signal = (body.signal || '').toLowerCase();
    const symbol = (body.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
    const price  = parseFloat(body.price)  || null;
    const setup  = (body.setup  || '?').toUpperCase();
    if (signal === 'buy' || signal === 'sell') {
      return { action: signal, symbol, price, setup };
    }
  }

  // Plain text fallback — e.g. "📈 Setup A — Institutional Breakout BUY | Symbol: BTCUSDT | Price: 71000"
  if (typeof body === 'string') {
    const action  = /\bbuy\b/i.test(body)  ? 'buy'
                  : /\bsell\b/i.test(body) ? 'sell'
                  : null;
    const symMatch = body.match(/\b(BTC|ETH|XRP|SOL|BNB)USDT\b/i);
    const pxMatch  = body.match(/\b(\d+(?:\.\d+)?)\b/);
    const symbol   = symMatch ? symMatch[0].toUpperCase() : null;
    const price    = pxMatch  ? parseFloat(pxMatch[1])   : null;
    if (action && symbol) return { action, symbol, price, setup: '?' };
  }

  return null;
}

// ── Trade execution ───────────────────────────────────────────────────────────

async function executeTrade({ action, symbol, price: tvPrice, setup }) {
  const cfg = SYMBOLS[symbol];
  if (!cfg) {
    return { ok: false, reason: `Symbol ${symbol} not configured. Supported: ${Object.keys(SYMBOLS).join(', ')}` };
  }

  const { coin, decimals } = cfg;
  const s = state.get(symbol);

  // Fetch live price from Bitget (more accurate than TV alert price)
  let fillPrice = tvPrice;
  try {
    const ticker = await getPrice(symbol);
    fillPrice    = ticker.last;
  } catch { /* use TV price as fallback */ }

  // ── BUY ───────────────────────────────────────────────────────────────────
  if (action === 'buy') {
    if (s.holding === 'coin' && s.buyCount >= MAX_BUYS) {
      return { ok: false, reason: `Max buys (${MAX_BUYS}) reached for ${symbol}` };
    }

    const available = PAPER_TRADE ? paper.usdt : await getLiveUsdt();
    if (available < TRADE_SIZE_USDT) {
      return { ok: false, reason: `Insufficient USDT ($${available.toFixed(2)} < $${TRADE_SIZE_USDT})` };
    }

    if (PAPER_TRADE) {
      const { qty } = paperBuy(symbol, TRADE_SIZE_USDT, fillPrice, decimals);
      s.holding    = 'coin';
      s.buyQty    += qty;
      s.buyCount  += 1;
      s.entryPrice = fillPrice;
      log(`📄 PAPER BUY  ${symbol}  $${TRADE_SIZE_USDT} → ${qty.toFixed(decimals)} ${coin} @ ${fillPrice}  [Buy ${s.buyCount}/${MAX_BUYS}] [Setup ${setup}]`);
      return { ok: true, mode: 'paper', side: 'buy', qty, totalQty: s.buyQty, buyCount: s.buyCount, fillPrice };
    } else {
      const data  = await placeOrder({ symbol, side: 'buy', size: String(TRADE_SIZE_USDT), orderType: 'market' });
      const oid   = data?.orderId;
      let filled = await waitForFill(oid, symbol);
      // Fallback: if fill check returned 0, read actual coin balance from Bitget
      if (filled <= 0) {
        try {
          const assets = await getBalances([coin]);
          filled = parseFloat(assets[0]?.available || 0);
          log(`   Fill fallback — live ${coin} balance: ${filled}`);
        } catch { /* keep 0 */ }
      }
      s.holding    = 'coin';
      s.buyQty    += filled;
      s.buyCount  += 1;
      s.entryPrice = fillPrice;
      log(`✅ LIVE BUY   ${symbol}  $${TRADE_SIZE_USDT}  orderId=${oid}  filled=${filled} ${coin}  [Buy ${s.buyCount}/${MAX_BUYS}] [Setup ${setup}]`);

      // Place stop loss on Bitget
      let slOrderId = null;
      try {
        const slPrice = parseFloat((fillPrice * (1 - STOP_LOSS_PCT / 100)).toFixed(2));
        const slSize  = floorTo(s.buyQty, cfg.decimals);
        const slData  = await placeStopLoss({ symbol, size: slSize, triggerPrice: slPrice });
        slOrderId = slData?.orderId;
        log(`🛑 SL PLACED  ${symbol}  trigger=${slPrice}  size=${slSize}  orderId=${slOrderId}`);
      } catch (err) {
        log(`⚠  SL FAILED  ${symbol}  ${err.message}`);
      }

      return { ok: true, mode: 'live', side: 'buy', orderId: oid, filledQty: filled, totalQty: s.buyQty, buyCount: s.buyCount, slOrderId };
    }
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  if (action === 'sell') {
    // If buyQty is 0 (e.g. fill check failed), fall back to live balance
    if (s.holding === 'coin' && s.buyQty <= 0) {
      try {
        const assets = await getBalances([coin]);
        s.buyQty = parseFloat(assets[0]?.available || 0);
        log(`   Sell fallback — live ${coin} balance: ${s.buyQty}`);
      } catch { /* keep 0 */ }
    }

    if (s.holding !== 'coin' || s.buyQty <= 0) {
      return { ok: false, reason: `Not holding ${coin} for ${symbol}` };
    }

    const qty = floorTo(s.buyQty, decimals);

    if (PAPER_TRADE) {
      const { proceeds, pnl } = paperSell(symbol, qty, fillPrice);
      s.holding  = 'usdt';
      s.buyQty   = 0;
      s.buyCount   = 0;
      s.entryPrice = null;
      const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(4);
      log(`📄 PAPER SELL ${symbol}  ${qty.toFixed(decimals)} ${coin} @ ${fillPrice}  proceeds=$${proceeds.toFixed(4)}  PnL=${pnlStr}  [Setup ${setup}]`);
      return { ok: true, mode: 'paper', side: 'sell', qty, fillPrice, proceeds, pnl };
    } else {
      // Cancel any open stop loss plan orders before selling
      try { await cancelPlanOrders(symbol); } catch { /* ignore */ }

      const result = await placeSellWithRetry(symbol, qty, { coinSymbol: coin });
      if (result.ok) {
        s.holding  = 'usdt';
        s.buyQty   = 0;
        s.buyCount   = 0;
      s.entryPrice = null;
        log(`✅ LIVE SELL  ${symbol}  ${result.soldQty} ${coin}  orderId=${result.orderId}  [Setup ${setup}]`);
        return { ok: true, mode: 'live', side: 'sell', orderId: result.orderId, soldQty: result.soldQty };
      } else {
        // If dust is worth less than $1, reset state so future buys aren't blocked
        const dustValue = s.buyQty * fillPrice;
        if (dustValue < 1) {
          s.holding  = 'usdt';
          s.buyQty   = 0;
          s.buyCount   = 0;
      s.entryPrice = null;
          log(`⚠  DUST RESET ${symbol}  ${s.buyQty} ${coin} worth $${dustValue.toFixed(4)} — too small to sell, resetting state`);
          return { ok: false, reason: `Dust ignored ($${dustValue.toFixed(4)}) — state reset, ready to buy again` };
        }
        log(`❌ SELL FAIL  ${symbol}  ${result.error}`);
        return { ok: false, reason: result.error };
      }
    }
  }

  return { ok: false, reason: `Unknown action: ${action}` };
}

async function getLiveUsdt() {
  try {
    const assets = await getBalances(['USDT']);
    return parseFloat(assets[0]?.available || 0);
  } catch { return 0; }
}


// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ strict: false }));
app.use(express.text());

// ── POST /webhook/:secret ─────────────────────────────────────────────────────
app.post('/webhook/:secret', async (req, res) => {
  // Auth
  if (WEBHOOK_SECRET && req.params.secret !== WEBHOOK_SECRET) {
    log(`⛔ Rejected webhook — wrong secret`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw    = req.body;
  const signal = parseWebhook(raw);

  const record = {
    ts:     new Date().toISOString(),
    raw:    typeof raw === 'object' ? raw : String(raw).slice(0, 200),
    parsed: signal,
    result: null,
  };

  if (!signal) {
    log(`⚠  Unparseable webhook body: ${JSON.stringify(raw)?.slice(0, 100)}`);
    record.result = { ok: false, reason: 'Could not parse signal from body' };
    recentSignals.unshift(record);
    if (recentSignals.length > 50) recentSignals.pop();
    return res.status(400).json(record.result);
  }

  log(`📨 Webhook received — ${signal.action.toUpperCase()} ${signal.symbol}  setup=${signal.setup}  price=${signal.price}`);

  if (!isConfigured()) {
    record.result = { ok: false, reason: 'Bitget credentials not configured' };
    recentSignals.unshift(record);
    if (recentSignals.length > 50) recentSignals.pop();
    return res.status(503).json(record.result);
  }

  // Respond immediately so TradingView doesn't time out — process trade in background
  res.status(202).json({ ok: true, status: 'processing', signal });

  let result;
  try {
    result = await executeTrade(signal);
  } catch (err) {
    log(`❌ Unhandled error in executeTrade: ${err.message}`);
    result = { ok: false, reason: err.message };
  }
  record.result = result;
  recentSignals.unshift(record);
  if (recentSignals.length > 50) recentSignals.pop();
  log(`📋 Trade result — ${result.ok ? '✅' : '❌'} ${JSON.stringify(result)}`);
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    mode:        PAPER_TRADE ? 'paper' : 'live',
    trade_size:  `$${TRADE_SIZE_USDT}`,
    configured:  isConfigured(),
    uptime_s:    Math.floor(process.uptime()),
  });
});

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  const positions = [];

  for (const [pair, s] of state.entries()) {
    const pos = { pair, holding: s.holding };
    if (s.holding === 'coin' && s.buyQty > 0) {
      pos.qty      = s.buyQty;
      pos.buyCount = `${s.buyCount}/${MAX_BUYS}`;
      if (PAPER_TRADE) {
        const paperPos = paper.positions.get(pair);
        pos.entryPrice = paperPos?.entryPrice;
        try {
          const { last } = await getPrice(pair);
          pos.currentPrice = last;
          pos.unrealisedPnl = parseFloat(((last - pos.entryPrice) * s.buyQty).toFixed(6));
        } catch { /* skip */ }
      }
    }
    positions.push(pos);
  }

  const realisedPnl = PAPER_TRADE
    ? paper.trades.filter((t) => t.side === 'sell').reduce((sum, t) => sum + t.pnl, 0)
    : null;

  res.json({
    mode:          PAPER_TRADE ? 'paper' : 'live',
    trade_size:    TRADE_SIZE_USDT,
    paper_usdt:    PAPER_TRADE ? paper.usdt : null,
    realised_pnl:  realisedPnl,
    positions,
    recent_trades: PAPER_TRADE ? paper.trades.slice(-10).reverse() : [],
    recent_signals: recentSignals.slice(0, 10),
  });
});

// ── GET / — setup instructions ────────────────────────────────────────────────
app.get('/', (req, res) => {
  const secret = WEBHOOK_SECRET ? '<your-secret>' : 'NOT_SET';
  const host   = req.headers.host || 'your-app.railway.app';
  res.type('text').send([
    'TradingView → Bitget Webhook Bridge',
    '─'.repeat(40),
    '',
    `Mode        : ${PAPER_TRADE ? 'PAPER (no real orders)' : '🔴 LIVE'}`,
    `Trade size  : $${TRADE_SIZE_USDT} per signal`,
    `Bitget creds: ${isConfigured() ? '✅ configured' : '❌ missing — set BITGET_API_KEY etc.'}`,
    `Webhook URL : POST https://${host}/webhook/${secret}`,
    '',
    'TradingView alert message format:',
    '  {"signal":"buy","symbol":"{{ticker}}","price":{{close}},"setup":"A"}',
    '  {"signal":"sell","symbol":"{{ticker}}","price":{{close}},"setup":"A"}',
    '',
    'Endpoints:',
    `  GET  /health  — liveness check`,
    `  GET  /status  — positions + P&L + recent signals`,
    `  POST /webhook/:secret — receive TradingView alerts`,
  ].join('\n'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 Webhook server running on port ${PORT}`);
  log(`   Mode       : ${PAPER_TRADE ? '📄 PAPER' : '🔴 LIVE'}`);
  log(`   Trade size : $${TRADE_SIZE_USDT}`);
  log(`   Bitget     : ${isConfigured() ? '✅ configured' : '❌ credentials missing'}`);
  log(`   Webhook    : POST /webhook/${WEBHOOK_SECRET || '<set WEBHOOK_SECRET>'}`);
});
