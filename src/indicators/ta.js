/**
 * Minimal EMA/VWAP implementation, standing in for pandas_ta's ta.ema()/
 * ta.vwap(). There's no direct Node port of pandas_ta, and these two
 * indicators are simple enough to implement directly rather than pull in
 * a heavier TA library.
 *
 * Both functions take an array of candles (oldest -> newest, as returned
 * by tvHistory.getHist) and return a same-length array of values aligned
 * index-for-index with the input (null where there isn't enough data yet -
 * equivalent to pandas' NaN before the window fills).
 */

/** EMA, SMA-seeded (standard convention - matches most TA libraries/pandas_ta defaults closely enough for our use). */
function ema(candles, length) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < length) return result;

  const k = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += candles[i].close;
  let prev = sum / length;
  result[length - 1] = prev;

  for (let i = length; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

/** VWAP, resetting at each trading day boundary (mirrors backtest.py's per-day groupby). */
function vwap(candles) {
  const result = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // NSE session (9:15-15:30 IST = 03:45-10:00 UTC) never crosses a UTC
    // midnight boundary, so a UTC date key is a safe day-reset key here.
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;
    result[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return result;
}

/** Attaches ema9/ema20/vwap fields onto each candle in place, mirroring df["EMA9"] = ... assignments in Python. */
function annotate(candles) {
  const ema9 = ema(candles, 9);
  const ema20 = ema(candles, 20);
  const vw = vwap(candles);
  for (let i = 0; i < candles.length; i++) {
    candles[i].ema9 = ema9[i];
    candles[i].ema20 = ema20[i];
    candles[i].vwap = vw[i];
  }
  return candles;
}

module.exports = { ema, vwap, annotate };
