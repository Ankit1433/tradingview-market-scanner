process.env.SWING_DATA_DIR = '/tmp/swing-backfill-test-data';

const fs = require('fs');
const path = require('path');
const journal = require('./src/state/signalJournal');
const { closeClient } = require('./src/services/tvHistory');
const { runSwingBackfill, completedSessionBars, indexReturnForDate } = require('./src/jobs/swingBackfill');

function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✓ ${name}`);
}

async function main() {
  fs.rmSync(process.env.SWING_DATA_DIR, { recursive: true, force: true });
  journal.reset();

  const candle = (date, close = 100) => ({
    time: Math.floor(new Date(`${date}T10:00:00.000Z`).getTime() / 1000),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  });
  const stockCandles = ['2026-10-21', '2026-10-22', '2026-10-23']
    .map((date) => candle(date));
  const indexCandles = Array.from({ length: 63 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 20 + index)).toISOString().slice(0, 10);
    return candle(date, 100 + index);
  });
  const selected = completedSessionBars(
    [...stockCandles, candle('2026-10-25')],
    new Date('2026-10-25T03:00:00.000Z'),
    2,
  );
  check('selects only the latest two completed bars and excludes today', selected.length === 2 && selected.every((bar) => bar.dateKey < '2026-10-25'));
  check('computes index return for the matching historical session', indexReturnForDate(indexCandles, '2026-10-21') !== null);

  const runOptions = {
    sessions: 2,
    now: new Date('2026-10-25T03:00:00.000Z'),
    getCandidates: async () => ({ TESTCO: { sector: 'Test', perf3Month: 12 } }),
    loadCandles: async () => stockCandles,
    loadIndexCandles: async () => indexCandles,
    evaluate: async (symbol, indexReturn, { candles }) => ({
      symbol,
      signals: [
        { label: 'BASE BREAKOUT', entry: candles.at(-1).close, structuralStop: candles.at(-1).close - 2 },
        { label: 'MA STACK', entry: null, structuralStop: null },
        { label: '52W HIGH', entry: null, structuralStop: null },
      ],
      close: candles.at(-1).close,
      atr: 2,
      rsi: 60,
      indexReturn,
    }),
  };

  const first = await runSwingBackfill(runOptions);
  const saved = journal.query({ mode: 'swing', limit: 10 });
  check('records only setups for the latest two completed dates', first.recorded === 2 && saved.length === 2);
  check('retains historical candle timestamps and prices', saved.map((record) => record.ts.slice(0, 10)).sort().join(',') === '2026-10-22,2026-10-23');
  check('does not create or modify swing paper positions', !fs.existsSync(path.join(process.env.SWING_DATA_DIR, 'swing-state.json')));

  const second = await runSwingBackfill(runOptions);
  check('repeat run skips already-recorded historical setups', second.recorded === 0 && second.skippedExisting === 2 && journal.query({ mode: 'swing', limit: 10 }).length === 2);

  let rejected = false;
  try {
    await runSwingBackfill({ ...runOptions, sessions: 6 });
  } catch (error) {
    rejected = /sessions must be/.test(error.message);
  }
  check('rejects a backfill range outside the supported limit', rejected);
  console.log('\nSwing backfill check passed.');
}

main().catch((error) => {
  console.error('\nSwing backfill check failed.');
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => closeClient());
