/**
 * The scanner's main cycle. Python used `while True: ... t.sleep(s_time)`;
 * here each call to runCycle() returns how many ms to wait, and tick()
 * reschedules itself with setTimeout - same effect, non-blocking.
 *
 * Sequential per-stock processing (one stock's signals awaited before the
 * next starts) mirrors the Python version's single-threaded loop. Each
 * signal check opens its own short-lived TradingView chart session - with
 * a large tracked universe this is the piece most worth parallelizing
 * later (e.g. Promise.all in small batches) if a full cycle starts taking
 * longer than the s_time gap between cycles.
 */

const { state, resetDailyState } = require('../state/dailyState');
const { getStocks, getEarlyStocks } = require('../services/tvScanner');
const { updateMomentum, momentumScore } = require('../trading/momentum');
const { volumeExplosion } = require('../trading/volume');
const {
  trendScore,
  pullbackEntry,
  vwapReclaim,
  noPullbackTrend,
  afternoonBreakout,
  analyzeStock,
  getOrb,
  calculateScore,
} = require('../indicators/signals');
const { openPosition, managePosition } = require('../trading/positionManager');
const { getNiftyChange } = require('../services/nifty');
const { safeSend, fmtInfo, processTelegramCommands } = require('../services/telegram');
const { nowIST, isWeekend, toMinutes } = require('../config/timeUtils');
const journal = require('../state/signalJournal');
const eventStream = require('../services/eventStream');
const pushClient = require('../services/pushClient');
const C = require('../config/constants');

let running = false;
let timer = null;

const min = (t) => toMinutes(t);

function sectorCounterFrom(current) {
  const counter = {};
  for (const info of Object.values(current)) {
    const sector = info.sector || 'Unknown';
    counter[sector] = (counter[sector] || 0) + 1;
  }
  return counter;
}

function topSectors(counter, n = 5) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function buildCloseSummary(dateLabel) {
  const sectorLines =
    topSectors(state.lastSectorCounter)
      .map(([sec, cnt]) => `  ${sec}: ${cnt}`)
      .join('\n') || '  (no data)';
  const pnl = state.totalRealizedPnl;
  return (
    `🔴 MARKET CLOSED — Daily Summary (${dateLabel})\n` +
    `👀 Final tracked: ${state.lastTrackedCount} stocks\n` +
    `🚀 New alerts: ${state.newAlertCount}  |  ❌ Removed: ${state.removedAlertCount}\n` +
    `🎯 Pullbacks: ${state.pullbackAlerted.size}  |  🔥 ORB breakouts: ${state.orbAlerted.size}\n` +
    `⚡ Momentum: ${state.momentumAlerted.size}  |  📊 Volume spikes: ${state.volumeAlerted.size}\n` +
    `📈 VWAP reclaims: ${state.vwapAlerted.size}  |  💎 Strong setups: ${state.confluenceAlertCount}\n` +
    `🏃 No-pullback runners: ${state.noPullbackAlerted.size}\n` +
    `🌇 Afternoon breakouts: ${state.afternoonBreakoutAlerted.size}\n` +
    `—— Trade tracker ——\n` +
    `📌 Positions opened: ${state.positionsOpenedCount}\n` +
    `🛑 Stopped: ${state.stopHitCount}  |  🎯 Targets hit: ${state.targetHitCount}  |  ` +
    `🏁 Trailed out: ${state.trailExitCount}  |  ⏰ Squared off: ${state.squareOffCount}\n` +
    `💰 Realized P&L today: ₹${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}\n` +
    `🏷 Top sectors today:\n${sectorLines}`
  );
}

