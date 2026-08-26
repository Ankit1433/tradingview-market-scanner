/**
 * Swing position sizing and management.
 *
 * Differences from the intraday manager, all deliberate:
 *
 *   - Stops are ATR-based, not fixed-point. Entry - (2 * ATR14). When a
 *     signal also supplies a structural level (base low, swing low), the
 *     TIGHTER of the two is used - a structural stop that's wider than 2 ATR
 *     usually means the base is too loose to be worth trading.
 *   - Targets are R-multiples, not points. First target at 2.5R.
 *   - The trail is chandelier-style (peak - 2.5 * ATR), which widens with
 *     volatility instead of using a fixed percentage. A 1.5% trail on a daily
 *     chart would stop you out on ordinary noise almost immediately.
 *   - There is NO square-off. Positions run until an exit condition fires.
 *   - There IS a time stop. A swing position that hasn't reached 1R after
 *     SWING_TIME_STOP_DAYS sessions is tying up capital and risk budget for
 *     nothing, so it's cut. Intraday has no equivalent because the close
 *     forces the issue anyway.
 *   - Concurrency is capped (SWING_MAX_OPEN_POSITIONS) on top of the capital
 *     cap, because 5 positions each risking the full per-trade amount is a
 *     much bigger drawdown exposure than the capital number alone suggests.
 *
 * Like the intraday manager, this is a calculator - it tells you what to do,
 * you place the orders.
 */

const swingState = require('../state/swingState');
const eventStream = require('../services/eventStream');
const S = require('../config/swingConstants');

function totalCapitalDeployed() {
  return swingState
    .openPositionsList()
    .reduce((sum, p) => sum + p.qty * p.entry, 0);
}

function openPositionCount() {
  return swingState.openPositionsList().length;
}

/**
 * Resolve the initial stop: ATR-based, tightened to a structural level if one
 * is supplied and it's closer than the ATR stop.
 */
function resolveStop(entry, atr, structuralStop) {
  const atrStop = entry - atr * S.SWING_ATR_STOP_MULTIPLIER;
  if (structuralStop && structuralStop < entry && structuralStop > atrStop) {
    return { stop: structuralStop, basis: 'structural' };
  }
  return { stop: atrStop, basis: 'atr' };
}

function positionSize(entry, stop, capitalCeiling) {
  const stopDistance = entry - stop;
  if (stopDistance <= 0) return null;

  const qtyByRisk = Math.floor(S.SWING_RISK_CAPITAL / stopDistance);
  const qtyByCapital = entry > 0 ? Math.floor(capitalCeiling / entry) : 0;
  const qty = Math.min(qtyByRisk, qtyByCapital);
  if (qty <= 0) return null;

  return {
    qty,
    entry,
    stop,
    stopDistance,
    actualRisk: qty * stopDistance,
    capitalUsed: qty * entry,
    cappedBy: qtyByRisk <= qtyByCapital ? 'risk' : 'capital',
  };
}

/**
 * Register a new swing position. Returns null (with a logged reason) if any
 * cap would be breached - the caller alerts the signal regardless, it just
 * doesn't get a size attached.
 */
function openPosition(symbol, entry, atr, structuralStop, meta = {}) {
  const state = swingState.getState();

  if (state.openPositions[symbol] && !state.openPositions[symbol].closed) {
    return { rejected: 'already holding this symbol' };
  }
  if (openPositionCount() >= S.SWING_MAX_OPEN_POSITIONS) {
    return { rejected: `at max open positions (${S.SWING_MAX_OPEN_POSITIONS})` };
  }

  const remainingCapital = S.SWING_TOTAL_CAPITAL - totalCapitalDeployed();
  if (remainingCapital <= 0) {
    return { rejected: 'swing capital fully deployed' };
  }

  const { stop, basis } = resolveStop(entry, atr, structuralStop);
  const sizing = positionSize(entry, stop, remainingCapital);
  if (!sizing) {
    return { rejected: 'position size resolved to zero (stop too wide for risk budget)' };
  }

  const risk = sizing.stopDistance;

  state.openPositions[symbol] = {
    entry,
    stop,
    initialStop: stop,
    stopBasis: basis,
    atrAtEntry: atr,
    qty: sizing.qty,
    riskPerShare: risk,
    target: entry + risk * S.SWING_TARGET_R_MULTIPLE,
    partialBooked: false,
    runnerQty: 0,
    highest: entry,
    barsHeld: 0,
    openedOn: meta.dateKey || null,
    signals: meta.signals || [],
    closed: false,
  };

  state.counters.positionsOpened += 1;
  swingState.save();

  return { sizing: { ...sizing, basis, target: state.openPositions[symbol].target, rMultiple: S.SWING_TARGET_R_MULTIPLE } };
}

