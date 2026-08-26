/**
 * Synthetic-data verification of the swing indicators and the position
 * lifecycle. No network calls - builds candles in memory so the maths can be
 * checked against hand-computable expectations.
 *
 * Run: node test-swing.js
 */

process.env.SWING_DATA_DIR = '/tmp/swing-test-data';

const { atr, sma, rsi, annotateSwing, rollingHigh } = require('./src/indicators/swingTa');
const { baseBreakout, maPullback, near52WeekHigh, volumeDryUp, maStack, rsLeader } = require('./src/indicators/swingSignals');
const { resolveStop, positionSize } = require('./src/trading/swingPositionManager');
const S = require('./src/config/swingConstants');

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    fail += 1;
  }
}

const DAY = 86400;
function candle(i, { open, high, low, close, volume }) {
  return { time: 1700000000 + i * DAY, open, high, low, close, volume };
}

// ---------------------------------------------------------------
console.log('\n=== ATR (Wilder) ===');
{
  // Constant 10-point range, no gaps -> ATR must converge to exactly 10
  const candles = [];
  for (let i = 0; i < 40; i++) {
    candles.push(candle(i, { open: 100, high: 105, low: 95, close: 100, volume: 1000 }));
  }
  const a = atr(candles, 14);
  check('null before period fills', a[13] === null, `got ${a[13]}`);
  check('non-null at period', a[14] !== null);
  check('converges to true range (10)', Math.abs(a[39] - 10) < 0.001, `got ${a[39]}`);
}

// ---------------------------------------------------------------
console.log('\n=== SMA ===');
{
  const candles = [];
  for (let i = 1; i <= 10; i++) candles.push(candle(i, { open: i, high: i, low: i, close: i, volume: 1 }));
  const s = sma(candles, 5);
  // closes 1..10; SMA5 at index 4 = (1+2+3+4+5)/5 = 3
  check('SMA5 at first full window = 3', s[4] === 3, `got ${s[4]}`);
  // at index 9 = (6+7+8+9+10)/5 = 8
  check('SMA5 at last index = 8', s[9] === 8, `got ${s[9]}`);
  check('null before window fills', s[3] === null);
}

// ---------------------------------------------------------------
console.log('\n=== RSI ===');
{
  // Monotonically rising -> RSI must be 100 (no losses at all)
  const rising = [];
  for (let i = 0; i < 40; i++) {
    const p = 100 + i;
    rising.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 1000 }));
  }
  const r = rsi(rising, 14);
  check('RSI = 100 on pure uptrend', Math.abs(r[39] - 100) < 0.001, `got ${r[39]}`);

  const falling = [];
  for (let i = 0; i < 40; i++) {
    const p = 200 - i;
    falling.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 1000 }));
  }
  const r2 = rsi(falling, 14);
  check('RSI = 0 on pure downtrend', Math.abs(r2[39] - 0) < 0.001, `got ${r2[39]}`);
}

// ---------------------------------------------------------------
console.log('\n=== BASE BREAKOUT ===');
{
  // 60 bars of uptrend, then a 20-bar tight base ~200-208, then a breakout
  // bar closing at 215 on 3x the base's average volume.
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const p = 150 + i * 0.8;
    candles.push(candle(i, { open: p, high: p + 2, low: p - 2, close: p, volume: 100000 }));
  }
  for (let i = 60; i < 80; i++) {
    const p = 200 + (i % 4) * 2; // oscillates 200-206
    candles.push(candle(i, { open: p, high: p + 2, low: p - 1, close: p, volume: 100000 }));
  }
  candles.push(candle(80, { open: 208, high: 216, low: 207, close: 215, volume: 300000 }));
  annotateSwing(candles);

  const bb = baseBreakout(candles);
  check('fires on a tight base + volume breakout', bb !== null);
  if (bb) {
    check('base range within threshold', bb.baseRangePct <= S.SWING_BASE_MAX_RANGE_PCT, `got ${bb.baseRangePct.toFixed(2)}%`);
    check('volume ratio above threshold', bb.volumeRatio >= S.SWING_BREAKOUT_VOLUME_MULT, `got ${bb.volumeRatio.toFixed(2)}x`);
    check('structural stop below entry', bb.structuralStop < bb.price);
  }

  // Same base but breakout on NORMAL volume -> must not fire
  const lowVol = candles.slice(0, 80);
  lowVol.push(candle(80, { open: 208, high: 216, low: 207, close: 215, volume: 100000 }));
  annotateSwing(lowVol);
  check('rejects breakout without volume', baseBreakout(lowVol) === null);

  // Base too wide -> must not fire
  const wide = [];
  for (let i = 0; i < 60; i++) {
    const p = 150 + i * 0.8;
    wide.push(candle(i, { open: p, high: p + 2, low: p - 2, close: p, volume: 100000 }));
  }
  for (let i = 60; i < 80; i++) {
    const p = 180 + (i % 5) * 12; // very wide swings
    wide.push(candle(i, { open: p, high: p + 5, low: p - 5, close: p, volume: 100000 }));
  }
  wide.push(candle(80, { open: 235, high: 250, low: 234, close: 248, volume: 300000 }));
  annotateSwing(wide);
  check('rejects a base that is too wide', baseBreakout(wide) === null);
}

