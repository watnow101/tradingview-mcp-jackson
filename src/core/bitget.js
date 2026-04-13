/**
 * Bitget Spot API client.
 * Reads credentials from env vars: BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
 *
 * All public functions throw on API errors so callers can catch uniformly.
 */

import { createHmac } from 'crypto';
import https from 'https';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env from project root (safe to call multiple times — dotenv is idempotent)
const __root = join(dirname(fileURLToPath(import.meta.url)), '../../');
loadDotenv({ path: join(__root, '.env') });

// ─── Credentials ────────────────────────────────────────────────────────────

export function getCredentials() {
  return {
    apiKey:     process.env.BITGET_API_KEY     || '',
    secret:     process.env.BITGET_SECRET_KEY  || '',
    passphrase: process.env.BITGET_PASSPHRASE  || '',
  };
}

export function isConfigured() {
  const c = getCredentials();
  return !!(c.apiKey && c.secret && c.passphrase);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Unauthenticated GET — for public endpoints that need no credentials */
function publicGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.bitget.com', path, method: 'GET',
        headers: { 'Content-Type': 'application/json', locale: 'en-US' } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { reject(new Error(`Bitget returned non-JSON: ${d.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function sign(secret, ts, method, path, body = '') {
  return createHmac('sha256', secret)
    .update(ts + method + path + body)
    .digest('base64');
}

const BITGET_DEMO = process.env.BITGET_DEMO === 'true';

function apiRequest(creds, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const ts      = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const sig     = sign(creds.secret, ts, method, path, bodyStr);

    const headers = {
      'Content-Type':       'application/json',
      'ACCESS-KEY':         creds.apiKey,
      'ACCESS-SIGN':        sig,
      'ACCESS-TIMESTAMP':   ts,
      'ACCESS-PASSPHRASE':  creds.passphrase,
      locale:               'en-US',
    };
    if (BITGET_DEMO) headers['paptrading'] = '1';

    const req = https.request(
      {
        hostname: 'api.bitget.com',
        path,
        method,
        headers,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { reject(new Error(`Bitget returned non-JSON: ${d.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Convenience wrapper — throws if code !== '00000' */
async function api(method, path, body = null) {
  if (!isConfigured()) {
    throw new Error(
      'Bitget credentials missing. Add BITGET_API_KEY, BITGET_SECRET_KEY and BITGET_PASSPHRASE to .env'
    );
  }
  const res = await apiRequest(getCredentials(), method, path, body);
  if (res.code !== '00000') throw new Error(`Bitget API error ${res.code}: ${res.msg}`);
  return res.data;
}

// ─── Account ─────────────────────────────────────────────────────────────────

/**
 * Get spot account balances.
 * @param {string[]} coins  Optional filter, e.g. ['USDT','BTC']. Empty = all.
 * @returns {Array<{coin, available, frozen, locked}>}
 */
export async function getBalances(coins = []) {
  const data = await api('GET', '/api/v2/spot/account/assets');
  const assets = data || [];
  return coins.length ? assets.filter((a) => coins.includes(a.coin)) : assets;
}

// ─── Market data ─────────────────────────────────────────────────────────────

/**
 * Get current ticker for a symbol.
 * @returns {{ symbol, last, bid, ask, high24h, low24h, vol24h, change24h }}
 */
export async function getPrice(symbol) {
  const data = await api('GET', `/api/v2/spot/market/tickers?symbol=${symbol.toUpperCase()}`);
  const t = Array.isArray(data) ? data[0] : data;
  if (!t) throw new Error(`No ticker data for ${symbol}`);
  return {
    symbol:   t.symbol,
    last:     parseFloat(t.lastPr   || 0),
    bid:      parseFloat(t.bidPr    || 0),
    ask:      parseFloat(t.askPr    || 0),
    high24h:  parseFloat(t.high24h  || 0),
    low24h:   parseFloat(t.low24h   || 0),
    vol24h:   parseFloat(t.baseVolume || 0),
    change24h: parseFloat(t.change24h || 0),
  };
}

/**
 * Get OHLCV candles.
 * @param {string} symbol      e.g. 'BTCUSDT'
 * @param {string} granularity e.g. '1min','5min','15min','1h','4h','1day'
 * @param {number} limit       Max candles to return
 */
export async function getCandles(symbol, granularity = '1min', limit = 30) {
  const data = await api(
    'GET',
    `/api/v2/spot/market/candles?symbol=${symbol.toUpperCase()}&granularity=${granularity}&limit=${limit}`
  );
  return (data || []).map((c) => ({
    ts:    parseInt(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol:   parseFloat(c[5]),
  }));
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Place a spot order.
 *
 * @param {object} opts
 * @param {string}  opts.symbol      Trading pair e.g. 'BTCUSDT'
 * @param {string}  opts.side        'buy' | 'sell'
 * @param {string}  opts.size        Order size (quote for market buy, base for market sell / limit)
 * @param {string}  [opts.orderType] 'market' (default) | 'limit'
 * @param {string}  [opts.price]     Required for limit orders
 * @param {string}  [opts.clientOid] Optional idempotency key
 * @returns {{ orderId: string }}
 */
export async function placeOrder({ symbol, side, size, orderType = 'market', price = null, clientOid = null }) {
  const body = {
    symbol:    symbol.toUpperCase(),
    side,
    orderType,
    force:     'gtc',
    size:      String(size),
  };
  if (orderType === 'limit' && price) body.price = String(price);
  if (clientOid) body.clientOid = clientOid;

  const data = await api('POST', '/api/v2/spot/trade/place-order', body);
  return data; // { orderId, clientOid }
}

/**
 * Get info on a single order.
 */
export async function getOrder(orderId, symbol) {
  const data = await api(
    'GET',
    `/api/v2/spot/trade/orderInfo?orderId=${orderId}&symbol=${symbol.toUpperCase()}`
  );
  return data;
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId, symbol) {
  const data = await api('POST', '/api/v2/spot/trade/cancel-order', {
    orderId,
    symbol: symbol.toUpperCase(),
  });
  return data;
}

/**
 * List unfilled (open) orders.
 * @param {string|null} symbol  Filter by pair, or null for all.
 */
export async function getOpenOrders(symbol = null) {
  const qs   = symbol ? `?symbol=${symbol.toUpperCase()}` : '';
  const data = await api('GET', `/api/v2/spot/trade/unfilled-orders${qs}`);
  return data || [];
}

/**
 * Get filled / cancelled order history.
 * @param {string|null} symbol
 * @param {number}      limit   Max records (1–100)
 */
export async function getOrderHistory(symbol = null, limit = 20) {
  const qs   = symbol
    ? `?symbol=${symbol.toUpperCase()}&limit=${limit}`
    : `?limit=${limit}`;
  const data = await api('GET', `/api/v2/spot/trade/history-orders${qs}`);
  return data || [];
}

// ─── Symbol validation (public — no auth required) ───────────────────────────

/**
 * Fetch every symbol available on the Bitget spot market.
 * Uses the public /symbols endpoint — no credentials needed.
 * @returns {Set<string>}  Upper-cased symbol names e.g. Set { 'BTCUSDT', 'ETHUSDT', … }
 */
export async function getSpotSymbols() {
  const res = await publicGet('/api/v2/spot/public/symbols');
  if (res.code !== '00000') throw new Error(`Bitget symbols fetch failed: ${res.msg}`);
  return new Set((res.data || []).map((s) => s.symbol.toUpperCase()));
}

/**
 * Check which of the requested pairs actually exist on Bitget spot.
 * No credentials required — safe to call before verifying .env.
 *
 * @param {string[]} pairs   e.g. ['EURUSDT', 'GBPUSDT', 'XRPUSDT']
 * @returns {{ available: string[], unavailable: string[] }}
 */
export async function validateSymbols(pairs) {
  const all = await getSpotSymbols();
  const available   = pairs.filter((p) => all.has(p.toUpperCase()));
  const unavailable = pairs.filter((p) => !all.has(p.toUpperCase()));
  return { available, unavailable };
}

// ─── Retry sell (handles BitGet anti-wash-trading lock) ───────────────────────

/**
 * Attempt to sell `qty` of `coinSymbol`, retrying if the asset is still locked
 * (BitGet prevents immediate resale of freshly purchased assets).
 *
 * @param {string} symbol        Trading pair e.g. 'XRPUSDT'
 * @param {number} qty           Coin quantity to sell
 * @param {object} opts
 * @param {string}  opts.coinSymbol  Base asset name for lock error parsing (e.g. 'XRP')
 * @param {number}  opts.maxRetries
 * @param {number}  opts.retryDelayMs
 * @returns {{ ok: boolean, orderId: string|null, soldQty: number, error: string|null }}
 */
export async function placeSellWithRetry(symbol, qty, { coinSymbol = 'XRP', maxRetries = 12, retryDelayMs = 3000 } = {}) {
  const creds = getCredentials();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const size = (Math.floor(qty * 10000) / 10000).toFixed(4);
    const body = { symbol: symbol.toUpperCase(), side: 'sell', orderType: 'market', force: 'gtc', size };
    const res  = await apiRequest(creds, 'POST', '/api/v2/spot/trade/place-order', body);

    if (res.code === '00000') {
      return { ok: true, orderId: res.data?.orderId || null, soldQty: parseFloat(size), error: null };
    }

    // BitGet lock error: "0.001234XRP can be used at most"
    const lockMatch = res.msg?.match(new RegExp(`([\\d.]+)${coinSymbol}\\s+can be used at most`, 'i'));
    if (lockMatch && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }

    return { ok: false, orderId: null, soldQty: 0, error: res.msg || `Code ${res.code}` };
  }

  return { ok: false, orderId: null, soldQty: 0, error: 'Sell lock never lifted after max retries' };
}
