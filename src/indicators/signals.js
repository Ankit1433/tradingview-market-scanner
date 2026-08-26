const { getHist, INTERVAL } = require('../services/tvHistory');
const { annotate } = require('./ta');
const {
  PULLBACK_EMA9_PROXIMITY_PCT,
  VWAP_RECLAIM_VOLUME_MULTIPLIER,
  NO_PULLBACK_LOOKBACK,
  STOP_BUFFER_PCT,
  CONSOLIDATION_LOOKBACK_BARS,
  CONSOLIDATION_MAX_RANGE_PCT,
  BREAKOUT_VOLUME_MULTIPLIER,
} = require('../config/constants');

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * Phase-1 trend confirmation score, 0-100. Mirrors trend_score().
 * Never throws - returns null on missing data/fetch failure, same
 * contract as the Python version's internal try/except.
 */
async function trendScore(stock) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, 60);
    if (!candles || candles.length < 25) return null;
    annotate(candles);

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    let score = 0;

    if (last.close > last.vwap) score += 20;

    const vwapGap = ((last.close - last.vwap) / last.vwap) * 100;
    if (vwapGap > 0 && vwapGap < 2) score += 10;

    if (last.ema9 > last.ema20) score += 20;

    const emaGap = ((last.ema9 - last.ema20) / last.ema20) * 100;
    if (emaGap > 0.3) score += 10;

    if (prev.ema9 <= prev.ema20 && last.ema9 > last.ema20) score += 20;

    if (last.close > last.ema9) score += 20;
    if (last.ema9 > prev.ema9) score += 20;
    if (last.ema20 > prev.ema20) score += 10;
    if (last.high > prev.high) score += 10;
    if (last.low > prev.low) score += 10;

    const vols = candles.map((c) => c.volume);
    const avg5 = mean(vols.slice(-5));
    const avg20 = mean(vols.slice(-20));
    if (avg5 > avg20) score += 10;

    return Math.min(score, 100);
  } catch (e) {
    console.error(`trendScore error [${stock}]:`, e.message);
    return null;
  }
}

/** Pullback-to-EMA9 entry, in an established uptrend. Mirrors pullback_entry(). */
async function pullbackEntry(stock) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, 40);
    if (!candles || candles.length < 20) return null;
    annotate(candles);

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    if (last.ema9 <= last.ema20) return null;
    if (last.close < last.ema20) return null;

    const distance = (Math.abs(last.close - last.ema9) / last.ema9) * 100;
    if (distance > PULLBACK_EMA9_PROXIMITY_PCT) return null;

    if (last.close <= last.open) return null;
    if (last.volume <= prev.volume) return null;

    return { entry: last.close, ema9: last.ema9, ema20: last.ema20 };
  } catch (e) {
    console.error(`pullbackEntry error [${stock}]:`, e.message);
    return null;
  }
}

/**
 * VWAP reclaim WITH volume confirmation (tightened - a price-only cross
 * back over VWAP was firing on routine wobble). Mirrors vwap_reclaim().
 */
async function vwapReclaim(stock) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, 20);
    if (!candles || candles.length < 8) return false;
    annotate(candles);

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const crossed = prev.close < prev.vwap && last.close > last.vwap;
    if (!crossed) return false;

    const window = candles.slice(-6, -1).map((c) => c.volume);
    const avgVolume = mean(window);
    if (avgVolume <= 0) return false;

    return last.volume >= avgVolume * VWAP_RECLAIM_VOLUME_MULTIPLIER;
  } catch (e) {
    console.error(`vwapReclaim error [${stock}]:`, e.message);
    return false;
  }
}

/**
 * The inverse of pullbackEntry: a stock riding above EMA9/VWAP that hasn't
 * touched EMA9 in `lookback` candles, with EMA9 net rising. Mirrors
 * no_pullback_trend(). Returns a structural stop just under EMA9.
 */
async function noPullbackTrend(stock, lookback = NO_PULLBACK_LOOKBACK) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, 40);
    if (!candles || candles.length < lookback + 10) return null;
    annotate(candles);

    const last = candles[candles.length - 1];
    const recent = candles.slice(-lookback);

    if (last.ema9 <= last.ema20) return null;
    if (last.close <= last.vwap) return null;
    if (recent.some((c) => c.low <= c.ema9)) return null;
    if (recent[recent.length - 1].ema9 <= recent[0].ema9) return null;

    const distancePct = ((last.close - last.ema9) / last.ema9) * 100;
    const stop = last.ema9 * (1 - STOP_BUFFER_PCT / 100);

    return {
      price: last.close,
      ema9: last.ema9,
      vwap: last.vwap,
      distanceFromEma9Pct: distancePct,
      stop,
    };
  } catch (e) {
    console.error(`noPullbackTrend error [${stock}]:`, e.message);
    return null;
  }
}