// ---------------------------------------------------------------
console.log('\n=== MA PULLBACK ===');
{
  // Long uptrend to establish stacked MAs, run to a high, then pull back
  // modestly toward EMA20.
  const candles = [];
  for (let i = 0; i < 220; i++) {
    const p = 100 + i * 0.5;
    candles.push(candle(i, { open: p, high: p + 1.5, low: p - 1.5, close: p, volume: 100000 }));
  }
  // push to a local high
  for (let i = 220; i < 232; i++) {
    const p = 210 + (i - 219) * 2.5;
    candles.push(candle(i, { open: p, high: p + 2, low: p - 2, close: p, volume: 120000 }));
  }
  // pull back
  for (let i = 232; i < 240; i++) {
    const p = 240 - (i - 231) * 2.2;
    candles.push(candle(i, { open: p, high: p + 1.5, low: p - 1.5, close: p, volume: 90000 }));
  }
  annotateSwing(candles);

  const pb = maPullback(candles);
  check('fires on pullback into MA within an uptrend', pb !== null);
  if (pb) {
    check('depth within threshold', pb.depthFromHighPct <= S.SWING_PULLBACK_MAX_DEPTH_PCT, `got ${pb.depthFromHighPct.toFixed(1)}%`);
    check('reports which MA was touched', typeof pb.maLabel === 'string');
    check('structural stop below entry', pb.structuralStop < pb.price, `stop ${pb.structuralStop} vs price ${pb.price}`);
  }

  // Downtrend -> must not fire
  const down = [];
  for (let i = 0; i < 240; i++) {
    const p = 300 - i * 0.6;
    down.push(candle(i, { open: p, high: p + 1.5, low: p - 1.5, close: p, volume: 100000 }));
  }
  annotateSwing(down);
  check('rejects pullback in a downtrend', maPullback(down) === null);
}

// ---------------------------------------------------------------
console.log('\n=== MA STACK ===');
{
  const up = [];
  for (let i = 0; i < 240; i++) {
    const p = 100 + i * 0.5;
    up.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 100000 }));
  }
  annotateSwing(up);
  check('fires on a clean stacked uptrend', maStack(up) !== null);

  const down = [];
  for (let i = 0; i < 240; i++) {
    const p = 300 - i * 0.5;
    down.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 100000 }));
  }
  annotateSwing(down);
  check('rejects a downtrend', maStack(down) === null);
}

// ---------------------------------------------------------------
console.log('\n=== 52W HIGH ===');
{
  const candles = [];
  for (let i = 0; i < 250; i++) {
    const p = 100 + i * 0.4;
    candles.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 100000 }));
  }
  annotateSwing(candles);
  check('fires when price is at the highs', near52WeekHigh(candles) !== null);

  // Same series, then a 20% drop
  const dropped = candles.slice();
  const lastP = 100 + 249 * 0.4;
  for (let i = 250; i < 260; i++) {
    const p = lastP * 0.8;
    dropped.push(candle(i, { open: p, high: p + 1, low: p - 1, close: p, volume: 100000 }));
  }
  annotateSwing(dropped);
  check('rejects when well off the highs', near52WeekHigh(dropped) === null);
}

