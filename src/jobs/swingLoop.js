/**
 * The swing scan cycle.
 *
 * Runs ONCE per trading day, after the close (SWING_SCAN_TIME), rather than
 * on the intraday loop's 15-30 second tick. Two reasons:
 *
 *   1. Daily signals evaluated against a still-forming candle are wrong. A
 *      "base breakout on 1.8x volume" checked at 11:00 is comparing a third
 *      of a day's volume against full-day averages.
 *   2. Nothing about a daily-timeframe signal changes between 10:00 and
 *      15:30 in a way that should trigger an alert. Polling it every 30
 *      seconds would be ~800 redundant passes a day over ~150 symbols.
 *
 * The loop still ticks every few minutes, but only to check whether the
 * scheduled time has arrived and whether today's scan has already run.
 */

const swingState = require("../state/swingState");
const { getSwingCandidates } = require("../services/swingScanner");
const {
  evaluateSwingSignals,
  getIndexReturn,
  loadDaily,
} = require("../indicators/swingSignals");
const {
  openPosition,
  managePosition,
  openPositionCount,
  totalCapitalDeployed,
} = require("../trading/swingPositionManager");
const { safeSend } = require("../services/telegram");
const { nowIST, isWeekend, toMinutes } = require("../config/timeUtils");
const journal = require("../state/signalJournal");
const eventStream = require("../services/eventStream");
const pushClient = require("../services/pushClient");
const S = require("../config/swingConstants");

let running = false;
let timer = null;
let scanning = false; // guards against a second scan starting while one is mid-flight

const min = (t) => toMinutes(t);

/**
 * Manage every open position against its latest daily close. Runs BEFORE the
 * hunt for new entries, so capital freed by an exit today is available to a
 * new entry today.
 */
async function manageOpenPositions() {
  const positions = swingState.openPositionsList();
  if (positions.length === 0) return;

  console.log(`[swing] managing ${positions.length} open position(s)...`);

  for (const pos of positions) {
    try {
      const candles = await loadDaily(pos.symbol);
      if (!candles) {
        await safeSend(
          `⚠️ SWING DATA MISSING — ${pos.symbol}\n` +
            `Couldn't fetch daily candles — position NOT evaluated today.\n` +
            `Manage manually: entry ₹${pos.entry.toFixed(2)}, stop ₹${pos.stop.toFixed(2)}`,
        );
        continue;
      }
      const last = candles[candles.length - 1];
      const messages = managePosition(pos.symbol, last.close, last.atr);
      for (const msg of messages) await safeSend(msg);
    } catch (e) {
      console.error(`[swing] manage error [${pos.symbol}]: ${e.message}`);
    }
  }
}

