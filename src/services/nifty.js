const { getHist, INTERVAL } = require('./tvHistory');
const { state } = require('../state/dailyState');
const { NIFTY_SYMBOL, NIFTY_CACHE_MS } = require('../config/constants');

/**
 * Nifty's current-day % change, cached for NIFTY_CACHE_MS. Fails open -
 * returns null (or the last cached value) on error, which disables the
 * relative-strength gate for that cycle rather than blocking every alert.
 * Mirrors get_nifty_change().
 */
async function getNiftyChange() {
  if (Date.now() - state.nifty.ts < NIFTY_CACHE_MS) {
    return state.nifty.value;
  }
  try {
    const candles = await getHist(NIFTY_SYMBOL, 'NSE', INTERVAL.IN_DAILY, 2);
    if (candles && candles.length >= 2) {
      const prevClose = candles[candles.length - 2].close;
      const todayClose = candles[candles.length - 1].close;
      state.nifty.value = ((todayClose - prevClose) / prevClose) * 100;
    }
  } catch (e) {
    console.error(`getNiftyChange error: ${e.message}`);
  }
  state.nifty.ts = Date.now();
  return state.nifty.value;
}

module.exports = { getNiftyChange };