function closeOut(symbol, pos, exitPrice, qty, reason, state) {
  const pnl = qty * (exitPrice - pos.entry);
  state.totalRealizedPnl += pnl;
  pos.closed = true;
  state.closedTrades.push({
    symbol,
    entry: pos.entry,
    exit: exitPrice,
    qty,
    pnl,
    reason,
    openedOn: pos.openedOn,
    barsHeld: pos.barsHeld,
    signals: pos.signals,
  });
  return pnl;
}

/**
 * One evaluation pass for a single open position, given the latest daily
 * close and ATR. Returns an array of alert message strings (usually 0 or 1).
 *
 * Called once per position per daily scan - not on a live tick. Swing exits
 * are evaluated on closing prices, which is what the stops are designed
 * around. (If you want intraday stop triggering, that's a real broker
 * stop-loss order sitting in the market, not this.)
 */
function managePosition(symbol, close, atr) {
  const state = swingState.getState();
  const pos = state.openPositions[symbol];
  if (!pos || pos.closed) return [];

  const messages = [];
  pos.barsHeld += 1;

  const r = pos.riskPerShare;
  const currentR = r > 0 ? (close - pos.entry) / r : 0;

  if (!pos.partialBooked) {
    if (close <= pos.stop) {
      const loss = closeOut(symbol, pos, pos.stop, pos.qty, 'stop', state);
      state.counters.stopHits += 1;
      messages.push(
        `🛑 SWING STOP — ${symbol}\nExit ${pos.qty} qty @ ₹${pos.stop.toFixed(2)}\nP&L ≈ ₹${loss.toFixed(0)} (${currentR.toFixed(2)}R)`,
      );
    } else if (close >= pos.target) {
      const partialQty = Math.floor(pos.qty * S.SWING_PARTIAL_EXIT_FRACTION);
      const runnerQty = pos.qty - partialQty;
      const profit = partialQty * (pos.target - pos.entry);
      state.totalRealizedPnl += profit;
      state.counters.targetHits += 1;

      pos.partialBooked = true;
      pos.runnerQty = runnerQty;
      pos.stop = pos.entry; // breakeven
      pos.highest = close;

      messages.push(
        `🎯 SWING TARGET — ${symbol}\n` +
          `Book ${partialQty} qty @ ₹${pos.target.toFixed(2)} (≈ ₹${profit.toFixed(0)}, ${S.SWING_TARGET_R_MULTIPLE}R)\n` +
          `Let ${runnerQty} qty run, stop → breakeven ₹${pos.entry.toFixed(2)}`,
      );
    } else if (pos.barsHeld >= S.SWING_TIME_STOP_DAYS && currentR < 1) {
      const pnl = closeOut(symbol, pos, close, pos.qty, 'time_stop', state);
      state.counters.timeStops += 1;
      messages.push(
        `⏳ SWING TIME STOP — ${symbol}\n` +
          `${pos.barsHeld} sessions held, still under 1R (${currentR.toFixed(2)}R)\n` +
          `Exit ${pos.qty} qty @ ₹${close.toFixed(2)} (≈ ₹${pnl.toFixed(0)})`,
      );
    }
  } else {
    // Runner phase - chandelier trail from the peak, widened by ATR
    if (close > pos.highest) pos.highest = close;

    const trailStop = pos.highest - (atr || pos.atrAtEntry) * S.SWING_TRAIL_ATR_MULTIPLIER;
    const effectiveStop = Math.max(pos.stop, trailStop); // never loosen

    if (close <= effectiveStop) {
      const pnl = closeOut(symbol, pos, close, pos.runnerQty, 'trail', state);
      state.counters.trailExits += 1;
      messages.push(
        `🏁 SWING TRAIL EXIT — ${symbol}\n` +
          `Exit remaining ${pos.runnerQty} qty @ ₹${close.toFixed(2)} (≈ ₹${pnl.toFixed(0)}, ${currentR.toFixed(2)}R)`,
      );
    } else if (effectiveStop > pos.stop) {
      pos.stop = effectiveStop;
      messages.push(
        `📈 SWING TRAIL RAISED — ${symbol}\n` +
          `Stop → ₹${effectiveStop.toFixed(2)} (peak ₹${pos.highest.toFixed(2)}, ${currentR.toFixed(2)}R open)`,
      );
    }
  }

  swingState.save();

  // Push position events to any connected stream clients. Wrapped because a
  // broken client connection must never propagate into position management.
  if (messages.length > 0) {
    try {
      eventStream.broadcast('position', {
        mode: 'swing',
        symbol,
        close,
        events: messages.map((m) => m.split('\n')[0]),
        closed: pos.closed,
        barsHeld: pos.barsHeld,
      });
    } catch (e) {
      console.error(`[swing] stream error [${symbol}]: ${e.message}`);
    }
  }

  return messages;
}

module.exports = {
  positionSize,
  resolveStop,
  openPosition,
  managePosition,
  totalCapitalDeployed,
  openPositionCount,
};