/** Hunt for new swing entries across the candidate universe. */
async function scanForEntries(dateKey) {
  let universe;
  try {
    universe = await getSwingCandidates();
  } catch (e) {
    console.error(`[swing] candidate fetch failed: ${e.message}`);
    await safeSend(
      `⚠️ SWING SCAN FAILED\nCouldn't fetch candidate universe: ${e.message}`,
    );
    return { scanned: 0, alerted: 0 };
  }

  const symbols = Object.keys(universe);
  console.log(
    `[swing] ${symbols.length} candidates passed the screener filter`,
  );

  const indexReturn = await getIndexReturn();
  if (indexReturn === null) {
    console.warn(
      "[swing] index return unavailable — RS LEADER signal disabled for this scan",
    );
  }

  let alerted = 0;
  const found = [];

  for (const symbol of symbols) {
    if (swingState.alreadyAlerted(dateKey, symbol)) continue;

    const result = await evaluateSwingSignals(symbol, indexReturn, {
      dropPartialBar: getMarketStatus().isOpen,
    });
    if (!result) continue;
    if (result.signals.length < S.SWING_CONFLUENCE_MIN_SIGNALS) continue;

    found.push({ ...result, info: universe[symbol] });
  }

  // Rank by signal count, then by 3-month performance - so if the capital or
  // concurrency cap bites, it bites on the weakest setups rather than
  // whichever symbol happened to be alphabetically first.
  found.sort((a, b) => {
    if (b.signals.length !== a.signals.length)
      return b.signals.length - a.signals.length;
    return (b.info?.perf3Month || 0) - (a.info?.perf3Month || 0);
  });

  for (const result of found) {
    const { symbol, signals, close, atr, rsi, info } = result;

    const labels = signals
      .map((s) => `${S.SWING_SIGNAL_EMOJI[s.label] || "🔔"} ${s.label}`)
      .join(" + ");
    const details = signals
      .map((s) => `  ${S.SWING_SIGNAL_EMOJI[s.label] || "🔔"} ${s.detail}`)
      .join("\n");

    const lines = [
      `📊 SWING SETUP — ${symbol}`,
      `💰 ₹${close.toFixed(2)}  |  ATR ₹${atr.toFixed(2)}  |  RSI ${rsi ? rsi.toFixed(0) : "-"}`,
      info?.sector ? `🏷 ${info.sector}` : null,
      info?.perf3Month !== undefined
        ? `📈 3M: ${info.perf3Month >= 0 ? "+" : ""}${info.perf3Month.toFixed(1)}%`
        : null,
      labels,
      details,
    ].filter(Boolean);

    // Only structural signals can define an entry stop
    const entrySignal = signals.find(
      (s) => s.entry !== null && s.structuralStop !== null,
    );

    if (entrySignal) {
      const outcome = openPosition(
        symbol,
        entrySignal.entry,
        atr,
        entrySignal.structuralStop,
        {
          dateKey,
          signals: signals.map((s) => s.label),
        },
      );

      if (outcome.sizing) {
        const sz = outcome.sizing;
        const partialQty = Math.floor(sz.qty * S.SWING_PARTIAL_EXIT_FRACTION);
        lines.push(
          `📐 Qty ${sz.qty} | Risk ₹${sz.actualRisk.toFixed(0)} | Capital ₹${sz.capitalUsed.toFixed(0)}`,
          `🛑 Stop ₹${sz.stop.toFixed(2)} (${sz.basis}, ${sz.stopDistance.toFixed(2)}/share)`,
          `🎯 Target ₹${sz.target.toFixed(2)} (${sz.rMultiple}R) — book ${partialQty}, trail ${sz.qty - partialQty}`,
        );
      } else {
        lines.push(`⚠️ Not sized: ${outcome.rejected}`);
      }
    } else {
      lines.push(
        "ℹ️ Context signals only — no structural entry level, not sized",
      );
    }

    await safeSend(lines.join("\n"));

    // Persist + push, same defensive wrapping as the intraday side.
    try {
      const record = journal.record({
        mode: "swing",
        symbol,
        signals: signals.map((s) => s.label),
        price: close,
        confluence: signals.length >= S.SWING_CONFLUENCE_MIN_SIGNALS,
        levels: entrySignal
          ? { entry: entrySignal.entry, stop: entrySignal.structuralStop }
          : null,
        context: {
          sector: info?.sector,
          atr,
          rsi,
          perf3Month: info?.perf3Month,
        },
      });
      eventStream.broadcast("signal", record);
      pushClient.pushSignal(record);
    } catch (e) {
      console.error(`[swing] journal/stream error [${symbol}]: ${e.message}`);
    }

    swingState.markAlerted(dateKey, symbol);
    alerted += 1;
  }

  swingState.save();
  return { scanned: symbols.length, alerted };
}

