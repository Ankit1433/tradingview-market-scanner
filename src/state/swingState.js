/**
 * Swing state, persisted to disk.
 *
 * This is the main architectural difference from the intraday side. Intraday
 * state is deliberately ephemeral - resetDailyState() wipes positions every
 * morning, and if the process restarts mid-session you've lost tracking on
 * anything open, which is survivable because intraday positions are closed
 * by 15:15 anyway.
 *
 * A swing position is held for days or weeks. It has to survive both the
 * daily reset and a process restart, otherwise the scanner silently forgets
 * a position you're still holding and stops managing its stop. So swing
 * state is written to disk on every mutation and reloaded on boot.
 *
 * JSON-on-disk is chosen over a database deliberately: the write volume is a
 * handful of mutations a day and the dataset is a few dozen records. Swapping
 * in SQLite or Redis later is a contained change - everything goes through
 * load()/save() here.
 */

const fs = require('fs');
const path = require('path');

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
  try {
    ensureDir();
    if (!fs.existsSync(STATE_FILE)) {
      state = emptyState();
      return state;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...emptyState(), ...parsed };
    const openCount = Object.values(state.openPositions).filter((p) => !p.closed).length;
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
    return state;
  }
}

/** Write current state to disk. Atomic (write temp + rename) so a crash mid-write can't truncate the file. */
function save() {
  try {
    ensureDir();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error(`[swingState] save failed: ${e.message}`);
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
  save();
}

module.exports = {
  load,
  save,
  getState,
  openPositionsList,
  alreadyAlerted,
  markAlerted,
  reset,
  STATE_FILE,
};
