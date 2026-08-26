/**
 * backtest.js - measures the confluence entry logic against REAL historical
 * data. Mirrors backtest.py.
 *
 * Run with: npm run backtest
 *
 * WHAT THIS VALIDATES: the entry rules (PULLBACK / ORB BREAKOUT /
 * NO-PULLBACK RUNNER / VOLUME SPIKE / VWAP RECLAIM), the confluence gate,
 * and the exact stop/target/partial-book/trail/square-off exit logic from
 * the live scanner - replayed bar-by-bar with NO LOOK-AHEAD (only data up
 * to and including the current bar is used at every decision point).
 *
 * Uses the SAME constants module as the live scanner (src/config/constants.js)
 * rather than a separate hardcoded copy, so the two can't silently drift out
 * of sync the way the original Python backtest.py's local constants could.
 *
 * WHAT THIS CANNOT VALIDATE:
 *   - MOMENTUM: built from live polling cadence (every 15-30s), not present
 *     in historical 5-min candles. Excluded entirely.
 *   - The live scanner's daily stock UNIVERSE: TradingView's scanner
 *     endpoint only returns a live snapshot, there's no historical "which
 *     stocks matched the filter on day X". Edit SYMBOLS below to your own
 *     watchlist - this tests the entry LOGIC, not the stock-picking.
 */

const { getHist, INTERVAL } = require('../services/tvHistory');
const { annotate } = require('../indicators/ta');
const C = require('../config/constants');

// ---- Edit this to your own watchlist / recently-alerted tickers ----
const SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN'];
const LOOKBACK_BARS = 1000; // ~13 trading days of 5-min bars

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function istTimeOf(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    time: { h: parseInt(get('hour'), 10) % 24, m: parseInt(get('minute'), 10) },
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}
const tMin = (t) => t.h * 60 + t.m;

function checkPullback(candles, i) {
  if (i < 20) return null;
  const last = candles[i];
  const prev = candles[i - 1];
  if (last.ema9 <= last.ema20) return null;
  if (last.close < last.ema20) return null;
  if ((Math.abs(last.close - last.ema9) / last.ema9) * 100 > 0.5) return null;
  if (last.close <= last.open) return null;
  if (last.volume <= prev.volume) return null;
  return { entry: last.close, stop: last.ema9 * (1 - C.STOP_BUFFER_PCT / 100) };
}

function checkNoPullback(candles, i, lookback = C.NO_PULLBACK_LOOKBACK) {
  if (i < lookback + 10) return null;
  const last = candles[i];
  const recent = candles.slice(i - lookback + 1, i + 1);
  if (last.ema9 <= last.ema20) return null;
  if (last.close <= last.vwap) return null;
  if (recent.some((c) => c.low <= c.ema9)) return null;
  if (recent[recent.length - 1].ema9 <= recent[0].ema9) return null;
  return { entry: last.close, stop: last.ema9 * (1 - C.STOP_BUFFER_PCT / 100) };
}

function checkOrb(candles, i, dayOpenRange) {
  const last = candles[i];
  const { time, dayKey } = istTimeOf(last.time);
  const rng = dayOpenRange.get(dayKey);
  if (!rng || tMin(time) < tMin({ h: 9, m: 30 })) return null;
  if (last.close > rng.high) return { entry: last.close, stop: rng.low };
  return null;
}

function checkVolumeSpike(candles, i) {
  if (i < 6) return null;
  const currentVolume = candles[i].volume;
  const avgVolume = mean(candles.slice(i - 5, i).map((c) => c.volume));
  if (avgVolume <= 0) return null;
  return currentVolume / avgVolume >= C.VOLUME_RATIO_THRESHOLD ? {} : null;
}

function checkVwapReclaim(candles, i) {
  if (i < 1) return null;
  const last = candles[i];
  const prev = candles[i - 1];
  return prev.close < prev.vwap && last.close > last.vwap ? {} : null;
}

function positionSize(entry, stop, capitalCeiling) {
  const stopDistance = entry - stop;
  if (stopDistance <= 0) return null;
  const qtyByRisk = Math.floor(C.RISK_CAPITAL / stopDistance);
  const qtyByCapital = entry > 0 ? Math.floor(capitalCeiling / entry) : 0;
  const qty = Math.min(qtyByRisk, qtyByCapital);
  return qty > 0 ? { qty } : null;
}

