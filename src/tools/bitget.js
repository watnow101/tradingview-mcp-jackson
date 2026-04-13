/**
 * Bitget MCP tools — the bridge between TradingView signals and live exchange orders.
 *
 * Workflow Claude should follow:
 *   1. Read signal  →  chart_get_state / data_get_study_values / data_get_pine_labels
 *   2. Check risk   →  rules.json (risk_rules) + bitget_status for balance
 *   3. Execute      →  bitget_place_order
 *   4. Confirm      →  bitget_order_history
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as bitget from '../core/bitget.js';

export function registerBitgetTools(server) {

  // ── Connection & balance check ─────────────────────────────────────────────
  server.tool(
    'bitget_status',
    'Test Bitget API connection and return account balances. Always call this first before placing orders to confirm credentials are working and check available capital.',
    {
      coins: z.array(z.string()).optional()
        .describe("Filter to specific coins e.g. ['USDT','BTC','XRP']. Omit for all non-zero balances."),
    },
    async ({ coins = [] }) => {
      try {
        if (!bitget.isConfigured()) {
          return jsonResult({
            success: false,
            configured: false,
            error: 'Bitget credentials not set. Add BITGET_API_KEY, BITGET_SECRET_KEY and BITGET_PASSPHRASE to .env then restart the MCP server.',
          }, true);
        }

        const all      = await bitget.getBalances(coins);
        const nonZero  = all.filter(
          (a) => parseFloat(a.available || 0) > 0 || parseFloat(a.frozen || 0) > 0
        );
        const balances = (nonZero.length ? nonZero : all).map((a) => ({
          coin:      a.coin,
          available: parseFloat(a.available || 0),
          frozen:    parseFloat(a.frozen    || 0),
          locked:    parseFloat(a.locked    || 0),
        }));

        return jsonResult({ success: true, configured: true, balances });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Live price ─────────────────────────────────────────────────────────────
  server.tool(
    'bitget_price',
    'Get the current spot price for a symbol on Bitget. Useful to verify the price before placing an order or to compare with TradingView quote.',
    {
      symbol: z.string().describe("Trading pair e.g. 'BTCUSDT', 'XRPUSDT', 'ETHUSDT'"),
    },
    async ({ symbol }) => {
      try {
        const ticker = await bitget.getPrice(symbol);
        return jsonResult({ success: true, ...ticker });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Place order ────────────────────────────────────────────────────────────
  server.tool(
    'bitget_place_order',
    [
      'Place a spot market or limit order on Bitget.',
      '',
      'Size conventions:',
      '  market BUY  → size = USDT amount to spend   (e.g. "50" means spend $50 USDT)',
      '  market SELL → size = base coin qty to sell   (e.g. "25.5" means sell 25.5 XRP)',
      '  limit        → size = base coin qty; price required',
      '',
      'Always call bitget_status first to confirm balance before buying.',
      'For sells of freshly-bought assets use bitget_sell_retry to handle the BitGet lock.',
    ].join('\n'),
    {
      symbol:     z.string().describe("Trading pair e.g. 'BTCUSDT'"),
      side:       z.enum(['buy', 'sell']),
      size:       z.string().describe('Order size — see size conventions above'),
      order_type: z.enum(['market', 'limit']).default('market'),
      price:      z.string().optional().describe('Limit price (required when order_type is limit)'),
      client_oid: z.string().optional().describe('Optional idempotency key for deduplication'),
    },
    async ({ symbol, side, size, order_type, price, client_oid }) => {
      try {
        const data = await bitget.placeOrder({
          symbol,
          side,
          size,
          orderType: order_type,
          price:     price     || null,
          clientOid: client_oid || null,
        });
        return jsonResult({
          success:  true,
          order_id: data?.orderId || null,
          symbol:   symbol.toUpperCase(),
          side,
          size,
          order_type,
          price:    price || 'market',
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Sell with retry (handles BitGet anti-wash-trading lock) ───────────────
  server.tool(
    'bitget_sell_retry',
    'Sell a freshly-purchased asset on Bitget with automatic retry. BitGet temporarily locks assets against immediate resale (anti-wash-trading). This tool retries until the lock clears or the timeout is reached.',
    {
      symbol:       z.string().describe("Trading pair e.g. 'XRPUSDT'"),
      qty:          z.number().describe('Exact coin quantity to sell (from the buy fill, e.g. 25.5432)'),
      coin_symbol:  z.string().optional().describe("Base asset name for lock-error parsing e.g. 'XRP'. Defaults to the base of the symbol."),
      max_retries:  z.number().optional().default(12).describe('Max retry attempts (default 12)'),
      retry_delay_ms: z.number().optional().default(3000).describe('Milliseconds between retries (default 3000)'),
    },
    async ({ symbol, qty, coin_symbol, max_retries, retry_delay_ms }) => {
      try {
        // Derive base coin from symbol if not provided (e.g. XRPUSDT → XRP)
        const coin = coin_symbol || symbol.toUpperCase().replace(/USDT$|USDC$|BTC$|ETH$/, '');
        const result = await bitget.placeSellWithRetry(symbol, qty, {
          coinSymbol:   coin,
          maxRetries:   max_retries,
          retryDelayMs: retry_delay_ms,
        });
        return jsonResult({ success: result.ok, ...result });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Cancel order ───────────────────────────────────────────────────────────
  server.tool(
    'bitget_cancel_order',
    'Cancel an open (unfilled) order on Bitget by order ID.',
    {
      order_id: z.string().describe('The order ID returned by bitget_place_order'),
      symbol:   z.string().describe("Trading pair e.g. 'BTCUSDT'"),
    },
    async ({ order_id, symbol }) => {
      try {
        const data = await bitget.cancelOrder(order_id, symbol);
        return jsonResult({ success: true, order_id, symbol: symbol.toUpperCase(), result: data });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Open orders ────────────────────────────────────────────────────────────
  server.tool(
    'bitget_open_orders',
    'List currently open (unfilled) spot orders on Bitget.',
    {
      symbol: z.string().optional().describe("Filter by trading pair e.g. 'BTCUSDT'. Omit for all symbols."),
    },
    async ({ symbol }) => {
      try {
        const orders = await bitget.getOpenOrders(symbol || null);
        return jsonResult({
          success: true,
          count:   orders.length,
          orders:  orders.map((o) => ({
            order_id:   o.orderId,
            symbol:     o.symbol,
            side:       o.side,
            order_type: o.orderType,
            size:       o.size,
            price:      o.price || 'market',
            filled:     o.baseVolume || '0',
            status:     o.status,
            created_at: new Date(parseInt(o.cTime || 0)).toISOString(),
          })),
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // ── Order history ──────────────────────────────────────────────────────────
  server.tool(
    'bitget_order_history',
    'Get recent filled and cancelled spot orders from Bitget. Use after placing orders to confirm fills and calculate actual P&L.',
    {
      symbol: z.string().optional().describe("Filter by trading pair. Omit for all symbols."),
      limit:  z.number().optional().default(20).describe('Number of orders to return (1–100, default 20)'),
    },
    async ({ symbol, limit = 20 }) => {
      try {
        const orders = await bitget.getOrderHistory(symbol || null, limit);
        return jsonResult({
          success: true,
          count:   orders.length,
          orders:  orders.map((o) => ({
            order_id:    o.orderId,
            symbol:      o.symbol,
            side:        o.side,
            order_type:  o.orderType,
            size:        o.size,
            filled_qty:  o.baseVolume  || '0',
            avg_price:   o.priceAvg    || null,
            quote_spent: o.quoteVolume || null,
            status:      o.status,
            created_at:  new Date(parseInt(o.cTime || 0)).toISOString(),
          })),
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
