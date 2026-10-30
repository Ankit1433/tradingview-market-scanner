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
 * Supabase is the durable store when configured. An append-only JSONL file
 * remains available for local development and as a fallback if the database
 * is not reachable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supabaseStore = require('../services/supabaseStore');

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

function normalizeRecord(record) {
  const normalized = {
    ...record,
    ts: record.ts || new Date().toISOString(),
    signals: Array.isArray(record.signals) ? record.signals : [],
  };
  normalized.signalCount = normalized.signals.length;
  normalized.id = normalized.id || crypto.randomUUID();
  normalized.eventKey = normalized.eventKey || crypto
    .createHash('sha256')
    .update(JSON.stringify([
      normalized.ts,
      normalized.mode,
      normalized.symbol,
      normalized.signals,
    ]))
    .digest('hex');
  return normalized;
}

function toDatabaseRow(record) {
  const normalized = normalizeRecord(record);
  return {
    id: normalized.id,
    event_key: normalized.eventKey,
    occurred_at: normalized.ts,
    mode: normalized.mode,
    symbol: normalized.symbol,
    signal_types: normalized.signals,
    signal_count: normalized.signalCount,
    price: normalized.price,
    confluence: Boolean(normalized.confluence),
    levels: normalized.levels,
    context: normalized.context,
  };
}

function fromDatabaseRow(row) {
  return {
    id: row.id,
    eventKey: row.event_key,
    ts: row.occurred_at,
    mode: row.mode,
    symbol: row.symbol,
    signals: row.signal_types || [],
    signalCount: row.signal_count ?? (row.signal_types || []).length,
    price: row.price === null ? null : Number(row.price),
    confluence: Boolean(row.confluence),
    levels: row.levels || null,
    context: row.context || null,
  };
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
        recent.push(normalizeRecord(JSON.parse(line)));
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

/** Load the durable history and seed a new Supabase project from the local journal. */
async function hydrateFromSupabase() {
  if (!supabaseStore.status().connected) return false;

  try {
    let result = await supabaseStore.loadSignalEvents(MAX_IN_MEMORY);
    if (result.total === 0 && recent.length > 0) {
      await supabaseStore.upsertSignalEvents(recent.map(toDatabaseRow));
      result = await supabaseStore.loadSignalEvents(MAX_IN_MEMORY);
    }

    recent = result.rows.map(fromDatabaseRow).reverse();
    totalCount = Math.max(result.total, recent.length);
    loaded = true;
    console.log(`[journal] loaded — ${totalCount} signal(s) from Supabase`);
    return true;
  } catch (error) {
    console.error(`[journal] Supabase load failed: ${error.message}; keeping local journal`);
    return false;
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
function record(entry, { persist = true } = {}) {
  if (!loaded) load();

  const record_ = normalizeRecord({
    ...entry,
    ts: entry.ts || new Date().toISOString(),
    mode: entry.mode,
    symbol: entry.symbol,
    signals: entry.signals || [],
    signalCount: (entry.signals || []).length,
    price: entry.price ?? null,
    confluence: Boolean(entry.confluence),
    levels: entry.levels || null,
    context: { ...(entry.context || {}), marketDataProvider: require('../marketData').name },
  });

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

  if (persist && supabaseStore.status().connected) {
    supabaseStore.enqueue('signal write', () => process.env.PUSH_URL ? supabaseStore.persistSignalDelivery(record_) : supabaseStore.upsertSignalEvents([toDatabaseRow(record_)]));
  }

  return record_;
}

function hasEvent(entry) {
  if (!loaded) load();
  const candidate = normalizeRecord(entry);
  return recent.some((record_) => record_.eventKey === candidate.eventKey);
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

async function* iterateAll() {
  const seen=new Set();
  if(supabaseStore.status().connected){for await(const row of supabaseStore.iterateSignalEvents()){const r=fromDatabaseRow(row);seen.add(r.eventKey);yield r;}}
  if(!fs.existsSync(DATA_DIR))return;
  const readline=require('readline');
  const files=fs.readdirSync(DATA_DIR).filter(n=>n==='signal-journal.jsonl'||/^signal-journal\.jsonl\..+\.archive$/.test(n));
  for(const name of files){const lines=readline.createInterface({input:fs.createReadStream(path.join(DATA_DIR,name)),crlfDelay:Infinity});
   for await(const line of lines){let r;try{r=normalizeRecord(JSON.parse(line));}catch(_){continue;}if(!seen.has(r.eventKey)){seen.add(r.eventKey);yield r;}}}
}
const ingestLocks=new Map();
async function ingest(entry){const normalized=normalizeRecord(entry),key=normalized.eventKey;const prior=ingestLocks.get(key)||Promise.resolve();const task=prior.catch(()=>{}).then(async()=>{
 if(supabaseStore.status().connected){if(!await supabaseStore.insertSignalEvent(toDatabaseRow(normalized)))return {inserted:false};return {inserted:true,record:record(normalized,{persist:false})};}
 for await(const existing of iterateAll())if(existing.eventKey===key)return {inserted:false};
 return {inserted:true,record:record(normalized)};
 });ingestLocks.set(key,task);try{return await task;}finally{if(ingestLocks.get(key)===task)ingestLocks.delete(key);}}
module.exports = { normalizeRecord,toDatabaseRow,ingest,iterateAll, load, hydrateFromSupabase, record, hasEvent, query, stats, reset, JOURNAL_FILE };