/** Full daily swing pass: manage existing positions, then hunt for new ones. */
async function runSwingScan({ force = false } = {}) {
  if (scanning) {
    console.log("[swing] scan already in progress, skipping");
    return null;
  }
  scanning = true;

  try {
    const { dateKey } = nowIST();
    const state = swingState.getState();

    if (!force && state.lastScanDate === dateKey) {
      return null; // already ran today
    }

    console.log(`[swing] starting daily scan for ${dateKey}`);
    await safeSend(`🔍 SWING SCAN STARTED — ${dateKey}`);
    eventStream.broadcast("scan_status", {
      mode: "swing",
      status: "started",
      dateKey,
    });

    await manageOpenPositions();
    const { scanned, alerted } = await scanForEntries(dateKey);

    state.lastScanDate = dateKey;
    swingState.save();

    const openList = swingState.openPositionsList();
    const openLines =
      openList
        .map((p) => {
          const stage = p.partialBooked ? "runner" : "full";
          const qty = p.partialBooked ? p.runnerQty : p.qty;
          return `  ${p.symbol} [${stage}] ${qty} qty | entry ₹${p.entry.toFixed(2)} | stop ₹${p.stop.toFixed(2)} | ${p.barsHeld}d`;
        })
        .join("\n") || "  (none)";

    const pnl = state.totalRealizedPnl;
    const summary =
      `📋 SWING SCAN COMPLETE — ${dateKey}\n` +
      `🔎 Screened: ${scanned}  |  🆕 New setups: ${alerted}\n` +
      `📌 Open positions (${openList.length}/${S.SWING_MAX_OPEN_POSITIONS}):\n${openLines}\n` +
      `💵 Capital deployed: ₹${totalCapitalDeployed().toFixed(0)} / ₹${S.SWING_TOTAL_CAPITAL}\n` +
      `💰 Realized P&L (all time): ₹${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}\n` +
      `📊 Opened ${state.counters.positionsOpened} | 🛑 ${state.counters.stopHits} | ` +
      `🎯 ${state.counters.targetHits} | 🏁 ${state.counters.trailExits} | ⏳ ${state.counters.timeStops}`;

    await safeSend(summary);

    // Mirror position state to the remote API after each scan, so a hosted
    // read-only instance reflects what this scanner is actually holding.
    await pushClient.pushPositions(
      openList,
      state.totalRealizedPnl,
      state.counters,
      state.closedTrades,
    );

    eventStream.broadcast("scan_status", {
      mode: "swing",
      status: "complete",
      dateKey,
      scanned,
      alerted,
      open: openList.length,
    });
    console.log("[swing] scan complete");

    return { dateKey, scanned, alerted, open: openList.length };
  } catch (e) {
    console.error("[swing] scan error:", e);
    await safeSend(`⚠️ SWING SCAN ERROR\n${e.message}`);
    return null;
  } finally {
    scanning = false;
  }
}

async function tick() {
  try {
    const { time, weekday, dateKey } = nowIST();
    const state = swingState.getState();
    const TEST_MODE = process.env.TEST_MODE === "true";

    if (!TEST_MODE) {
      if (isWeekend(weekday)) {
        // no-op; markets closed
      } else if (
        min(time) >= min(S.SWING_SCAN_TIME) &&
        state.lastScanDate !== dateKey
      ) {
        await runSwingScan();
      }
    }
  } catch (e) {
    console.error("[swing] tick error:", e);
  }

  if (running) {
    timer = setTimeout(tick, S.SWING_SCAN_CHECK_INTERVAL_MS);
  }
}

function start() {
  if (running) return;
  running = true;
  swingState.load();

  const open = swingState.openPositionsList();
  console.log(
    `[swing] loop started — scan scheduled daily at ${String(S.SWING_SCAN_TIME.h).padStart(2, "0")}:${String(S.SWING_SCAN_TIME.m).padStart(2, "0")} IST`,
  );
  if (open.length > 0) {
    console.log(
      `[swing] resumed tracking ${open.length} open position(s): ${open.map((p) => p.symbol).join(", ")}`,
    );
  }

  tick();
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  console.log("[swing] loop stopped.");
}

function isRunning() {
  return running;
}

module.exports = { start, stop, isRunning, runSwingScan, manageOpenPositions };