/**
 * A tight multi-hour "coiled" base that then breaks out on a real volume
 * surge. Stricter than noPullbackTrend - requires an actual quiet base
 * first. Mirrors afternoon_breakout(). Caller is responsible for gating
 * this to the afternoon window; this function doesn't check the clock.
 */
async function afternoonBreakout(stock) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, CONSOLIDATION_LOOKBACK_BARS + 5);
    if (!candles || candles.length < CONSOLIDATION_LOOKBACK_BARS + 3) return null;

    const base = candles.slice(-(CONSOLIDATION_LOOKBACK_BARS + 2), -2);
    const breakoutBar = candles[candles.length - 1];

    const baseHigh = Math.max(...base.map((c) => c.high));
    const baseLow = Math.min(...base.map((c) => c.low));
    if (baseLow <= 0) return null;

    const baseRangePct = ((baseHigh - baseLow) / baseLow) * 100;
    if (baseRangePct > CONSOLIDATION_MAX_RANGE_PCT) return null; // not a tight base

    if (breakoutBar.close <= baseHigh) return null; // hasn't broken out yet

    const baseAvgVolume = mean(base.map((c) => c.volume));
    if (baseAvgVolume <= 0) return null;

    const volumeRatio = breakoutBar.volume / baseAvgVolume;
    if (volumeRatio < BREAKOUT_VOLUME_MULTIPLIER) return null; // no conviction behind the break

    const stop = baseHigh * (1 - STOP_BUFFER_PCT / 100); // old base high is now support

    return { price: breakoutBar.close, baseHigh, baseRangePct, volumeRatio, stop };
  } catch (e) {
    console.error(`afternoonBreakout error [${stock}]:`, e.message);
    return null;
  }
}

/** Support/resistance + breakout/R:R off the prior 20 candles. Mirrors analyze_stock(). Never throws. */
async function analyzeStock(symbol, currentPrice) {
  const fallback = { breakout: false, support: 0, resistance: 0, rr: 0, target: 0 };
  try {
    const candles = await getHist(symbol, 'NSE', INTERVAL.IN_5_MINUTE, 21);
    if (!candles || candles.length < 2) return fallback;

    const priorCandles = candles.slice(0, -1);
    const resistance = Math.max(...priorCandles.map((c) => c.high));
    const support = Math.min(...priorCandles.map((c) => c.low));

    const breakout = currentPrice > resistance;
    const risk = Math.max(0.01, currentPrice - support);
    const target = resistance + risk;
    const reward = Math.max(0, target - currentPrice);
    const rr = reward / risk;

    return { breakout, support, resistance, rr, target };
  } catch (e) {
    console.error(`analyzeStock error [${symbol}]:`, e.message);
    return fallback;
  }
}

/** Opening-range high/low from the first ~15 minutes. Mirrors get_orb(). Never throws. */
async function getOrb(symbol) {
  try {
    const candles = await getHist(symbol, 'NSE', INTERVAL.IN_5_MINUTE, 3);
    if (!candles || candles.length === 0) return [null, null];
    const orbHigh = Math.max(...candles.map((c) => c.high));
    const orbLow = Math.min(...candles.map((c) => c.low));
    return [orbHigh, orbLow];
  } catch (e) {
    console.error(`getOrb error [${symbol}]:`, e.message);
    return [null, null];
  }
}

/** Change%/relative-volume tiered score. Mirrors calculate_score(). Pure, no I/O, no internal error handling (matches Python). */
function calculateScore(info) {
  let score = 0;

  if (info.change >= 10) score += 40;
  else if (info.change >= 7) score += 30;
  else if (info.change >= 5) score += 20;
  else score += 10;

  if (info.relVolume >= 10) score += 40;
  else if (info.relVolume >= 5) score += 30;
  else if (info.relVolume >= 3) score += 20;
  else score += 10;

  return score;
}

module.exports = {
  trendScore,
  pullbackEntry,
  vwapReclaim,
  noPullbackTrend,
  afternoonBreakout,
  analyzeStock,
  getOrb,
  calculateScore,
};
