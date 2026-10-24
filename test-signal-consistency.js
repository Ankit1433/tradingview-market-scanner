process.env.SWING_DATA_DIR = '/tmp/signal-consistency-data';
process.env.API_KEY = 'test-key-12345';
process.env.PUBLIC_MODE = 'true';
process.env.ENABLE_INTRADAY = 'false';
process.env.ENABLE_SWING = 'false';
process.env.RATE_LIMIT_PER_MIN = '1000';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createServer } = require('./src/server');
const journal = require('./src/state/signalJournal');
const swingState = require('./src/state/swingState');
const { closeClient } = require('./src/services/tvHistory');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'signal-consistency-yesterday.json');
const PORT = 4612;
const BASE = `http://localhost:${PORT}`;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }

  throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

async function readSseSnippet(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      const timer = setTimeout(() => {
        res.destroy();
        resolve(buffer);
      }, timeoutMs);

      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length >= 2048) {
          clearTimeout(timer);
          res.destroy();
          resolve(buffer);
        }
      });

      res.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      res.on('end', () => {
        clearTimeout(timer);
        resolve(buffer);
      });
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  journal.reset();
  swingState.reset();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  for (const record of fixture.records) {
    journal.record({
      ...record,
      ts: record.ts,
      mode: record.mode,
      symbol: record.symbol,
      signals: record.signals,
      price: record.price,
      confluence: record.confluence,
      levels: record.levels,
      context: record.context,
    });
  }
  const persistedRecords = fs.readFileSync(journal.JOURNAL_FILE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert('journal file persists each original fixture timestamp', fixture.records.every((record) => persistedRecords.some((saved) => saved.symbol === record.symbol && saved.ts === record.ts)), JSON.stringify(persistedRecords.map((record) => ({ symbol: record.symbol, ts: record.ts }))));

  const app = createServer();
  const server = app.listen(PORT);
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    const recent = await getJson(`${BASE}/api/public/signals/recent?limit=10`);
    assert('journal stores the synthetic yesterday records', recent.status === 200 && recent.body.count === 2, JSON.stringify(recent.body));
    assert('API returns the same symbols from the fixture', recent.body.signals.map((entry) => entry.symbol).sort().join(',') === 'INFY,RELIANCE', JSON.stringify(recent.body.signals.map((entry) => entry.symbol)));
    assert('API preserves the recorded signal labels', recent.body.signals.every((entry) => Array.isArray(entry.signals) && entry.signals.length >= 2), JSON.stringify(recent.body.signals));
    assert('API preserves the signalCount metadata', recent.body.signals.every((entry) => entry.signalCount === entry.signals.length), JSON.stringify(recent.body.signals));
    assert('API preserves each fixture timestamp exactly', recent.body.signals.every((entry) => fixture.records.some((record) => record.symbol === entry.symbol && record.ts === entry.ts)), JSON.stringify(recent.body.signals.map((entry) => ({ symbol: entry.symbol, ts: entry.ts }))));

    const byMode = await getJson(`${BASE}/api/public/signals/recent?mode=intraday`);
    assert('mode filter matches intraday records only', byMode.status === 200 && byMode.body.count === 1 && byMode.body.signals[0].symbol === 'RELIANCE', JSON.stringify(byMode.body));

    const streamText = await readSseSnippet(`${BASE}/api/public/stream?mode=intraday`);
    assert('SSE stream is reachable for the selected mode', streamText.includes('event: connected'), `payload=${streamText.slice(0, 200)}`);
    assert('SSE stream replays the matching intraday signal record', streamText.includes('RELIANCE') && streamText.includes('PULLBACK'), streamText.slice(0, 400));
    assert('SSE replay preserves the fixture timestamp exactly', streamText.includes('"ts":"2026-10-23T09:35:00.000Z"'), streamText.slice(0, 600));

    const stats = await getJson(`${BASE}/api/public/stats`);
    assert('journal stats aggregate yesterday-sized fixture without drift', stats.status === 200 && stats.body.signals.totalRecorded === 2, JSON.stringify(stats.body.signals));
    assert('stats day histogram includes the synthetic trade date', stats.body.signals.daily.some((day) => day.date === '2026-10-23'), JSON.stringify(stats.body.signals.daily));

    const journalHtml = fs.readFileSync(path.join(__dirname, 'public', 'journal.html'), 'utf8');
    assert('frontend journal reads signalCount and signal labels from the same record model', journalHtml.includes('signal.signalCount') && journalHtml.includes('signal.signals'), 'journal.html missing signal representation contract');

    const scannerHtml = fs.readFileSync(path.join(__dirname, 'public', 'scanner.html'), 'utf8');
    assert('frontend scanner consumes the same signal contract', scannerHtml.includes('signal.signalCount') && scannerHtml.includes('signal.signals'), 'scanner.html missing signal representation contract');

    console.log('\nSignal consistency check passed.');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

main().catch((error) => {
  console.error('\nSignal consistency check failed.');
  console.error(error.stack || error.message);
  process.exit(1);
}).finally(() => closeClient());