async function simulateSymbol(symbol) {
  const candles = await getHist(symbol, 'NSE', INTERVAL.IN_5_MINUTE, LOOKBACK_BARS);
  if (!candles || candles.length < 50) {
    console.log(`${symbol}: not enough data returned (${candles ? candles.length : 0} bars)`);
    return [];
  }
  annotate(candles);

  // Build each day's opening range (9:15-9:45) for ORB checks
  const dayOpenRange = new Map();
  for (const c of candles) {
    const { time, dayKey } = istTimeOf(c.time);
    if (tMin(time) < tMin({ h: 9, m: 15 }) || tMin(time) > tMin({ h: 9, m: 45 })) continue;
    if (!dayOpenRange.has(dayKey)) dayOpenRange.set(dayKey, { high: -Infinity, low: Infinity });
    const rng = dayOpenRange.get(dayKey);
    rng.high = Math.max(rng.high, c.high);
    rng.low = Math.min(rng.low, c.low);
  }

  const trades = [];
  let openTrade = null;
  const openedToday = new Set();

  for (let i = 0; i < candles.length; i++) {
    const { time, dayKey } = istTimeOf(candles[i].time);
    const price = candles[i].close;

    // ---- manage an open simulated trade (same rules as the live scanner) ----
    if (openTrade) {
      const ot = openTrade;
      if (tMin(time) >= tMin(C.SQUARE_OFF_TIME)) {
        const qtyLeft = ot.partialBooked ? ot.runnerQty : ot.qty;
        ot.pnl += qtyLeft * (price - ot.entry);
        ot.exitReason = 'square_off';
        trades.push(ot);
        openTrade = null;
      } else if (!ot.partialBooked) {
        if (price <= ot.stop) {
          ot.pnl -= ot.qty * (ot.entry - ot.stop);
          ot.exitReason = 'stop';
          trades.push(ot);
          openTrade = null;
        } else if (price >= ot.target) {
          const partialQty = Math.floor(ot.qty * C.PARTIAL_EXIT_FRACTION);
          ot.runnerQty = ot.qty - partialQty;
          ot.pnl += partialQty * (ot.target - ot.entry);
          ot.partialBooked = true;
          ot.stop = ot.entry;
          ot.highest = price;
        }
      } else {
        if (price > ot.highest) {
          ot.highest = price;
        } else if (price <= ot.stop) {
          ot.exitReason = 'breakeven';
          trades.push(ot);
          openTrade = null;
        } else if (price <= ot.highest * (1 - C.TRAIL_PULLBACK_PCT / 100)) {
          ot.pnl += ot.runnerQty * (price - ot.entry);
          ot.exitReason = 'trail';
          trades.push(ot);
          openTrade = null;
        }
      }
      continue; // one open trade at a time per symbol, matching live behaviour
    }

    // ---- look for a new confluence entry (max once per symbol per day) ----
    if (openedToday.has(dayKey)) continue;
    if (tMin(time) < tMin(C.TRADING_WINDOW_START) || tMin(time) > tMin(C.AFTERNOON_WINDOW_END)) continue;

    const candidates = [];
    const pb = checkPullback(candles, i);
    if (pb) candidates.push(['PULLBACK', pb]);
    const orb = checkOrb(candles, i, dayOpenRange);
    if (orb) candidates.push(['ORB', orb]);
    const npb = checkNoPullback(candles, i);
    if (npb) candidates.push(['NO_PULLBACK', npb]);
    if (checkVolumeSpike(candles, i)) candidates.push(['VOLUME', null]);
    if (checkVwapReclaim(candles, i)) candidates.push(['VWAP_RECLAIM', null]);

    if (candidates.length >= C.CONFLUENCE_MIN_SIGNALS) {
      const sig = candidates.map((c) => c[1]).find((s) => s !== null);
      if (sig) {
        const sizing = positionSize(sig.entry, sig.stop, C.TOTAL_CAPITAL * C.LEVERAGE_MULTIPLIER);
        if (sizing) {
          openTrade = {
            symbol,
            day: dayKey,
            entryTime: new Date(candles[i].time * 1000).toISOString(),
            signals: candidates.map((c) => c[0]).join('+'),
            entry: sig.entry,
            stop: sig.stop,
            qty: sizing.qty,
            target: sig.entry + C.TARGET_POINTS_LOW,
            partialBooked: false,
            runnerQty: 0,
            highest: sig.entry,
            pnl: 0,
            exitReason: null,
          };
          openedToday.add(dayKey);
        }
      }
    }
  }

  return trades;
}

async function runBacktest() {
  let allTrades = [];
  for (const sym of SYMBOLS) {
    console.log(`Backtesting ${sym}...`);
    allTrades = allTrades.concat(await simulateSymbol(sym));
  }

  if (allTrades.length === 0) {
    console.log(
      '\nNo trades generated. Try more SYMBOLS, a longer LOOKBACK_BARS, or check that CONFLUENCE_MIN_SIGNALS isn\'t too strict for this data.',
    );
    return;
  }

  const wins = allTrades.filter((tr) => tr.pnl > 0);
  const losses = allTrades.filter((tr) => tr.pnl <= 0);
  const totalPnl = allTrades.reduce((s, tr) => s + tr.pnl, 0);

  console.log(`\n=== BACKTEST RESULTS (${SYMBOLS.length} symbols, ${LOOKBACK_BARS} bars each) ===`);
  console.log(`Total trades:  ${allTrades.length}`);
  console.log(`Wins:          ${wins.length} (${((wins.length / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`Losses:        ${losses.length} (${((losses.length / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`Total P&L:     ₹${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}`);
  if (wins.length) console.log(`Avg win:       ₹${(wins.reduce((s, tr) => s + tr.pnl, 0) / wins.length).toFixed(0)}`);
  if (losses.length) console.log(`Avg loss:      ₹${(losses.reduce((s, tr) => s + tr.pnl, 0) / losses.length).toFixed(0)}`);

  console.log('\nPer-trade detail:');
  for (const tr of [...allTrades].sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))) {
    console.log(
      `  ${tr.entryTime}  ${tr.symbol.padEnd(10)} [${tr.signals.padEnd(22)}] ` +
        `entry ${tr.entry.toFixed(2)}  exit=${(tr.exitReason || '').padEnd(10)}  P&L ₹${tr.pnl >= 0 ? '+' : ''}${tr.pnl.toFixed(0)}`,
    );
  }
}

if (require.main === module) {
  runBacktest()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { runBacktest, simulateSymbol };
