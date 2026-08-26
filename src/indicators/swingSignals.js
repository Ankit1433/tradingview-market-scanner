/**
 * Swing signal evaluators. All operate on DAILY candles.
 *
 * A note that matters for correctness: these evaluate the LAST CLOSED daily
 * candle. If you run this intraday, `candles[length-1]` is today's partial,
 * still-forming bar - its close is just the current price and its volume is
 * whatever has traded so far. A base breakout evaluated at 11am on partial
 * volume will look completely different by 15:30. The swing loop is therefore
 * scheduled after the close (SWING_SCAN_TIME); the `useLastClosed` option
 * below lets a caller explicitly drop the final bar if it needs to run
 * mid-session.
 *
 * Same failure contract as the intraday signals: every function returns
 * null/false rather than throwing, so one bad symbol never kills a scan.
 */

const { getHist, INTERVAL } = require('../services/tvHistory');
const { annotateSwing, rollingHigh, rollingLow } = require('./swingTa');
const S = require('../config/swingConstants');

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * Fetch + annotate daily candles once per symbol per scan, so six signal
 * checks don't trigger six identical network round-trips. The intraday side
 * re-fetches per signal (each check opens its own chart session); at daily
 * cadence over ~150 symbols that would be wasteful and slow, so the swing
 * side fetches once and passes the array around.
 */
async function loadDaily(symbol, { useLastClosed = true } = {}) {
  const candles = await getHist(symbol, 'NSE', INTERVAL.IN_DAILY, S.SWING_DAILY_BARS);
  if (!candles || candles.length < 60) return null;

  // Drop the still-forming bar if asked. Note this can't distinguish "today's
  // partial bar" from "yesterday's complete bar" by content alone - it just
  // trusts the caller, which is why the scheduled run happens after close.
  const usable = useLastClosed ? candles : candles.slice(0, -1);
  if (usable.length < 60) return null;

  annotateSwing(usable, {
    emaFast: S.SWING_EMA_FAST,
    emaMid: S.SWING_EMA_MID,
    emaSlow: S.SWING_EMA_SLOW,
    atrPeriod: S.SWING_ATR_PERIOD,
  });
  return usable;
}

/** Price > EMA20 > EMA50 > EMA200, all rising. The textbook "stacked" uptrend. */
function maStack(candles) {
  const last = candles[candles.length - 1];
  const prior = candles[candles.length - 6]; // ~1 week back, for slope
  if (!last.emaFast || !last.emaMid || !last.emaSlow) return null;
  if (!prior || !prior.emaFast || !prior.emaMid) return null;

  if (!(last.close > last.emaFast)) return null;
  if (!(last.emaFast > last.emaMid)) return null;
  if (!(last.emaMid > last.emaSlow)) return null;
  if (!(last.emaFast > prior.emaFast)) return null; // fast MA rising
  if (!(last.emaMid > prior.emaMid)) return null;   // mid MA rising

  return {
    close: last.close,
    emaFast: last.emaFast,
    emaMid: last.emaMid,
    emaSlow: last.emaSlow,
  };
}

/**
 * A multi-week base held within a tight range, then broken on above-average
 * volume. The daily-timeframe analogue of the intraday afternoon_breakout.
 */
function baseBreakout(candles) {
  const n = candles.length;
  const lookback = S.SWING_BASE_LOOKBACK_DAYS;
  if (n < lookback + 5) return null;

  const breakoutBar = candles[n - 1];
  const base = candles.slice(n - 1 - lookback, n - 1); // excludes the breakout bar itself

  const baseHigh = Math.max(...base.map((c) => c.high));
  const baseLow = Math.min(...base.map((c) => c.low));
  if (baseLow <= 0) return null;

  const baseRangePct = ((baseHigh - baseLow) / baseLow) * 100;
  if (baseRangePct > S.SWING_BASE_MAX_RANGE_PCT) return null; // not a tight base

  if (breakoutBar.close <= baseHigh) return null; // hasn't broken out

  const baseAvgVolume = mean(base.map((c) => c.volume));
  if (baseAvgVolume <= 0) return null;

  const volumeRatio = breakoutBar.volume / baseAvgVolume;
  if (volumeRatio < S.SWING_BREAKOUT_VOLUME_MULT) return null; // no conviction

  return {
    price: breakoutBar.close,
    baseHigh,
    baseLow,
    baseRangePct,
    volumeRatio,
    // Structural stop: below the base. ATR stop is computed separately in the
    // position manager; whichever is tighter wins there.
    structuralStop: baseLow,
  };
}

