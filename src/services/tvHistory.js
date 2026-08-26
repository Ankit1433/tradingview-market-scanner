/**
 * Historical OHLCV candles, mirroring Python's `tv.get_hist(symbol, exchange,
 * interval, n_bars)` from tvDatafeed. tvDatafeed itself is an unofficial
 * wrapper around TradingView's websocket data feed - there's no official
 * public API for this. @mathieuc/tradingview wraps the same websocket
 * protocol on the Node side, so the shape of the trade-off is identical to
 * what the Python scanner already relied on.
 *
 * One client/session is created and reused (same as the Python scanner's
 * single `tv = TvDatafeed()` instance reused by every indicator function).
 */

const TradingView = require('@mathieuc/tradingview');

const client = new TradingView.Client(
  process.env.TV_SESSION && process.env.TV_SIGNATURE
    ? { token: process.env.TV_SESSION, signature: process.env.TV_SIGNATURE }
    : undefined,
);

// A connection-level failure (dropped socket, bad session, etc.) doesn't
// automatically fire each open chart's onError - without this, every
// in-flight getHist() call would silently hang until its own timeout
// instead of failing fast. Track pending resolvers and flush them here.
const pendingFinishers = new Set();

client.onError((...err) => {
  console.error('[tvHistory] client error:', ...err);
  for (const finish of pendingFinishers) finish(null);
  pendingFinishers.clear();
});

// interval strings TradingView expects: '5' = 5min, '15' = 15min, 'D' = daily
const INTERVAL = {
  IN_5_MINUTE: '5',
  IN_DAILY: 'D',
};

/**
 * Fetch the last `nBars` candles for symbol on exchange at the given
 * interval. Returns candles OLDEST -> NEWEST (same convention as the
 * pandas DataFrame in the Python version, where df.iloc[-1] is the latest
 * bar) or null on failure/timeout - callers should treat null the same way
 * the Python code treated `df is None`.
 */
function getHist(symbol, exchange, interval, nBars, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const chart = new client.Session.Chart();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingFinishers.delete(finish);
      try {
        chart.delete();
      } catch (_) {
        /* already gone */
      }
      resolve(result);
    };
    pendingFinishers.add(finish);

    const timer = setTimeout(() => finish(null), timeoutMs);

    chart.onError((...err) => {
      console.error(`[tvHistory] chart error [${symbol}]:`, ...err);
      finish(null);
    });

    chart.onUpdate(() => {
      if (!chart.periods || chart.periods.length === 0) return;
      // chart.periods comes back NEWEST -> OLDEST; flip to match pandas ordering
      const candles = [...chart.periods]
        .filter((p) => p && typeof p.close === 'number')
        .reverse()
        .map((p) => ({
          time: p.time, // unix seconds
          open: p.open,
          high: p.max,
          low: p.min,
          close: p.close,
          volume: p.volume,
        }));
      finish(candles);
    });

    const cleanSymbol = symbol.replace(/^NSE:/, '');
    chart.setMarket(`NSE:${cleanSymbol}`, {
      timeframe: interval,
      range: nBars,
    });
  }).catch((e) => {
    console.error(`[tvHistory] getHist error [${symbol}]:`, e.message);
    return null;
  });
}

function closeClient() {
  try {
    client.end();
  } catch (_) {
    /* ignore */
  }
}

module.exports = { getHist, INTERVAL, closeClient };
