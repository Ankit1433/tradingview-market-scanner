/**
 * Public read API — the endpoints a portfolio front-end actually calls.
 *
 * Everything here is designed to return meaningful content when the market is
 * closed, which is most of the time. The live-state endpoints under
 * /api/scanner and /api/swing are empty outside session hours by nature;
 * these are backed by the persisted journal instead.
 */

const express = require('express');

const router = express.Router();
const journal = require('../state/signalJournal');
const eventStream = require('../services/eventStream');
const { getMarketStatus } = require('../services/marketStatus');
const { state: intradayState } = require('../state/dailyState');
const swingState = require('../state/swingState');
const scanLoop = require('../jobs/scanLoop');
const swingLoop = require('../jobs/swingLoop');
const { PUBLIC_MODE, API_KEY_CONFIGURED } = require('../middleware/auth');
const { ingestState } = require('./ingest');
const S = require('../config/swingConstants');
const pkg = require('../../package.json');

const BOOT_TIME = Date.now();

/**
 * Recent signals, newest first. This is the primary feed a portfolio site
 * renders — it has content regardless of whether the market is open.
 *
 * Query: ?limit=50&mode=intraday|swing&type=PULLBACK&symbol=RELIANCE&confluenceOnly=true
 */
router.get('/signals/recent', (req, res) => {
  const { limit, mode, type, symbol, confluenceOnly } = req.query;

  if (mode && !['intraday', 'swing'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'intraday' or 'swing'" });
  }

  const parsedLimit = limit ? parseInt(limit, 10) : 50;
  if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }

  const signals = journal.query({
    limit: parsedLimit,
    mode: mode || null,
    type: type || null,
    symbol: symbol || null,
    confluenceOnly: confluenceOnly === 'true',
  });

  res.json({ count: signals.length, filters: { mode, type, symbol, confluenceOnly }, signals });
});

/**
 * Aggregate stats. Never empty once the scanner has run at all — this is the
 * landing-page data.
 */
router.get('/stats', (req, res) => {
  const journalStats = journal.stats();
  const swing = swingState.getState();
  const trades = swing.closedTrades || [];
  const wins = trades.filter((t) => t.pnl > 0);

  const uptimeMs = Date.now() - BOOT_TIME;

  const performance = {
    swingTradesClosed: trades.length,
    swingWins: wins.length,
    swingWinRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : null,
  };

  // In PUBLIC_MODE, express performance in R-multiples rather than rupees, so
  // the site can show real results without publishing account size.
  if (!PUBLIC_MODE) {
    performance.swingRealizedPnl = swing.totalRealizedPnl;
  } else if (trades.length) {
    const totalR = trades.reduce((sum, t) => {
      const risk = S.SWING_RISK_CAPITAL;
      return sum + (risk > 0 ? t.pnl / risk : 0);
    }, 0);
    performance.swingTotalR = Number(totalR.toFixed(2));
    performance.swingAvgR = Number((totalR / trades.length).toFixed(2));
  }

  res.json({
    signals: journalStats,
    performance,
    counters: swing.counters,
    system: {
      version: pkg.version,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      intradayLoopRunning: scanLoop.isRunning(),
      swingLoopRunning: swingLoop.isRunning(),
      streamClients: eventStream.clientCount(),
      publicMode: PUBLIC_MODE,
    },
  });
});

/** Market session state — lets a UI distinguish "closed" from "broken". */
router.get('/market/status', (req, res) => {
  const status = getMarketStatus();
  const INGEST_MODE = process.env.INGEST_MODE === 'true';

  // A scanner that died at 10am produces exactly the same empty feed as a
  // quiet market. Surfacing this lets the UI say which one it is.
  if (INGEST_MODE) {
    const last = ingestState.lastHeartbeatAt || ingestState.lastPushAt;
    const ageMs = last ? Date.now() - new Date(last).getTime() : null;
    status.scanner = {
      mode: 'remote',
      reporting: ageMs !== null && ageMs <= 10 * 60 * 1000,
      lastContact: last,
      secondsSinceContact: ageMs === null ? null : Math.floor(ageMs / 1000),
    };
  } else {
    status.scanner = {
      mode: 'local',
      reporting: scanLoop.isRunning() || swingLoop.isRunning(),
      lastContact: null,
    };
  }

  res.json(status);
});

/**
 * Aggregate health, shaped as a readiness probe. Returns 200 when healthy,
 * 503 when a dependency is degraded, so a container orchestrator or uptime
 * monitor can act on the status code alone.
 */
router.get('/health', (req, res) => {
  const market = getMarketStatus();
  const checks = {
    api: 'ok',
    intradayLoop: scanLoop.isRunning() ? 'running' : 'stopped',
    swingLoop: swingLoop.isRunning() ? 'running' : 'stopped',
    journal: 'ok',
    apiKeyConfigured: API_KEY_CONFIGURED,
  };

  let journalOk = true;
  try {
    journal.stats();
  } catch (_) {
    journalOk = false;
    checks.journal = 'error';
  }

  // Both loops being stopped while the market is open is a real problem.
  // Both stopped while it's closed is normal and shouldn't page anyone.
  const INGEST_MODE = process.env.INGEST_MODE === 'true';

  // In ingest mode there are no local loops by design - liveness is instead
  // "has the remote scanner reported recently". Without this distinction a
  // healthy ingest instance would always report itself degraded.
  let feedStale = false;
  if (INGEST_MODE) {
    const last = ingestState.lastHeartbeatAt || ingestState.lastPushAt;
    const ageMs = last ? Date.now() - new Date(last).getTime() : null;
    feedStale = ageMs === null || ageMs > 10 * 60 * 1000;
    checks.mode = 'ingest';
    checks.upstreamScanner = feedStale ? 'stale' : 'reporting';
    checks.lastContact = last;
  }

  const loopsDown = !scanLoop.isRunning() && !swingLoop.isRunning();
  const degraded = !journalOk
    || (INGEST_MODE ? (market.isOpen && feedStale) : (market.isOpen && loopsDown));

  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    version: pkg.version,
    uptimeSeconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
    marketOpen: market.isOpen,
    marketPhase: market.phase,
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Live signal stream (SSE). Push, not poll — a portfolio site can show
 * signals appearing in real time during market hours.
 *
 * Usage: const es = new EventSource('/api/public/stream?mode=intraday');
 * Events: connected | signal | position | scan_status | heartbeat comments
 */
router.get('/stream', (req, res) => {
  const { mode } = req.query;
  if (mode && !['intraday', 'swing'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'intraday' or 'swing'" });
  }

  const client = eventStream.addClient(req, res, { filter: mode || null });
  if (!client) return; // addClient already sent a 503

  // Seed the stream with recent history so a fresh connection isn't blank
  // until the next signal fires — which, outside market hours, could be days.
  const seed = journal.query({ limit: 10, mode: mode || null });
  for (const sig of seed.reverse()) {
    res.write(`event: signal\ndata: ${JSON.stringify({ ...sig, replay: true })}\n\n`);
  }
});

/** Current live universe, trimmed. Empty outside market hours by nature. */
router.get('/live/stocks', (req, res) => {
  const stocks = Object.entries(intradayState.current).map(([symbol, info]) => ({
    symbol,
    price: info.price,
    change: info.change,
    relVolume: info.relVolume,
    sector: info.sector,
  }));

  res.json({
    count: stocks.length,
    marketOpen: getMarketStatus().isOpen,
    stocks: stocks.sort((a, b) => (b.relVolume || 0) - (a.relVolume || 0)),
  });
});

module.exports = router;