/**
 * Pullback into EMA20/EMA50 within an intact uptrend - buying weakness in
 * strength rather than chasing a breakout. Requires the stack to still be
 * intact, so this won't fire on a stock that's actually breaking down.
 */
function maPullback(candles) {
  const last = candles[candles.length - 1];
  if (!last.emaFast || !last.emaMid || !last.emaSlow) return null;

  // Trend must still be intact
  if (!(last.emaMid > last.emaSlow)) return null;
  if (!(last.close > last.emaSlow)) return null;

  const distToFast = (Math.abs(last.close - last.emaFast) / last.emaFast) * 100;
  const distToMid = (Math.abs(last.close - last.emaMid) / last.emaMid) * 100;
  const nearFast = distToFast <= S.SWING_PULLBACK_MA_PROXIMITY_PCT;
  const nearMid = distToMid <= S.SWING_PULLBACK_MA_PROXIMITY_PCT;
  if (!nearFast && !nearMid) return null;

  // Must actually have pulled back from a recent high, not just be drifting
  // sideways at the MA.
  const recentHigh = Math.max(...candles.slice(-S.SWING_BASE_LOOKBACK_DAYS).map((c) => c.high));
  const depthPct = ((recentHigh - last.close) / recentHigh) * 100;
  if (depthPct <= 0) return null;
  if (depthPct > S.SWING_PULLBACK_MAX_DEPTH_PCT) return null; // too deep - breakdown, not pullback

  const touchedMa = nearFast ? last.emaFast : last.emaMid;

  return {
    price: last.close,
    ma: touchedMa,
    maLabel: nearFast ? `EMA${S.SWING_EMA_FAST}` : `EMA${S.SWING_EMA_MID}`,
    depthFromHighPct: depthPct,
    recentHigh,
    structuralStop: Math.min(...candles.slice(-10).map((c) => c.low)), // recent swing low
  };
}

/** Within X% of the 52-week high - i.e. near the top of its own range, not recovering off a base. */
function near52WeekHigh(candles) {
  const n = candles.length;
  const window = Math.min(n, 252);
  const last = candles[n - 1];
  const high52 = Math.max(...candles.slice(n - window).map((c) => c.high));
  if (high52 <= 0) return null;

  const distancePct = ((high52 - last.close) / high52) * 100;
  if (distancePct > S.SWING_52W_PROXIMITY_PCT) return null;

  return { price: last.close, high52, distancePct };
}

/**
 * Volume contraction - the "quiet before the move" that precedes many good
 * breakouts. On its own this is weak; it earns its place as a confluence
 * contributor alongside a structural signal.
 */
function volumeDryUp(candles) {
  const n = candles.length;
  const lookback = S.SWING_DRYUP_LOOKBACK;
  if (n < lookback + 20) return null;

  const recent = candles.slice(n - lookback);
  const base = candles.slice(n - lookback - 20, n - lookback);

  const recentAvg = mean(recent.map((c) => c.volume));
  const baseAvg = mean(base.map((c) => c.volume));
  if (baseAvg <= 0) return null;

  const ratio = recentAvg / baseAvg;
  if (ratio > S.SWING_DRYUP_MAX_RATIO) return null;

  return { ratio, recentAvg, baseAvg };
}

/**
 * Relative strength vs the index over SWING_RS_LOOKBACK_DAYS. Takes the
 * index's return as an argument rather than fetching it per-symbol, so the
 * caller fetches the index once per scan instead of 150 times.
 */
function rsLeader(candles, indexReturnPct) {
  if (indexReturnPct === null || indexReturnPct === undefined) return null;
  const n = candles.length;
  const lookback = S.SWING_RS_LOOKBACK_DAYS;
  if (n < lookback + 1) return null;

  const then = candles[n - 1 - lookback].close;
  const now = candles[n - 1].close;
  if (then <= 0) return null;

  const stockReturn = ((now - then) / then) * 100;
  const outperformance = stockReturn - indexReturnPct;
  if (outperformance <= S.SWING_RS_MIN_OUTPERFORMANCE) return null;

  return { stockReturn, indexReturn: indexReturnPct, outperformance };
}

