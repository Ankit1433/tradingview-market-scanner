/**
 * Append-only journal of every signal that has ever fired.
 *
 * This exists because the live state is deliberately ephemeral - the intraday
 * `alerted` Sets are wiped by resetDailyState() each morning, so by design
 * there was no record that anything had ever happened. That's fine for a
 * personal alert bot and useless for anything else: no history to chart, no
 * dataset to evaluate signal quality against, and an API that returns empty
 * objects for the ~82% of the week that NSE is closed.
 *
 * Every fired signal is appended here with its computed levels, so:
 *   - the API has content outside market hours
 *   - signal distribution/frequency becomes measurable rather than a guess
 *   - there's a real dataset to build a swing backtest on later
 *
 * Storage is JSONL (one JSON object per line), appended with a single
 * fs.appendFileSync. That's chosen over rewriting a JSON array because
 * appends stay O(1) as the file grows, and a truncated final line from a
 * crash costs one record rather than corrupting the whole file.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SWING_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const JOURNAL_FILE = path.join(DATA_DIR, 'signal-journal.jsonl');

const MAX_IN_MEMORY = 2000;   // recent slice kept hot for fast reads
const MAX_FILE_RECORDS = 50000; // rotate beyond this

let recent = [];   // newest last
let loaded = false;
let totalCount = 0;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Read the journal into memory on boot. A malformed line is skipped, not fatal. */
function load() {
  try {
    ensureDir();
    if (!fs.existsSync(JOURNAL_FILE)) {
      recent = [];
      loaded = true;
      return;
    }
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
    totalCount = lines.length;

    const slice = lines.slice(-MAX_IN_MEMORY);
    recent = [];
    for (const line of slice) {
      try {
        recent.push(JSON.parse(line));
      } catch (_) {
        // A partially-written final line from a crash - skip it.
      }
    }
    loaded = true;
    console.log(`[journal] loaded — ${totalCount} signal(s) on record`);
  } catch (e) {
    console.error(`[journal] load failed: ${e.message}`);
    recent = [];
    loaded = true;
  }
}

/** Keep the file bounded. Called after appends, cheap because it only stats. */
function rotateIfNeeded() {
  try {
    if (totalCount <= MAX_FILE_RECORDS) return;
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-Math.floor(MAX_FILE_RECORDS / 2));
    const archive = `${JOURNAL_FILE}.${Date.now()}.archive`;
    fs.renameSync(JOURNAL_FILE, archive);
    fs.writeFileSync(JOURNAL_FILE, `${keep.join('\n')}\n`, 'utf8');
    totalCount = keep.length;
    console.log(`[journal] rotated — archived to ${archive}`);
  } catch (e) {
    console.error(`[journal] rotation failed: ${e.message}`);
  }
}

/**
 * Record one fired signal.
 *
 * @param {object} entry
 * @param {'intraday'|'swing'} entry.mode
 * @param {string} entry.symbol
 * @param {string[]} entry.signals   labels that fired together
 * @param {number} entry.price
 * @param {boolean} entry.confluence did this clear the confluence gate
 * @param {object} [entry.levels]    entry/stop/target/rr where known
 * @param {object} [entry.context]   sector, change%, atr, rsi etc.
 */
function record(entry) {
  if (!loaded) load();

  const record_ = {
    ts: new Date().toISOString(),
    mode: entry.mode,
    symbol: entry.symbol,
    signals: entry.signals || [],
    signalCount: (entry.signals || []).length,
    price: entry.price ?? null,
    confluence: Boolean(entry.confluence),
    levels: entry.levels || null,
    context: entry.context || null,
  };

  recent.push(record_);
  if (recent.length > MAX_IN_MEMORY) recent.shift();
  totalCount += 1;

  try {
    ensureDir();
    fs.appendFileSync(JOURNAL_FILE, `${JSON.stringify(record_)}\n`, 'utf8');
    if (totalCount % 1000 === 0) rotateIfNeeded();
  } catch (e) {
    console.error(`[journal] append failed: ${e.message}`);
  }

  return record_;
}

/** Most recent signals, newest first, with optional filters. */
function query({ limit = 50, mode = null, type = null, symbol = null, confluenceOnly = false } = {}) {
  if (!loaded) load();

  let results = recent;
  if (mode) results = results.filter((r) => r.mode === mode);
  if (type) results = results.filter((r) => r.signals.includes(type));
  if (symbol) results = results.filter((r) => r.symbol === symbol.toUpperCase());
  if (confluenceOnly) results = results.filter((r) => r.confluence);

  return results.slice(-Math.min(limit, 500)).reverse();
}

/**
 * Aggregate stats over the in-memory window. Deliberately computed from the
 * hot slice rather than re-reading the whole file - this is called on every
 * page load of the portfolio site, and a full file read per request would be
 * a silly amount of I/O for a number that barely changes.
 */
function stats() {
  if (!loaded) load();

  const byType = {};
  const byMode = { intraday: 0, swing: 0 };
  const bySymbol = {};
  const bySector = {};
  const byDay = {};
  let confluenceCount = 0;

  for (const r of recent) {
    for (const s of r.signals) byType[s] = (byType[s] || 0) + 1;
    if (byMode[r.mode] !== undefined) byMode[r.mode] += 1;
    bySymbol[r.symbol] = (bySymbol[r.symbol] || 0) + 1;
    if (r.confluence) confluenceCount += 1;

    const sector = r.context?.sector;
    if (sector) bySector[sector] = (bySector[sector] || 0) + 1;

    const day = r.ts.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  const top = (obj, n) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));

  return {
    totalRecorded: totalCount,
    inWindow: recent.length,
    confluenceCount,
    confluenceRate: recent.length ? Number(((confluenceCount / recent.length) * 100).toFixed(1)) : null,
    byMode,
    byType: top(byType, 20),
    topSymbols: top(bySymbol, 10),
    topSectors: top(bySector, 10),
    daily: Object.entries(byDay)
      .sort()
      .slice(-30)
      .map(([date, count]) => ({ date, count })),
    firstRecorded: recent.length ? recent[0].ts : null,
    lastRecorded: recent.length ? recent[recent.length - 1].ts : null,
  };
}

function reset() {
  recent = [];
  totalCount = 0;
  try {
    if (fs.existsSync(JOURNAL_FILE)) fs.unlinkSync(JOURNAL_FILE);
  } catch (_) {
    /* ignore */
  }
}

module.exports = { load, record, query, stats, reset, JOURNAL_FILE };
