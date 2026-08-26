/**
 * All tunable scanner parameters in one place, mirroring the constants
 * block at the top of the live Python scanner. Edit these to match your
 * own numbers - they are NOT read from .env, since they're strategy
 * parameters, not secrets/environment config.
 */

const dtime = (h, m) => ({ h, m }); // small helper, compares like Python's datetime.time

module.exports = {
  MARKET_OPEN: dtime(9, 15),
  MARKET_CLOSE: dtime(15, 30),
  ORB_WINDOW_END: dtime(9, 45),
  ORB_CHECK_START: dtime(9, 30),
  SQUARE_OFF_TIME: dtime(15, 15), // adjust to your broker's actual auto-squareoff cutoff

  SUMMARY_INTERVAL_MS: 30 * 60 * 1000,

  // Alert thresholds
  MOMENTUM_SCORE_THRESHOLD: 70,
  VOLUME_RATIO_THRESHOLD: 3.0,

  // Relative-strength / R:R tuning
  NIFTY_SYMBOL: 'NIFTY',
  NIFTY_CACHE_MS: 60 * 1000,
  REQUIRE_RELATIVE_STRENGTH: true,
  RS_SCORE_BONUS: 15,
  RR_BONUS_THRESHOLD: 2.0,
  RR_SCORE_BONUS: 10,

  // Confluence: raised from 2 -> 3 after 21 Jul data showed 2 agreeing
  // signals was often just coincidence, not a genuinely rare confirmation.
  CONFLUENCE_MIN_SIGNALS: 3,

  TRADING_WINDOW_START: dtime(9, 20),
  TRADING_WINDOW_END: dtime(12, 30), // no NEW entries after 12:30 (lunch lull)

  TRAIL_PULLBACK_PCT: 1.5,
  NO_PULLBACK_LOOKBACK: 8,
  STOP_BUFFER_PCT: 0.2,
  PULLBACK_EMA9_PROXIMITY_PCT: 0.3, // tightened from original 0.5
  VWAP_RECLAIM_VOLUME_MULTIPLIER: 1.5,

  // Afternoon coiled-base breakout window (separate from the 12:30 cutoff -
  // this is a stricter, distinct pattern, see indicators/signals.js)
  AFTERNOON_WINDOW_START: dtime(13, 0),
  AFTERNOON_WINDOW_END: dtime(15, 10),
  CONSOLIDATION_LOOKBACK_BARS: 24,
  CONSOLIDATION_MAX_RANGE_PCT: 2.0,
  BREAKOUT_VOLUME_MULTIPLIER: 3.0,

  // Risk / capital - EDIT THESE to match your real numbers
  RISK_CAPITAL: 5000,          // max rupee loss per trade
  TOTAL_CAPITAL: 200000,       // total intraday capital
  LEVERAGE_MULTIPLIER: 1,      // your broker's MIS multiplier (1 = cash-only)
  TARGET_POINTS_LOW: 10,       // point target that triggers partial booking
  TARGET_POINTS_HIGH: 12,      // upper end of target range (display only)
  PARTIAL_EXIT_FRACTION: 0.5,  // fraction of qty booked at target

  SIGNAL_EMOJI: {
    PULLBACK: '🎯',
    'ORB BREAKOUT': '🔥',
    MOMENTUM: '⚡',
    'VOLUME SPIKE': '📊',
    'VWAP RECLAIM': '📈',
    'NO-PULLBACK RUNNER': '🏃',
    'AFTERNOON BREAKOUT': '🌇',
  },

  dtime,
};
