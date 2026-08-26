/**
 * A single mutable state object, standing in for the Python script's module-
 * level globals (pullback_alerted, open_positions, total_realized_pnl, etc).
 * `resetDailyState()` mirrors reset_daily_state() - called once per new
 * trading day. `telegramLastUpdateId` is intentionally NOT touched by
 * reset - same as the Python version, it's Telegram's own cursor and
 * persists for the process's lifetime.
 */

const state = {
  // Per-signal-type "already alerted today" sets
  pullbackAlerted: new Set(),
  orbAlerted: new Set(),
  momentumAlerted: new Set(),
  volumeAlerted: new Set(),
  vwapAlerted: new Set(),
  noPullbackAlerted: new Set(),
  confluenceAlertedStocks: new Set(),
  afternoonBreakoutAlerted: new Set(),

  openingRange: {},   // stock -> { high, low }
  stockEntryTime: {}, // stock -> Date first seen today
  priceAlerts: {},    // stock -> last known price
  dayHigh: {},        // stock -> running high since first seen
  trailFired: {},     // stock -> bool, has the pullback-from-high alert already fired

  marketClosedSent: false,
  newAlertCount: 0,
  removedAlertCount: 0,
  priceUpdateCount: 0,
  confluenceAlertCount: 0,

  lastSummaryTime: Date.now(),
  lastSectorCounter: {}, // sector -> count
  lastTrackedCount: 0,

  openPositions: {}, // stock -> position object (see positionManager.js)
  totalRealizedPnl: 0,
  positionsOpenedCount: 0,
  stopHitCount: 0,
  targetHitCount: 0,
  trailExitCount: 0,
  squareOffCount: 0,

  current: {},        // stock -> latest scan info (price/change/relVolume/sector)
  previous: new Set(), // previous cycle's tracked symbol set

  lastResetDate: null, // IST dateKey string, e.g. "2026-08-22"
  nifty: { value: null, ts: 0 },

  telegramLastUpdateId: null, // NOT reset daily
};

function resetDailyState() {
  state.pullbackAlerted = new Set();
  state.orbAlerted = new Set();
  state.momentumAlerted = new Set();
  state.volumeAlerted = new Set();
  state.vwapAlerted = new Set();
  state.noPullbackAlerted = new Set();
  state.confluenceAlertedStocks = new Set();
  state.afternoonBreakoutAlerted = new Set();

  state.openingRange = {};
  state.stockEntryTime = {};
  state.priceAlerts = {};
  state.dayHigh = {};
  state.trailFired = {};

  state.marketClosedSent = false;
  state.newAlertCount = 0;
  state.removedAlertCount = 0;
  state.priceUpdateCount = 0;
  state.confluenceAlertCount = 0;

  state.lastSummaryTime = Date.now();
  state.lastSectorCounter = {};
  state.lastTrackedCount = 0;

  state.openPositions = {};
  state.totalRealizedPnl = 0;
  state.positionsOpenedCount = 0;
  state.stopHitCount = 0;
  state.targetHitCount = 0;
  state.trailExitCount = 0;
  state.squareOffCount = 0;

  state.nifty = { value: null, ts: 0 };

  require('../trading/momentum').resetMomentum();

  console.log('Daily state reset.');
}

module.exports = { state, resetDailyState };
