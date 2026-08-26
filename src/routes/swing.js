const express = require("express");

const router = express.Router();
const swingState = require("../state/swingState");
const swingLoop = require("../jobs/swingLoop");
const { getSwingCandidates } = require("../services/swingScanner");
const {
  evaluateSwingSignals,
  getIndexReturn,
} = require("../indicators/swingSignals");
const {
  totalCapitalDeployed,
  openPositionCount,
} = require("../trading/swingPositionManager");
const S = require("../config/swingConstants");
const {
  requireKey,
  requirePrivate,
  PUBLIC_MODE,
} = require("../middleware/auth");
const { getMarketStatus } = require("../services/marketStatus");

router.get("/health", (req, res) => {
  const state = swingState.getState();
  res.json({
    ok: true,
    running: swingLoop.isRunning(),
    lastScanDate: state.lastScanDate,
    openPositions: openPositionCount(),
    scheduledAt: `${String(S.SWING_SCAN_TIME.h).padStart(2, "0")}:${String(S.SWING_SCAN_TIME.m).padStart(2, "0")} IST`,
  });
});

router.get("/positions", requirePrivate, (req, res) => {
  const open = swingState.openPositionsList();

  // In PUBLIC_MODE without a key, strip quantities and capital figures. The
  // setup itself (symbol, entry, stop, target, R) is the interesting part for
  // a portfolio; the position size is nobody's business.
  if (res.locals.redactMoney) {
    return res.json({
      open: open.map((p) => ({
        symbol: p.symbol,
        entry: p.entry,
        stop: p.stop,
        target: p.target,
        stopBasis: p.stopBasis,
        partialBooked: p.partialBooked,
        barsHeld: p.barsHeld,
        signals: p.signals,
        openRMultiple:
          p.riskPerShare > 0
            ? Number(((p.highest - p.entry) / p.riskPerShare).toFixed(2))
            : null,
      })),
      count: open.length,
      maxPositions: S.SWING_MAX_OPEN_POSITIONS,
      redacted: true,
    });
  }

  res.json({
    open,
    capitalDeployed: totalCapitalDeployed(),
    capitalTotal: S.SWING_TOTAL_CAPITAL,
    maxPositions: S.SWING_MAX_OPEN_POSITIONS,
  });
});

router.get("/trades", requirePrivate, (req, res) => {
  const state = swingState.getState();
  const trades = state.closedTrades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  // R-multiple view: real performance, no account size disclosed.
  if (res.locals.redactMoney) {
    const risk = S.SWING_RISK_CAPITAL;
    const toR = (pnl) => (risk > 0 ? Number((pnl / risk).toFixed(2)) : null);
    const totalR = trades.reduce((sum, t) => sum + (toR(t.pnl) || 0), 0);

    return res.json({
      trades: trades.map((t) => ({
        symbol: t.symbol,
        reason: t.reason,
        barsHeld: t.barsHeld,
        signals: t.signals,
        openedOn: t.openedOn,
        rMultiple: toR(t.pnl),
        returnPct:
          t.entry > 0
            ? Number((((t.exit - t.entry) / t.entry) * 100).toFixed(2))
            : null,
      })),
      stats: {
        total: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length
          ? Number(((wins.length / trades.length) * 100).toFixed(1))
          : null,
        totalR: Number(totalR.toFixed(2)),
        avgR: trades.length
          ? Number((totalR / trades.length).toFixed(2))
          : null,
        expectancyR: trades.length
          ? Number((totalR / trades.length).toFixed(2))
          : null,
      },
      counters: state.counters,
      redacted: true,
    });
  }

  res.json({
    trades,
    stats: {
      total: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length
        ? Number(((wins.length / trades.length) * 100).toFixed(1))
        : null,
      totalPnl: state.totalRealizedPnl,
      avgWin: wins.length
        ? Number((wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0))
        : null,
      avgLoss: losses.length
        ? Number(
            (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0),
          )
        : null,
    },
    counters: state.counters,
  });
});

/** The raw screener universe, before per-symbol daily-candle analysis. */
router.get("/candidates", async (req, res) => {
  try {
    const universe = await getSwingCandidates();
    res.json({ count: Object.keys(universe).length, candidates: universe });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** Evaluate a single symbol on demand — useful for checking a name you're already watching. */
router.get("/analyze/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const indexReturn = await getIndexReturn();
    const result = await evaluateSwingSignals(symbol, indexReturn, {
      dropPartialBar: getMarketStatus().isOpen,
    });
    if (!result) {
      return res.json({
        symbol,
        signals: [],
        message: "No signals fired, or insufficient daily data.",
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Force a scan now, ignoring the schedule and the already-ran-today guard. */
router.post("/admin/scan", requireKey, async (req, res) => {
  const result = await swingLoop.runSwingScan({ force: true });
  res.json({ ran: result !== null, result });
});

router.post("/admin/start", requireKey, (req, res) => {
  swingLoop.start();
  res.json({ started: true });
});

router.post("/admin/stop", requireKey, (req, res) => {
  swingLoop.stop();
  res.json({ stopped: true });
});

/**
 * Manually close a tracked position — for when you exit in your broker for a
 * reason the scanner doesn't know about (news, a better opportunity, needing
 * the capital). Without this the scanner keeps managing a position you no
 * longer hold.
 */
router.post("/positions/:symbol/close", requireKey, (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const state = swingState.getState();
  const pos = state.openPositions[symbol];

  if (!pos || pos.closed) {
    return res
      .status(404)
      .json({ error: `No open swing position for ${symbol}` });
  }

  const exitPrice = Number(req.body?.exitPrice);
  if (!exitPrice || Number.isNaN(exitPrice)) {
    return res
      .status(400)
      .json({ error: "Provide a numeric exitPrice in the request body." });
  }

  const qty = pos.partialBooked ? pos.runnerQty : pos.qty;
  const pnl = qty * (exitPrice - pos.entry);
  state.totalRealizedPnl += pnl;
  pos.closed = true;
  state.closedTrades.push({
    symbol,
    entry: pos.entry,
    exit: exitPrice,
    qty,
    pnl,
    reason: "manual",
    openedOn: pos.openedOn,
    barsHeld: pos.barsHeld,
    signals: pos.signals,
  });
  swingState.save();

  res.json({ closed: symbol, qty, exitPrice, pnl });
});

module.exports = router;