// ---------------------------------------------------------------
console.log('\n=== VOLUME DRYUP ===');
{
  const candles = [];
  for (let i = 0; i < 40; i++) {
    candles.push(candle(i, { open: 100, high: 102, low: 98, close: 100, volume: 200000 }));
  }
  // last 5 bars at 40% of prior volume
  for (let i = 40; i < 45; i++) {
    candles.push(candle(i, { open: 100, high: 102, low: 98, close: 100, volume: 80000 }));
  }
  const dry = volumeDryUp(candles);
  check('fires on volume contraction', dry !== null);
  if (dry) check('ratio below threshold', dry.ratio <= S.SWING_DRYUP_MAX_RATIO, `got ${dry.ratio.toFixed(2)}`);

  const steady = [];
  for (let i = 0; i < 45; i++) {
    steady.push(candle(i, { open: 100, high: 102, low: 98, close: 100, volume: 200000 }));
  }
  check('rejects steady volume', volumeDryUp(steady) === null);
}

// ---------------------------------------------------------------
console.log('\n=== RS LEADER ===');
{
  const candles = [];
  for (let i = 0; i < 100; i++) {
    const p = 100 * Math.pow(1.005, i); // ~+64% over 100 days
    candles.push(candle(i, { open: p, high: p, low: p, close: p, volume: 100000 }));
  }
  const rs = rsLeader(candles, 5); // index only +5%
  check('fires when outperforming the index', rs !== null);
  if (rs) check('outperformance is positive', rs.outperformance > 0, `got ${rs.outperformance.toFixed(1)}`);

  check('rejects when index outperforms', rsLeader(candles, 500) === null);
  check('returns null when index data missing', rsLeader(candles, null) === null);
}

// ---------------------------------------------------------------
console.log('\n=== STOP RESOLUTION ===');
{
  // ATR stop = 100 - 2*3 = 94. Structural at 96 is TIGHTER -> should win.
  const tight = resolveStop(100, 3, 96);
  check('picks the tighter structural stop', tight.stop === 96 && tight.basis === 'structural', JSON.stringify(tight));

  // Structural at 90 is WIDER than the 94 ATR stop -> ATR should win.
  const wide = resolveStop(100, 3, 90);
  check('rejects a structural stop wider than ATR', wide.stop === 94 && wide.basis === 'atr', JSON.stringify(wide));

  const none = resolveStop(100, 3, null);
  check('falls back to ATR with no structural level', none.stop === 94 && none.basis === 'atr');
}

// ---------------------------------------------------------------
console.log('\n=== POSITION SIZING ===');
{
  // Risk budget 5000, stop distance 5 -> 1000 shares by risk.
  // Capital 200000 / entry 100 -> 2000 by capital. Risk binds.
  const byRisk = positionSize(100, 95, 200000);
  check('caps by risk when risk is the binding constraint', byRisk.qty === 1000 && byRisk.cappedBy === 'risk', JSON.stringify(byRisk));
  check('actual risk matches the budget', Math.abs(byRisk.actualRisk - 5000) < 0.01);

  // Tight stop (distance 1) -> 5000 by risk, but capital only allows 2000.
  const byCapital = positionSize(100, 99, 200000);
  check('caps by capital when capital is the binding constraint', byCapital.qty === 2000 && byCapital.cappedBy === 'capital', JSON.stringify(byCapital));

  check('rejects an inverted stop', positionSize(100, 105, 200000) === null);
  check('rejects when capital allows zero shares', positionSize(5000, 4999, 1000) === null);
}

