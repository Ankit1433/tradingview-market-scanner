/**
 * Swing portfolio state. Supabase is the durable store when configured;
 * atomic local JSON remains as a development and connectivity fallback.
 */

const fs = require('fs');
const path = require('path');
const supabaseStore = require('../services/supabaseStore');

const DATA_DIR = process.env.SWING_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'swing-state.json');

const emptyState = () => ({
  openPositions: {},   // symbol -> position object
  closedTrades: [],    // completed trades, append-only journal
  alertedToday: {},    // dateKey -> [symbols alerted], prevents duplicate alerts
  lastScanDate: null,  // dateKey of the last completed scan
  totalRealizedPnl: 0,
  counters: {
    positionsOpened: 0,
    stopHits: 0,
    targetHits: 0,
    trailExits: 0,
    timeStops: 0,
  },
});

let state = emptyState();
let loaded = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load persisted state from disk. Missing file is normal on first run.
 * A corrupt file is NOT silently replaced - it's backed up first, because
 * overwriting the only record of your open positions would be worse than
 * the crash it's trying to avoid.
 */
function load() {
  if (loaded) return state;
  try {
    ensureDir();
    if (!fs.existsSync(STATE_FILE)) {
      state = emptyState();
      loaded = true;
      return state;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...emptyState(), ...parsed };
    const openCount = Object.values(state.openPositions).filter((p) => !p.closed).length;
    loaded = true;
    console.log(`[swingState] loaded — ${openCount} open position(s), ${state.closedTrades.length} closed trade(s)`);
    return state;
  } catch (e) {
    const backup = `${STATE_FILE}.corrupt.${Date.now()}`;
    console.error(`[swingState] failed to parse state file: ${e.message}`);
    try {
      fs.copyFileSync(STATE_FILE, backup);
      console.error(`[swingState] backed up unreadable state to ${backup} — starting fresh, check that file for open positions`);
    } catch (_) {
      console.error('[swingState] could not back up the unreadable state file');
    }
    state = emptyState();
    loaded = true;
    return state;
  }
}

function tradeKeyFor(symbol, openedOn, fallback) {
  return fallback || `swing:${symbol}:${openedOn || `legacy-${symbol}`}`;
}

function toPaperTradeRows(snapshot) {
  const rows = new Map();
  const closedTrades = Array.isArray(snapshot.closedTrades) ? snapshot.closedTrades : [];

  for (const trade of closedTrades) {
    if (!trade || !trade.symbol) continue;
    const symbol = String(trade.symbol).toUpperCase();
    const tradeKey = tradeKeyFor(symbol, trade.openedOn, trade.tradeKey);
    rows.set(tradeKey, {
      trade_key: tradeKey,
      mode: 'swing',
      symbol,
      status: 'closed',
      opened_on: trade.openedOn || null,
      closed_at: trade.closedAt || null,
      entry_price: trade.entry ?? null,
      initial_stop: trade.initialStop ?? null,
      current_stop: trade.currentStop ?? null,
      target_price: trade.target ?? null,
      quantity: trade.initialQty ?? trade.qty ?? null,
      remaining_quantity: 0,
      exit_price: trade.exit ?? null,
      realized_pnl: trade.pnl ?? 0,
      exit_reason: trade.reason || null,
      setup_types: Array.isArray(trade.signals) ? trade.signals : [],
      metadata: { barsHeld: trade.barsHeld ?? null },
      updated_at: new Date().toISOString(),
    });
  }

  for (const [symbolValue, position] of Object.entries(snapshot.openPositions || {})) {
    if (!position) continue;
    const symbol = String(symbolValue).toUpperCase();
    const tradeKey = tradeKeyFor(symbol, position.openedOn, position.tradeKey);
    if (rows.has(tradeKey)) continue;
    rows.set(tradeKey, {
      trade_key: tradeKey,
      mode: 'swing',
      symbol,
      status: position.closed ? 'closed' : 'open',
      opened_on: position.openedOn || null,
      closed_at: position.closedAt || null,
      entry_price: position.entry ?? null,
      initial_stop: position.initialStop ?? position.stop ?? null,
      current_stop: position.stop ?? null,
      target_price: position.target ?? null,
      quantity: position.qty ?? null,
      remaining_quantity: position.closed ? 0 : (position.partialBooked ? position.runnerQty : position.qty),
      exit_price: position.exitPrice ?? null,
      realized_pnl: position.realizedPnl ?? 0,
      exit_reason: position.exitReason || null,
      setup_types: Array.isArray(position.signals) ? position.signals : [],
      metadata: {
        stopBasis: position.stopBasis || null,
        atrAtEntry: position.atrAtEntry ?? null,
        barsHeld: position.barsHeld ?? null,
        partialBooked: Boolean(position.partialBooked),
      },
      updated_at: new Date().toISOString(),
    });
  }

  return Array.from(rows.values());
}

