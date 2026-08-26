/**
 * This is a sizing + exit-management CALCULATOR, not a broker connection -
 * it tells you what to do, you place the actual orders. Same disclaimer as
 * the Python version.
 *
 * position_size(): qty capped by BOTH RISK_CAPITAL (max rupee loss) and
 * TOTAL_CAPITAL, and via open_position(), by whatever capital is already
 * tied up in other open positions today - never suggests combined exposure
 * beyond TOTAL_CAPITAL.
 *
 * managePosition(): runs every cycle for any stock with an open position -
 *   price <= stop, before target     -> STOP HIT, full exit
 *   price >= entry + TARGET_POINTS_LOW -> TARGET HIT, book partial, trail rest
 *   pulls back TRAIL_PULLBACK_PCT% from peak -> TRAIL EXIT for the remainder
 *   remaining qty's breakeven stop hit first -> flat exit
 *   at/after SQUARE_OFF_TIME -> force-exit whatever's still open
 */

const { state } = require('../state/dailyState');
const {
  RISK_CAPITAL,
  TOTAL_CAPITAL,
  LEVERAGE_MULTIPLIER,
  TARGET_POINTS_LOW,
  PARTIAL_EXIT_FRACTION,
  TRAIL_PULLBACK_PCT,
  SQUARE_OFF_TIME,
} = require('../config/constants');
const { timeGte } = require('../config/timeUtils');

function totalCapitalDeployed() {
  return Object.values(state.openPositions)
    .filter((p) => !p.closed)
    .reduce((sum, p) => sum + p.qty * p.entry, 0);
}

function positionSize(entryPrice, stopPrice, capitalOverride = null) {
  const stopDistance = entryPrice - stopPrice;
  if (stopDistance <= 0) return null;

  const capitalCeiling = capitalOverride === null ? TOTAL_CAPITAL * LEVERAGE_MULTIPLIER : capitalOverride;
  const qtyByRisk = Math.floor(RISK_CAPITAL / stopDistance);
  const qtyByCapital = entryPrice > 0 ? Math.floor(capitalCeiling / entryPrice) : 0;
  const qty = Math.min(qtyByRisk, qtyByCapital);
  if (qty <= 0) return null;

  return {
    qty,
    entry: entryPrice,
    stop: stopPrice,
    stopDistance,
    actualRisk: qty * stopDistance,
    capitalUsed: qty * entryPrice,
    cappedBy: qtyByRisk <= qtyByCapital ? 'risk' : 'capital',
  };
}

/** Registers one tracked position per stock per day, capped by remaining daily capital. */
function openPosition(stock, entry, stop) {
  const remainingCapital = TOTAL_CAPITAL * LEVERAGE_MULTIPLIER - totalCapitalDeployed();
  if (remainingCapital <= 0) return null;

  const sizing = positionSize(entry, stop, remainingCapital);
  if (!sizing) return null;

  state.openPositions[stock] = {
    entry,
    stop,
    qty: sizing.qty,
    target: entry + TARGET_POINTS_LOW,
    partialBooked: false,
    runnerQty: 0,
    highest: entry,
    closed: false,
  };
  return sizing;
}

/** One cycle of exit management for `stock`'s open position, if any. Mutates state and sends alerts. */
async function managePosition(stock, price, nowTime, safeSend) {
  const pos = state.openPositions[stock];
  if (!pos || pos.closed) return;

  if (timeGte(nowTime, SQUARE_OFF_TIME)) {
    const qtyLeft = pos.partialBooked ? pos.runnerQty : pos.qty;
    const pnl = qtyLeft * (price - pos.entry);
    state.totalRealizedPnl += pnl;
    state.squareOffCount += 1;
    await safeSend(
      `⏰ SQUARE OFF — ${stock}\nExit ${qtyLeft} qty @ ₹${price.toFixed(2)} (≈ ₹${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)})`,
    );
    pos.closed = true;
    return;
  }

  if (!pos.partialBooked) {
    if (price <= pos.stop) {
      const loss = pos.qty * (pos.entry - pos.stop);
      state.totalRealizedPnl -= loss;
      state.stopHitCount += 1;
      await safeSend(
        `🛑 STOP HIT — ${stock}\nExit ${pos.qty} qty @ ₹${pos.stop.toFixed(2)}\nLoss ≈ ₹${loss.toFixed(0)}`,
      );
      pos.closed = true;
    } else if (price >= pos.target) {
      const partialQty = Math.floor(pos.qty * PARTIAL_EXIT_FRACTION);
      const runnerQty = pos.qty - partialQty;
      const profit = partialQty * (pos.target - pos.entry);
      state.totalRealizedPnl += profit;
      state.targetHitCount += 1;
      await safeSend(
        `🎯 TARGET HIT — ${stock}\n` +
          `Book ${partialQty} qty @ ₹${pos.target.toFixed(2)} (≈ ₹${profit.toFixed(0)} booked)\n` +
          `Let ${runnerQty} qty ride, stop moved to breakeven ₹${pos.entry.toFixed(2)}`,
      );
      pos.partialBooked = true;
      pos.runnerQty = runnerQty;
      pos.stop = pos.entry;
      pos.highest = price;
    }
  } else {
    if (price > pos.highest) {
      pos.highest = price;
    } else if (price <= pos.stop) {
      state.trailExitCount += 1;
      await safeSend(
        `🏁 RUNNER STOPPED AT BREAKEVEN — ${stock}\nExit remaining ${pos.runnerQty} qty @ ₹${pos.stop.toFixed(2)}`,
      );
      pos.closed = true;
    } else if (price <= pos.highest * (1 - TRAIL_PULLBACK_PCT / 100)) {
      const profit = pos.runnerQty * (price - pos.entry);
      state.totalRealizedPnl += profit;
      state.trailExitCount += 1;
      await safeSend(
        `🏁 TRAIL EXIT — ${stock}\nExit remaining ${pos.runnerQty} qty @ ₹${price.toFixed(2)} (≈ ₹${profit.toFixed(0)})`,
      );
      pos.closed = true;
    }
  }
}

module.exports = { positionSize, openPosition, totalCapitalDeployed, managePosition };