// ---------------------------------------------------------------
console.log('\n=== POSITION LIFECYCLE ===');
{
  const swingState = require('./src/state/swingState');
  const { openPosition, managePosition } = require('./src/trading/swingPositionManager');

  swingState.reset();

  // entry 100, ATR 2 -> ATR stop = 96, structural 97 is tighter -> stop 97, R = 3
  const result = openPosition('TESTCO', 100, 2, 97, { dateKey: '2026-01-01', signals: ['BASE BREAKOUT'] });
  check('opens a position', result.sizing !== undefined, JSON.stringify(result));

  const st = swingState.getState();
  const pos = st.openPositions.TESTCO;
  check('stop set to the tighter structural level', pos.stop === 97, `got ${pos.stop}`);
  check('risk per share = 3', pos.riskPerShare === 3, `got ${pos.riskPerShare}`);
  check('target at 2.5R = 107.5', Math.abs(pos.target - 107.5) < 0.001, `got ${pos.target}`);
  check('persisted to disk', require('fs').existsSync(swingState.STATE_FILE));

  // Price rises but not to target -> nothing fires
  let msgs = managePosition('TESTCO', 104, 2);
  check('no exit before target', msgs.length === 0, JSON.stringify(msgs));
  check('bars held incremented', st.openPositions.TESTCO.barsHeld === 1);

  // Hit target -> partial book, stop to breakeven
  msgs = managePosition('TESTCO', 108, 2);
  check('target fires a partial book', msgs.some((m) => m.includes('SWING TARGET')), JSON.stringify(msgs));
  check('partialBooked set', st.openPositions.TESTCO.partialBooked === true);
  check('stop moved to breakeven', st.openPositions.TESTCO.stop === 100, `got ${st.openPositions.TESTCO.stop}`);
  check('target hit counter incremented', st.counters.targetHits === 1);

  // Runner rises -> trail should raise
  msgs = managePosition('TESTCO', 120, 2);
  check('trail raises on a new peak', msgs.some((m) => m.includes('TRAIL RAISED')), JSON.stringify(msgs));
  const raisedStop = st.openPositions.TESTCO.stop;
  check('trail stop is peak - 2.5*ATR', Math.abs(raisedStop - (120 - 5)) < 0.001, `got ${raisedStop}`);

  // Drop below trail -> exit
  msgs = managePosition('TESTCO', 110, 2);
  check('trail exit fires', msgs.some((m) => m.includes('TRAIL EXIT')), JSON.stringify(msgs));
  check('position marked closed', st.openPositions.TESTCO.closed === true);
  check('trade journaled', st.closedTrades.length === 1);
  check('trail exit counter incremented', st.counters.trailExits === 1);

  // --- stop-loss path ---
  swingState.reset();
  openPosition('STOPCO', 100, 2, 97, { dateKey: '2026-01-01', signals: ['MA PULLBACK'] });
  msgs = managePosition('STOPCO', 96, 2);
  check('stop fires when price closes below it', msgs.some((m) => m.includes('SWING STOP')), JSON.stringify(msgs));
  const st2 = swingState.getState();
  check('loss recorded as negative P&L', st2.totalRealizedPnl < 0, `got ${st2.totalRealizedPnl}`);
  check('stop counter incremented', st2.counters.stopHits === 1);

  // --- time stop path ---
  swingState.reset();
  openPosition('SLOWCO', 100, 2, 97, { dateKey: '2026-01-01', signals: ['MA STACK'] });
  let timeStopFired = false;
  for (let d = 0; d < S.SWING_TIME_STOP_DAYS + 1; d++) {
    const m = managePosition('SLOWCO', 101, 2); // drifts, never reaches 1R (=103)
    if (m.some((x) => x.includes('TIME STOP'))) timeStopFired = true;
  }
  check('time stop fires on a stalled position', timeStopFired);
  check('time stop counter incremented', swingState.getState().counters.timeStops === 1);

  // --- concurrency cap ---
  swingState.reset();
  for (let i = 0; i < S.SWING_MAX_OPEN_POSITIONS; i++) {
    openPosition(`SYM${i}`, 100, 2, 97, { dateKey: '2026-01-01', signals: ['BASE BREAKOUT'] });
  }
  const overflow = openPosition('EXTRA', 100, 2, 97, { dateKey: '2026-01-01', signals: ['BASE BREAKOUT'] });
  check('rejects beyond max open positions', overflow.rejected !== undefined, JSON.stringify(overflow));

  // --- duplicate symbol ---
  swingState.reset();
  openPosition('DUPE', 100, 2, 97, { dateKey: '2026-01-01', signals: ['BASE BREAKOUT'] });
  const dupe = openPosition('DUPE', 105, 2, 100, { dateKey: '2026-01-02', signals: ['MA PULLBACK'] });
  check('rejects a duplicate open on the same symbol', dupe.rejected !== undefined, JSON.stringify(dupe));

  swingState.reset();
}

// ---------------------------------------------------------------
console.log('\n=== PERSISTENCE ===');
{
  const swingState = require('./src/state/swingState');
  const { openPosition } = require('./src/trading/swingPositionManager');

  swingState.reset();
  openPosition('PERSIST', 100, 2, 97, { dateKey: '2026-01-01', signals: ['BASE BREAKOUT'] });

  // Simulate a restart by clearing the module cache and reloading from disk
  delete require.cache[require.resolve('./src/state/swingState')];
  const reloaded = require('./src/state/swingState');
  reloaded.load();
  const open = reloaded.openPositionsList();
  check('position survives a reload', open.length === 1 && open[0].symbol === 'PERSIST', JSON.stringify(open));
  check('entry price preserved', open[0].entry === 100);
  check('stop preserved', open[0].stop === 97);
  reloaded.reset();
}

// ---------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
