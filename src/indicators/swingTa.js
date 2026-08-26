/**
 * Additional indicators the swing scanner needs that the intraday side
 * doesn't. Same conventions as indicators/ta.js: input is an array of
 * candles oldest -> newest, output is a same-length array aligned
 * index-for-index, with null where the window hasn't filled yet.
 */

const { ema } = require('./ta');

/** True Range for each bar. First bar has no prior close, so it's high-low. */
function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/**
 * ATR via Wilder's smoothing (the standard - a plain SMA of true range is a
 * common shortcut but gives noticeably different values, which matters when
 * ATR is setting your stop distance).
 */
function atr(candles, period = 14) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;

  const tr = trueRange(candles);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  result[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    result[i] = prev;
  }
  return result;
}

/** Simple moving average of close. */
function sma(candles, length) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < length) return result;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= length) sum -= candles[i - length].close;
    if (i >= length - 1) result[i] = sum / length;
  }
  return result;
}

/** Simple moving average over an arbitrary numeric field (e.g. volume). */
function smaField(candles, length, field) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < length) return result;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i][field];
    if (i >= length) sum -= candles[i - length][field];
    if (i >= length - 1) result[i] = sum / length;
  }
  return result;
}

/** Highest high / lowest low over a trailing window, inclusive of the current bar. */
function rollingHigh(candles, length) {
  return candles.map((_, i) => {
    if (i < length - 1) return null;
    return Math.max(...candles.slice(i - length + 1, i + 1).map((c) => c.high));
  });
}

function rollingLow(candles, length) {
  return candles.map((_, i) => {
    if (i < length - 1) return null;
    return Math.min(...candles.slice(i - length + 1, i + 1).map((c) => c.low));
  });
}

/** RSI via Wilder's smoothing. Not currently gating any signal - exposed for the API/future use. */
function rsi(candles, period = 14) {
  const result = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * Attaches every swing indicator onto each candle in place. Deliberately
 * does NOT attach VWAP - a session-cumulative VWAP is meaningless on daily
 * candles, and having the field present but nonsensical is worse than not
 * having it at all.
 */
function annotateSwing(candles, { emaFast = 20, emaMid = 50, emaSlow = 200, atrPeriod = 14 } = {}) {
  const eFast = ema(candles, emaFast);
  const eMid = ema(candles, emaMid);
  const eSlow = ema(candles, emaSlow);
  const atrVals = atr(candles, atrPeriod);
  const rsiVals = rsi(candles, 14);
  const vol20 = smaField(candles, 20, 'volume');

  for (let i = 0; i < candles.length; i++) {
    candles[i].emaFast = eFast[i];
    candles[i].emaMid = eMid[i];
    candles[i].emaSlow = eSlow[i];
    candles[i].atr = atrVals[i];
    candles[i].rsi = rsiVals[i];
    candles[i].avgVolume20 = vol20[i];
  }
  return candles;
}

module.exports = {
  trueRange,
  atr,
  sma,
  smaField,
  rollingHigh,
  rollingLow,
  rsi,
  annotateSwing,
};