/** Restore the durable swing portfolio, or seed Supabase from the local file. */
async function hydrateFromSupabase() {
  if (!supabaseStore.status().connected) return false;

  try {
    const saved = await supabaseStore.loadState('swing');
    if (saved?.payload && typeof saved.payload === 'object') {
      const defaults = emptyState();
      state = {
        ...defaults,
        ...saved.payload,
        openPositions: saved.payload.openPositions || {},
        closedTrades: Array.isArray(saved.payload.closedTrades) ? saved.payload.closedTrades : [],
        counters: { ...defaults.counters, ...(saved.payload.counters || {}) },
      };
      console.log(`[swingState] restored ${openPositionsList().length} open position(s) from Supabase`);
    } else {
      await supabaseStore.saveState('swing', state);
      console.log('[swingState] seeded Supabase from local state');
    }

    const rows = toPaperTradeRows(state);
    if (rows.length) await supabaseStore.upsertPaperTrades(rows);
    loaded = true;
    return true;
  } catch (error) {
    console.error(`[swingState] Supabase restore failed: ${error.message}; keeping local state`);
    return false;
  }
}

/** Write current state to disk. Atomic (write temp + rename) so a crash mid-write can't truncate the file. */
function save({ persist = true } = {}) {
  try {
    ensureDir();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error(`[swingState] save failed: ${e.message}`);
  }

  if (persist && supabaseStore.status().connected) {
    const snapshot = JSON.parse(JSON.stringify(state));
    supabaseStore.enqueueState('swing', snapshot);
    supabaseStore.enqueuePaperTrades(toPaperTradeRows(snapshot));
  }
}

function getState() {
  return state;
}

function openPositionsList() {
  return Object.entries(state.openPositions)
    .filter(([, p]) => !p.closed)
    .map(([symbol, p]) => ({ symbol, ...p }));
}

/** Has this symbol already been alerted on this date? Prevents re-alerting the same setup daily. */
function alreadyAlerted(dateKey, symbol) {
  const list = state.alertedToday[dateKey];
  return Array.isArray(list) && list.includes(symbol);
}

function markAlerted(dateKey, symbol) {
  if (!state.alertedToday[dateKey]) state.alertedToday[dateKey] = [];
  if (!state.alertedToday[dateKey].includes(symbol)) {
    state.alertedToday[dateKey].push(symbol);
  }
  // Keep only the last 10 days of alert history - unbounded growth in a file
  // that's rewritten on every mutation is a slow leak.
  const keys = Object.keys(state.alertedToday).sort();
  while (keys.length > 10) {
    delete state.alertedToday[keys.shift()];
  }
}

/** Wipe everything. Exposed for the API/testing - not called automatically anywhere. */
function reset() {
  state = emptyState();
  loaded = true;
  save({ persist: false });
}

module.exports = {
  load,
  hydrateFromSupabase,
  save,
  getState,
  openPositionsList,
  alreadyAlerted,
  markAlerted,
  reset,
  STATE_FILE,
};