async function runCycle() {
  await processTelegramCommands(); // every cycle, regardless of market hours

  let { time: nowTime, weekday, dateKey, label } = nowIST();
  const TEST_MODE = process.env.TEST_MODE === 'true';

  let sTime;
  if (min(nowTime) >= min(C.MARKET_OPEN) && min(nowTime) <= min(C.dtime(10, 15))) sTime = 15000;
  else if (min(nowTime) >= min(C.dtime(10, 15)) && min(nowTime) <= min(C.dtime(14, 30))) sTime = 30000;
  else sTime = 20000;

  if (!TEST_MODE) {
    if (isWeekend(weekday)) {
      console.log('Weekend - Sleeping');
      return 300000;
    }
    if (min(nowTime) < min(C.MARKET_OPEN)) {
      console.log('Pre-market - Waiting');
      return 60000;
    }
    if (min(nowTime) > min(C.MARKET_CLOSE)) {
      if (!state.marketClosedSent) {
        await safeSend(buildCloseSummary(label));
        state.marketClosedSent = true;
      }
      return 300000;
    }
  }

  if (state.lastResetDate !== dateKey && min(nowTime) >= min(C.MARKET_OPEN)) {
    resetDailyState();
    state.lastResetDate = dateKey;
  }

  // ---------- Fetch ----------
  let early = {};
  try {
    early = await getEarlyStocks();
  } catch (e) {
    console.error(`getEarlyStocks error: ${e.message}`);
  }
  for (const [stock, info] of Object.entries(early)) {
    try {
      updateMomentum(stock, info);
    } catch (e) {
      console.error(`updateMomentum error [${stock}]: ${e.message}`);
    }
  }

  let current;
  try {
    current = await getStocks();
  } catch (e) {
    console.error(`Fetch Error: ${e.message}`);
    return 10000;
  }
  state.current = current;

  ({ time: nowTime } = nowIST()); // refresh timestamp after the network round-trip
  const inAlertWindow = min(nowTime) >= min(C.TRADING_WINDOW_START) && min(nowTime) <= min(C.TRADING_WINDOW_END);
  const inAfternoonWindow =
    min(nowTime) >= min(C.AFTERNOON_WINDOW_START) && min(nowTime) <= min(C.AFTERNOON_WINDOW_END);

  const currentSymbols = new Set(Object.keys(current));
  const newSymbols = [...currentSymbols].filter((s) => !state.previous.has(s));
  const removedSymbols = [...state.previous].filter((s) => !currentSymbols.has(s));

  const sectorCounter = sectorCounterFrom(current);
  state.lastSectorCounter = sectorCounter;
  state.lastTrackedCount = currentSymbols.size;

  // ---------- Removed stocks ----------
  for (const stock of removedSymbols) {
    const lastPrice = state.priceAlerts[stock];
    const priceStr = lastPrice !== undefined ? `₹${lastPrice.toFixed(2)}` : 'N/A';
    const pos = state.openPositions[stock];
    if (pos && !pos.closed) {
      await safeSend(
        `⚠️ POSITION STOCK DROPPED FROM SCAN — ${stock}\nManage manually — stop was ₹${pos.stop.toFixed(2)}, last seen ${priceStr}`,
      );
      pos.closed = true;
    }
    await safeSend(`❌ REMOVED: ${stock}\n💰 Last seen: ${priceStr}`);
    state.removedAlertCount += 1;
  }

  const niftyChange = await getNiftyChange();

  // ---------- Per-stock processing ----------
  for (const stock of currentSymbols) {
    const info = current[stock];

    if (newSymbols.includes(stock)) {
      let analysis = {};
      try {
        analysis = await analyzeStock(stock, info.price);
      } catch (e) {
        console.error(`analyzeStock error [${stock}]: ${e.message}`);
      }

      let score = 0;
      try {
        score = calculateScore(info);
      } catch (e) {
        console.error(`calculateScore error [${stock}]: ${e.message}`);
      }

      let trend = 0;
      try {
        trend = (await trendScore(stock)) || 0;
      } catch (e) {
        console.error(`trendScore error [${stock}]: ${e.message}`);
      }

      score = Math.min(100, score + Math.floor(trend / 5));
      if (analysis.breakout) score += 20;

      const rrValue = analysis.rr || 0;
      let bonus = 0;
      const outperformingNifty = niftyChange !== null && (info.change || 0) > niftyChange;
      if (outperformingNifty) bonus += C.RS_SCORE_BONUS;
      if (rrValue >= C.RR_BONUS_THRESHOLD) bonus += C.RR_SCORE_BONUS;
      score = Math.min(100, score + bonus);

      if (min(nowTime) >= min(C.MARKET_OPEN) && min(nowTime) <= min(C.ORB_WINDOW_END)) {
        try {
          const [oh, ol] = await getOrb(stock);
          if (oh) state.openingRange[stock] = { high: oh, low: ol };
        } catch (e) {
          console.error(`getOrb error [${stock}]: ${e.message}`);
        }
      }

      state.stockEntryTime[stock] = new Date();
      state.priceAlerts[stock] = info.price;
      state.dayHigh[stock] = info.price;
      state.trailFired[stock] = false;

      const msgLines = [`🚀 NEW STOCK — ${stock}`, fmtInfo(info), `⭐ Score: ${score}/100`];
      if (rrValue > 0) {
        msgLines.push(
          `🎯 Entry ₹${info.price.toFixed(2)}  |  🛑 Stop ₹${analysis.support.toFixed(2)}  |  ` +
            `🏁 Target ₹${analysis.target.toFixed(2)}  |  R:R ${rrValue.toFixed(2)}`,
        );
      }
      if (niftyChange !== null) {
        const diff = (info.change || 0) - niftyChange;
        msgLines.push(`💪 RS vs Nifty: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%`);
      }

      // Position-opening intentionally NOT done here - a NEW alert alone is
      // a single signal. Positions only open on confluence (2+ signals),
      // see the candidates block below.

      const msg = msgLines.join('\n');

      if (C.REQUIRE_RELATIVE_STRENGTH && niftyChange !== null && !outperformingNifty) {
        console.log(`Skipping NEW alert for ${stock}: not outperforming Nifty`);
      } else if (!inAlertWindow) {
        console.log(`Skipping NEW alert for ${stock}: outside alert window`);
      } else {
        await safeSend(msg);
        state.newAlertCount += 1;
      }
    }

    // ---------- Trade management for any open position on this stock ----------
    await managePosition(stock, info.price, nowTime, safeSend);

    // ---------- High-of-day trailing alert ----------
    if (state.stockEntryTime[stock]) {
      const prevHigh = state.dayHigh[stock];
      if (prevHigh === undefined || info.price > prevHigh) {
        state.dayHigh[stock] = info.price;
        state.trailFired[stock] = false;
      } else {
        const dh = state.dayHigh[stock];
        if (dh && !state.trailFired[stock]) {
          const pullbackPct = ((dh - info.price) / dh) * 100;
          if (pullbackPct >= C.TRAIL_PULLBACK_PCT) {
            if (inAlertWindow) {
              await safeSend(
                `⚠️ PULLBACK FROM HIGH — ${stock}\n${fmtInfo(info)}\n📉 -${pullbackPct.toFixed(1)}% from day high ₹${dh.toFixed(2)}`,
              );
            }
            state.trailFired[stock] = true;
          }
        }
      }
    }

    // ---------- Confluence: gather all signal candidates before sending ----------
    const candidates = []; // { label, detail, alertedSet, entryStop }

    if (!state.pullbackAlerted.has(stock)) {
      let pb = null;
      try {
        pb = await pullbackEntry(stock);
      } catch (e) {
        console.error(`pullbackEntry error [${stock}]: ${e.message}`);
      }
      if (pb && pb.entry !== undefined) {
        const stopForPb = pb.ema9 * (1 - C.STOP_BUFFER_PCT / 100);
        candidates.push({
          label: 'PULLBACK',
          detail: `Pullback entry @ ₹${pb.entry.toFixed(2)}`,
          alertedSet: state.pullbackAlerted,
          entryStop: [pb.entry, stopForPb],
        });
      }
    }

    if (min(nowTime) >= min(C.ORB_CHECK_START) && state.openingRange[stock] && !state.orbAlerted.has(stock)) {
      const orbHigh = state.openingRange[stock].high;
      const orbLow = state.openingRange[stock].low;
      if (orbHigh !== null && info.price > orbHigh) {
        const entryStop = orbLow ? [info.price, orbLow] : null;
        candidates.push({
          label: 'ORB BREAKOUT',
          detail: `Broke opening range high ₹${orbHigh.toFixed(2)}`,
          alertedSet: state.orbAlerted,
          entryStop,
        });
      }
    }

    if (!state.momentumAlerted.has(stock)) {
      let mScore = 0;
      try {
        mScore = momentumScore(stock);
      } catch (e) {
        console.error(`momentumScore error [${stock}]: ${e.message}`);
      }
      if (mScore >= C.MOMENTUM_SCORE_THRESHOLD) {
        candidates.push({
          label: 'MOMENTUM',
          detail: `Momentum score ${mScore}/100`,
          alertedSet: state.momentumAlerted,
          entryStop: null,
        });
      }
    }

    if (!state.volumeAlerted.has(stock)) {
      let vol = null;
      try {
        vol = await volumeExplosion(stock);
      } catch (e) {
        console.error(`volumeExplosion error [${stock}]: ${e.message}`);
      }
      if (vol && vol.ratio >= C.VOLUME_RATIO_THRESHOLD) {
        candidates.push({
          label: 'VOLUME SPIKE',
          detail: `${vol.ratio.toFixed(1)}x average volume`,
          alertedSet: state.volumeAlerted,
          entryStop: null,
        });
      }
    }

    if (!state.vwapAlerted.has(stock)) {
      let reclaimed = false;
      try {
        reclaimed = await vwapReclaim(stock);
      } catch (e) {
        console.error(`vwapReclaim error [${stock}]: ${e.message}`);
      }
      if (reclaimed) {
        candidates.push({
          label: 'VWAP RECLAIM',
          detail: 'Price reclaimed VWAP',
          alertedSet: state.vwapAlerted,
          entryStop: null,
        });
      }
    }

    if (!state.noPullbackAlerted.has(stock)) {
      let npb = null;
      try {
        npb = await noPullbackTrend(stock);
      } catch (e) {
        console.error(`noPullbackTrend error [${stock}]: ${e.message}`);
      }
      if (npb) {
        candidates.push({
          label: 'NO-PULLBACK RUNNER',
          detail: `${npb.distanceFromEma9Pct.toFixed(1)}% above EMA9, VWAP ₹${npb.vwap.toFixed(2)}`,
          alertedSet: state.noPullbackAlerted,
          entryStop: [npb.price, npb.stop],
        });
      }
    }

    // Only evaluated within its own window - gating the evaluation itself
    // (not just the send) keeps this cleanly separate from the general
    // 12:30 cutoff on other signals.
    if (inAfternoonWindow && !state.afternoonBreakoutAlerted.has(stock)) {
      let ab = null;
      try {
        ab = await afternoonBreakout(stock);
      } catch (e) {
        console.error(`afternoonBreakout error [${stock}]: ${e.message}`);
      }
      if (ab) {
        candidates.push({
          label: 'AFTERNOON BREAKOUT',
          detail: `Broke ${ab.baseRangePct.toFixed(1)}%-tight base @ ₹${ab.baseHigh.toFixed(2)}, ${ab.volumeRatio.toFixed(1)}x base volume`,
          alertedSet: state.afternoonBreakoutAlerted,
          entryStop: [ab.price, ab.stop],
        });
      }
    }

    // Only open a position on CONFLUENCE (2+/3+ signals agreeing) - a lone
    // PULLBACK/ORB/etc still alerts below, it just no longer commits capital.
    let newlyOpened = null;
    if (!state.openPositions[stock] && candidates.length >= C.CONFLUENCE_MIN_SIGNALS) {
      for (const c of candidates) {
        if (c.entryStop) {
          const [entryP, stopP] = c.entryStop;
          const sizing = openPosition(stock, entryP, stopP);
          if (sizing) {
            newlyOpened = sizing;
            state.positionsOpenedCount += 1;
          }
          break;
        }
      }
    }

    if (candidates.length > 0) {
      if (inAlertWindow || inAfternoonWindow) {
        let msg;
        if (candidates.length >= C.CONFLUENCE_MIN_SIGNALS) {
          const labels = candidates.map((c) => `${C.SIGNAL_EMOJI[c.label] || '🔔'} ${c.label}`).join(' + ');
          const details = candidates.map((c) => `  ${C.SIGNAL_EMOJI[c.label] || '🔔'} ${c.detail}`).join('\n');
          msg = `💎 STRONG SETUP — ${stock}\n${fmtInfo(info)}\n${labels}\n${details}`;
          state.confluenceAlertCount += 1;
          state.confluenceAlertedStocks.add(stock);
        } else {
          const c = candidates[0];
          const emoji = C.SIGNAL_EMOJI[c.label] || '🔔';
          msg = `${emoji} ${c.label} — ${stock}\n${fmtInfo(info)}\n${c.detail}`;
        }

        if (newlyOpened) {
          const partialQty = Math.floor(newlyOpened.qty * C.PARTIAL_EXIT_FRACTION);
          msg +=
            `\n📐 Qty ${newlyOpened.qty} | Risk ₹${newlyOpened.actualRisk.toFixed(0)} (stop ₹${newlyOpened.stop.toFixed(2)})\n` +
            `  Plan: book ${partialQty} qty @ ₹${(newlyOpened.entry + C.TARGET_POINTS_LOW).toFixed(2)} ` +
            `(entry +${C.TARGET_POINTS_LOW}pts), trail remaining ${newlyOpened.qty - partialQty}`;
        }

        await safeSend(msg);

        // Persist + push. Wrapped so a journal or stream failure can never
        // take down the scan cycle - alerting is the primary job here, the
        // API feed is secondary.
        try {
          const entryStop = candidates.find((c) => c.entryStop)?.entryStop;
          const record = journal.record({
            mode: 'intraday',
            symbol: stock,
            signals: candidates.map((c) => c.label),
            price: info.price,
            confluence: candidates.length >= C.CONFLUENCE_MIN_SIGNALS,
            levels: entryStop ? { entry: entryStop[0], stop: entryStop[1] } : null,
            context: {
              sector: info.sector,
              change: info.change,
              relVolume: info.relVolume,
            },
          });
          eventStream.broadcast('signal', record);
          pushClient.pushSignal(record);
        } catch (e) {
          console.error(`[scanLoop] journal/stream error [${stock}]: ${e.message}`);
        }
      }

      for (const c of candidates) c.alertedSet.add(stock);
    }
  }

  // ---------- Periodic market summary ----------
  if (Date.now() - state.lastSummaryTime >= C.SUMMARY_INTERVAL_MS && Object.keys(sectorCounter).length > 0) {
    const lines = topSectors(sectorCounter)
      .map(([sec, cnt]) => `  ${sec}: ${cnt}`)
      .join('\n');
    const openCount = Object.values(state.openPositions).filter((p) => !p.closed).length;
    const pnl = state.totalRealizedPnl;
    const summaryMsg =
      `📊 MARKET SUMMARY (${String(nowTime.h).padStart(2, '0')}:${String(nowTime.m).padStart(2, '0')})\n` +
      `👀 Tracking: ${currentSymbols.size} stocks\n` +
      `🚀 New: ${state.newAlertCount}  |  ❌ Removed: ${state.removedAlertCount}  |  💎 Strong setups: ${state.confluenceAlertCount}\n` +
      `💰 Realized P&L: ₹${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}  |  📌 Open positions: ${openCount}\n` +
      `🏷 Top sectors:\n${lines}`;
    await safeSend(summaryMsg);
    state.lastSummaryTime = Date.now();
  }

  state.previous = currentSymbols;
  return sTime;
}

async function tick() {
  let waitMs = 20000;
  try {
    waitMs = await runCycle();
  } catch (e) {
    console.error('[scanLoop] cycle error:', e);
    waitMs = 10000;
  }
  if (running) {
    timer = setTimeout(tick, waitMs);
  }
}

async function start() {
  if (running) return;
  running = true;

  console.log('Loading initial stocks...');
  try {
    state.previous = new Set(Object.keys(await getStocks()));
  } catch (e) {
    console.error(`Initial fetch failed, starting empty: ${e.message}`);
    state.previous = new Set();
  }
  console.log(`Tracking ${state.previous.size} existing stocks.`);
  console.log('Scanner Started...');

  await safeSend('🟢 SCANNER STARTED\n✅ Running...');
  tick();
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  console.log('Scanner stopped.');
}

function isRunning() {
  return running;
}

module.exports = { start, stop, isRunning, runCycle };
