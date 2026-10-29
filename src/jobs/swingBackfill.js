const { loadDaily, getIndexReturn, evaluateSwingSignals } = require('../indicators/swingSignals');
const { getHist, INTERVAL } = require('../services/tvHistory');
const { getSwingCandidates } = require('../services/swingScanner');
const journal = require('../state/signalJournal');
const S = require('../config/swingConstants');

const { barDateKey, isBarComplete } = require('../services/dailyBars');
const RS_LOOKBACK = S.SWING_RS_LOOKBACK_DAYS;
const dateKeyInIST = time => barDateKey({ time });
function completedSessionBars(candles, now, count) {
  return candles.map((candle, index) => ({ candle, index, dateKey: barDateKey(candle) }))
    .filter(({ candle }) => isBarComplete(candle, now)).slice(-count);
}

function indexReturnForDate(candles, dateKey) {
  const endIndex = candles.findIndex((candle) => dateKeyInIST(candle.time) === dateKey);
  if (endIndex < RS_LOOKBACK) return null;

  const start = candles[endIndex - RS_LOOKBACK].close;
  const end = candles[endIndex].close;
  if (!(start > 0)) return null;
  return ((end - start) / start) * 100;
}

async function runSwingBackfill({
  sessions = 2,
  now = new Date(),
  getCandidates = getSwingCandidates,
  loadCandles = loadDaily,
  loadIndexCandles = () => getHist('NIFTY', 'NSE', INTERVAL.IN_DAILY, RS_LOOKBACK + 10),
  evaluate = evaluateSwingSignals,
  hasEvent = journal.hasEvent,
  record = journal.record,
} = {}) {
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 5) {
    throw new Error('sessions must be an integer between 1 and 5');
  }

  const universe = await getCandidates();
  const symbols = Object.keys(universe);
  if (symbols.length === 0) throw new Error('The swing screener returned no candidates');

  const indexCandles = await loadIndexCandles();
  let scanned = 0;
  let recorded = 0;
  let skippedExisting = 0;
  const dates = new Set();

  for (const symbol of symbols) {
    const candles = await loadCandles(symbol, { now });
    if (!candles) continue;
    scanned += 1;

    const targets = completedSessionBars(candles, now, sessions);
    for (const target of targets) {
      const historicalCandles = candles.slice(0, target.index + 1);
      const indexReturn = indexCandles
        ? indexReturnForDate(indexCandles, target.dateKey)
        : null;
      const result = await evaluate(symbol, indexReturn, { candles: historicalCandles, now });
      if (!result || result.signals.length < S.SWING_CONFLUENCE_MIN_SIGNALS) continue;

      const timestamp = new Date(target.candle.time * 1000).toISOString();
      const signals = result.signals;
      const entrySignal = signals.find(
        (signal) => signal.entry !== null && signal.structuralStop !== null,
      );
      const entry = {
        ts: timestamp,
        mode: 'swing',
        symbol,
        signals: signals.map((signal) => signal.label),
        price: result.close,
        confluence: Boolean(entrySignal) && signals.length >= S.SWING_CONFLUENCE_MIN_SIGNALS,
        levels: entrySignal
          ? { entry: entrySignal.entry, stop: entrySignal.structuralStop }
          : null,
        context: {
          sector: universe[symbol]?.sector,
          atr: result.atr,
          rsi: result.rsi,
          perf3Month: universe[symbol]?.perf3Month,
        },
      };

      dates.add(target.dateKey);
      if (hasEvent(entry)) {
        skippedExisting += 1;
        continue;
      }
      record(entry);
      recorded += 1;
    }
  }

  return { scanned, dates: [...dates].sort(), recorded, skippedExisting };
}

module.exports = { runSwingBackfill, completedSessionBars, indexReturnForDate };
