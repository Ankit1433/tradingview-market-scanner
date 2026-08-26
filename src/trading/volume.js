const { getHist, INTERVAL } = require('../services/tvHistory');

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/** Current bar's volume vs the average of the preceding 5 bars. Mirrors volume_explosion(). */
async function volumeExplosion(stock) {
  try {
    const candles = await getHist(stock, 'NSE', INTERVAL.IN_5_MINUTE, 6);
    if (!candles || candles.length < 6) return null;

    const current = candles[candles.length - 1].volume;
    const average = mean(candles.slice(0, -1).map((c) => c.volume));
    if (average <= 0) return null;

    return { current, average, ratio: current / average };
  } catch (e) {
    console.error(`volumeExplosion error [${stock}]:`, e.message);
    return null;
  }
}

module.exports = { volumeExplosion };
