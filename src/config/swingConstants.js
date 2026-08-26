/**
 * Swing-trading parameters, kept deliberately separate from the intraday
 * constants. The two strategies share almost no numbers - a 10-point target
 * is meaningful on a 5-min chart and meaningless on a daily one - so mixing
 * them in a single file invites accidentally tuning one while thinking about
 * the other.
 *
 * Key differences from the intraday config:
 *   - Stops are ATR-based (volatility-scaled), not fixed-point. A 2% stop on
 *     a low-ATR largecap and on a high-ATR smallcap are very different trades.
 *   - Targets are R-multiples, not points, for the same reason.
 *   - There is no square-off. Positions are held for days/weeks.
 *   - Time stop: positions that go nowhere are cut, since dead capital in a
 *     swing book is a real cost in a way it isn't intraday.
 */

module.exports = {
  // ---- Scan universe filters (daily timeframe) ----
  SWING_MIN_PRICE: 100,
  SWING_MAX_PRICE: 5000,
  SWING_MIN_AVG_VOLUME: 300000,   // 10-day average, liquidity floor
  SWING_MIN_MARKET_CAP: 5e9,      // ₹500cr - filters illiquid microcaps
  SWING_MIN_ATRP: 2.0,            // needs enough daily range to be worth swinging
  SWING_SCAN_LIMIT: 150,          // max symbols pulled per scan

  // ---- Trend structure ----
  SWING_EMA_FAST: 20,
  SWING_EMA_MID: 50,
  SWING_EMA_SLOW: 200,
  SWING_DAILY_BARS: 250,          // ~1 trading year, enough to seed EMA200

  // ---- Signal thresholds ----
  // Base/consolidation breakout
  SWING_BASE_LOOKBACK_DAYS: 20,       // length of the quiet base
  SWING_BASE_MAX_RANGE_PCT: 12.0,     // base must stay within this % range
  SWING_BREAKOUT_VOLUME_MULT: 1.8,    // breakout day volume vs base average

  // Pullback to moving average in an uptrend
  SWING_PULLBACK_MA_PROXIMITY_PCT: 3.0, // how close to EMA20/50 counts as a touch
  SWING_PULLBACK_MAX_DEPTH_PCT: 15.0,   // deeper than this isn't a pullback, it's a breakdown

  // 52-week-high proximity
  SWING_52W_PROXIMITY_PCT: 5.0,   // within this % of the 52w high

  // Volume dry-up (contraction before expansion)
  SWING_DRYUP_LOOKBACK: 5,
  SWING_DRYUP_MAX_RATIO: 0.7,     // recent volume vs the prior base average

  // Relative strength vs the index
  SWING_RS_LOOKBACK_DAYS: 60,
  SWING_RS_MIN_OUTPERFORMANCE: 0, // stock's 60d return must beat the index's by this much

  // ---- Confluence ----
  // Lower than the intraday gate (3) because daily signals are individually
  // far less noisy - a daily base breakout is a rarer event than a 5-min one,
  // so demanding three simultaneously would produce almost no trades.
  SWING_CONFLUENCE_MIN_SIGNALS: 2,

  // ---- Risk / position management ----
  SWING_ATR_PERIOD: 14,
  SWING_ATR_STOP_MULTIPLIER: 2.0,   // initial stop = entry - (2 * ATR14)
  SWING_TARGET_R_MULTIPLE: 2.5,     // first target at 2.5R
  SWING_PARTIAL_EXIT_FRACTION: 0.5, // booked at target, remainder trails
  SWING_TRAIL_ATR_MULTIPLIER: 2.5,  // chandelier-style trail from the peak
  SWING_TIME_STOP_DAYS: 15,         // cut positions that haven't hit 1R in this many sessions
  SWING_MAX_OPEN_POSITIONS: 5,      // concurrency cap, separate from the capital cap

  SWING_RISK_CAPITAL: 5000,         // max rupee risk per swing trade
  SWING_TOTAL_CAPITAL: 200000,      // capital allocated to the swing book
  // Swing positions are delivery/CNC, so no intraday leverage multiplier here -
  // that's deliberate, not an omission.

  // ---- Schedule ----
  // Swing scanning runs on daily closes, not on a live tick loop. Running it
  // intraday would evaluate signals against an incomplete candle, which is
  // the single most common way a daily-timeframe backtest silently diverges
  // from live results.
  SWING_SCAN_TIME: { h: 15, m: 45 },  // after close, once daily
  SWING_SCAN_CHECK_INTERVAL_MS: 5 * 60 * 1000, // how often to check if it's time

  SWING_SIGNAL_EMOJI: {
    'BASE BREAKOUT': '📦',
    'MA PULLBACK': '↩️',
    '52W HIGH': '🏔',
    'VOLUME DRYUP': '🤏',
    'RS LEADER': '💪',
    'MA STACK': '📶',
  },
};