/** Index return over the same lookback, for the RS comparison. */
async function getIndexReturn(symbol = 'NIFTY') {
  try {
    const candles = await getHist(symbol, 'NSE', INTERVAL.IN_DAILY, S.SWING_RS_LOOKBACK_DAYS + 10);
    if (!candles || candles.length < S.SWING_RS_LOOKBACK_DAYS + 1) return null;
    const n = candles.length;
    const then = candles[n - 1 - S.SWING_RS_LOOKBACK_DAYS].close;
    const now = candles[n - 1].close;
    if (then <= 0) return null;
    return ((now - then) / then) * 100;
  } catch (e) {
    console.error(`getIndexReturn error: ${e.message}`);
    return null;
  }
}

/**
 * Runs every swing signal against one symbol's daily candles and returns the
 * list that fired. Structural signals carry a stop level; contextual ones
 * (52w high, dry-up, RS, MA stack) contribute to the confluence count but
 * can't define an entry on their own - same split as the intraday side.
 */
async function evaluateSwingSignals(symbol, indexReturnPct, opts = {}) {
  try {
    const candles = await loadDaily(symbol, opts);
    if (!candles) return null;

    const last = candles[candles.length - 1];
    if (!last.atr || last.atr <= 0) return null; // no ATR = can't size a stop

    const signals = [];

    const bb = baseBreakout(candles);
    if (bb) {
      signals.push({
        label: 'BASE BREAKOUT',
        detail: `Broke ${bb.baseRangePct.toFixed(1)}%-tight ${S.SWING_BASE_LOOKBACK_DAYS}d base @ ₹${bb.baseHigh.toFixed(2)} on ${bb.volumeRatio.toFixed(1)}x volume`,
        entry: bb.price,
        structuralStop: bb.structuralStop,
      });
    }

    const pb = maPullback(candles);
    if (pb) {
      signals.push({
        label: 'MA PULLBACK',
        detail: `Pulled back ${pb.depthFromHighPct.toFixed(1)}% from ₹${pb.recentHigh.toFixed(2)} into ${pb.maLabel}`,
        entry: pb.price,
        structuralStop: pb.structuralStop,
      });
    }

    const stack = maStack(candles);
    if (stack) {
      signals.push({
        label: 'MA STACK',
        detail: `Price > EMA${S.SWING_EMA_FAST} > EMA${S.SWING_EMA_MID} > EMA${S.SWING_EMA_SLOW}, rising`,
        entry: null,
        structuralStop: null,
      });
    }

    const h52 = near52WeekHigh(candles);
    if (h52) {
      signals.push({
        label: '52W HIGH',
        detail: `${h52.distancePct.toFixed(1)}% below 52w high ₹${h52.high52.toFixed(2)}`,
        entry: null,
        structuralStop: null,
      });
    }

    const dry = volumeDryUp(candles);
    if (dry) {
      signals.push({
        label: 'VOLUME DRYUP',
        detail: `Recent volume ${(dry.ratio * 100).toFixed(0)}% of base average`,
        entry: null,
        structuralStop: null,
      });
    }

    const rs = rsLeader(candles, indexReturnPct);
    if (rs) {
      signals.push({
        label: 'RS LEADER',
        detail: `${rs.stockReturn >= 0 ? '+' : ''}${rs.stockReturn.toFixed(1)}% vs index ${rs.indexReturn >= 0 ? '+' : ''}${rs.indexReturn.toFixed(1)}% over ${S.SWING_RS_LOOKBACK_DAYS}d`,
        entry: null,
        structuralStop: null,
      });
    }

    if (signals.length === 0) return null;

    return {
      symbol,
      signals,
      close: last.close,
      atr: last.atr,
      rsi: last.rsi,
      emaFast: last.emaFast,
      emaMid: last.emaMid,
      emaSlow: last.emaSlow,
    };
  } catch (e) {
    console.error(`evaluateSwingSignals error [${symbol}]: ${e.message}`);
    return null;
  }
}

module.exports = {
  loadDaily,
  maStack,
  baseBreakout,
  maPullback,
  near52WeekHigh,
  volumeDryUp,
  rsLeader,
  getIndexReturn,
  evaluateSwingSignals,
};
