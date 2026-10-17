/** Persistence helpers for the app's paper-trade lifecycle. */

const supabaseStore = require('./supabaseStore');
const { state: intradayState } = require('../state/dailyState');
const { nowIST } = require('../config/timeUtils');

function tradeKey(mode, symbol, openedOn) {
  return `${mode}:${String(symbol).toUpperCase()}:${openedOn || nowIST().dateKey}`;
}

function saveIntradayPosition(symbolValue, position, extra = {}) {
  if (!supabaseStore.status().connected || !position) return;

  const symbol = String(symbolValue).toUpperCase();
  const openedOn = position.openedOn || nowIST().dateKey;
  const key = position.tradeKey || tradeKey('intraday', symbol, openedOn);
  position.tradeKey = key;

  const snapshot = JSON.parse(JSON.stringify(position));
  supabaseStore.enqueuePaperTrades([{
    trade_key: key,
    mode: 'intraday',
    symbol,
    status: position.closed ? 'closed' : 'open',
    opened_on: openedOn,
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
    metadata: { ...extra, position: snapshot },
    updated_at: new Date().toISOString(),
  }]);
}

/** Restore today's open positions and paper P&L after a Render restart. */
async function hydrateIntradayPositions() {
  if (!supabaseStore.status().connected) return 0;

  try {
    const today = nowIST().dateKey;
    const openRows = await supabaseStore.loadOpenPaperTrades('intraday');
    const staleRows = [];

    for (const row of openRows) {
      if (row.opened_on !== today) {
        staleRows.push({
          ...row,
          status: 'stale',
          exit_reason: row.exit_reason || 'service_restarted_after_session',
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      const position = row.metadata?.position;
      if (position && typeof position === 'object') {
        intradayState.openPositions[row.symbol] = {
          ...position,
          tradeKey: row.trade_key,
          realizedPnl: Number(row.realized_pnl) || 0,
        };
      }
    }

    if (staleRows.length) await supabaseStore.upsertPaperTrades(staleRows);

    const todaysTrades = await supabaseStore.loadPaperTradesForDay('intraday', today);
    if (todaysTrades.length) {
      intradayState.lastResetDate = today;
      intradayState.totalRealizedPnl = todaysTrades.reduce(
        (sum, row) => sum + (Number(row.realized_pnl) || 0),
        0,
      );
      intradayState.positionsOpenedCount = todaysTrades.length;
      intradayState.targetHitCount = todaysTrades.filter(
        (row) => row.metadata?.position?.partialBooked,
      ).length;
      intradayState.stopHitCount = todaysTrades.filter(
        (row) => row.exit_reason === 'stop',
      ).length;
      intradayState.trailExitCount = todaysTrades.filter(
        (row) => row.exit_reason === 'trail' || row.exit_reason === 'breakeven',
      ).length;
      intradayState.squareOffCount = todaysTrades.filter(
        (row) => row.exit_reason === 'square_off',
      ).length;
    }

    const restored = Object.keys(intradayState.openPositions).length;
    if (restored) console.log(`[paperTrades] restored ${restored} intraday position(s) from Supabase`);
    return restored;
  } catch (error) {
    console.error(`[paperTrades] intraday restore failed: ${error.message}`);
    return 0;
  }
}

module.exports = { saveIntradayPosition, hydrateIntradayPositions };
