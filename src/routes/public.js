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
const { getHist, INTERVAL } = require('../services/tvHistory');
const supabaseStore = require('../services/supabaseStore');

const BOOT_TIME = Date.now();
const candleCache = new Map();
const candleRequests = new Map();
const MAX_CANDLE_REQUESTS = 4;
const MAX_CANDLE_CACHE = 250;

function trimCandleCache() {
  while (candleCache.size > MAX_CANDLE_CACHE) {
    candleCache.delete(candleCache.keys().next().value);
  }
}

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
router.get('/outcomes/stats', (req,res)=>res.json(require('../evidence/outcomes').aggregate(require('../state/outcomeStore').all())));
router.get('/outcomes/:eventKey', (req,res)=>{
 const outcome=require('../state/outcomeStore').get(req.params.eventKey);
 return outcome?res.json(outcome):res.status(404).json({error:'No evaluated eligible signal with this event key'});
});
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
  status.marketData = require('../marketData').status();
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
      intradayReporting: scanLoop.isRunning(),
      swingReporting: swingLoop.isRunning(),
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

  const persistence = supabaseStore.status();
  if (persistence.incomplete) checks.database = 'supabase-config-incomplete';
  else if (!persistence.configured) checks.database = 'local-files';
  else if (!persistence.connected) checks.database = 'supabase-unavailable';
  else checks.database = persistence.healthy ? 'supabase' : 'supabase-warning';

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

/** Short-lived, bounded candle reads used by the scanner workspace chart. */
router.get('/candles/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!/^[A-Z0-9.&_-]{1,24}$/.test(symbol)) {
    return res.status(400).json({ error: 'symbol contains unsupported characters.' });
  }

  const requestedInterval = req.query.interval || '5m';
  const interval = requestedInterval === '1d' ? '1d' : requestedInterval === '5m' ? '5m' : null;
  if (!interval) return res.status(400).json({ error: "interval must be '5m' or '1d'." });

  const maxBars = interval === '1d' ? 250 : 100;
  const requestedBars = req.query.limit === undefined ? (interval === '1d' ? 120 : 60) : Number(req.query.limit);
  if (!Number.isInteger(requestedBars) || requestedBars < 20 || requestedBars > maxBars) {
    return res.status(400).json({ error: `limit must be an integer from 20 to ${maxBars}.` });
  }

  const cacheKey = `${symbol}:${interval}:${requestedBars}`;
  const cacheTtl = interval === '1d' ? 5 * 60 * 1000 : 15 * 1000;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < cacheTtl) {
    return res.json({ symbol, interval, count: cached.candles.length, candles: cached.candles, cached: true });
  }

  let pending = candleRequests.get(cacheKey);
  if (!pending) {
    if (candleRequests.size >= MAX_CANDLE_REQUESTS) {
      return res.status(503).json({ error: 'Candle service is busy. Try again shortly.' });
    }
    pending = getHist(
      symbol,
      'NSE',
      interval === '1d' ? INTERVAL.IN_DAILY : INTERVAL.IN_5_MINUTE,
      requestedBars,
    ).then((candles) => {
      if (!Array.isArray(candles) || candles.length === 0) return null;
      const clean = candles.filter((candle) =>
        ['time', 'open', 'high', 'low', 'close'].every((key) =>
          candle[key] !== null && candle[key] !== undefined && Number.isFinite(Number(candle[key])),
        ),
      );
      if (!clean.length) return null;
      candleCache.set(cacheKey, { storedAt: Date.now(), candles: clean });
      trimCandleCache();
      return clean;
    }).finally(() => candleRequests.delete(cacheKey));
    candleRequests.set(cacheKey, pending);
  }

  const candles = await pending;
  if (!candles) return res.status(502).json({ error: `No ${interval} candles are available for ${symbol}.` });
  return res.json({ symbol, interval, count: candles.length, candles, cached: false });
});

/** Current live universe, trimmed. Empty outside market hours by nature. */
router.get('/live/stocks', (req, res) => {
  const market = getMarketStatus();
  const ingestMode = process.env.INGEST_MODE === 'true';
  const remoteUniverse = ingestMode ? ingestState.latestUniverse : null;
  const lastScanAt = ingestMode ? remoteUniverse?.lastScanAt || null : intradayState.lastScanAt;
  const current = ingestMode ? remoteUniverse?.stocks || {} : intradayState.current;
  const currentSession = market.isOpen
    && lastScanAt
    && lastScanAt.startsWith(market.nowIST.slice(0, 10));
  const signalsBySymbol = new Map();
  for (const signal of journal.query({ limit: 500, mode: 'intraday' })) {
    // The workspace shows today's setup alongside the live quote. Older
    // journal entries remain available in /signals/recent, but shouldn't be
    // mistaken for a current-session signal.
    if (!signal.ts.startsWith(market.nowIST.slice(0, 10))) continue;
    if (!signalsBySymbol.has(signal.symbol)) signalsBySymbol.set(signal.symbol, signal);
  }

  const stocks = Object.entries(currentSession ? current : {}).map(([symbol, info]) => ({
    symbol,
    price: info.price,
    change: info.change,
    relVolume: info.relVolume,
    sector: info.sector,
    lastSignal: signalsBySymbol.get(symbol) || null,
  }));

  res.json({
    count: stocks.length,
    marketOpen: market.isOpen,
    lastUpdated: lastScanAt,
    stocks: stocks.sort((a, b) => (b.relVolume || 0) - (a.relVolume || 0)),
  });
});

module.exports = router;
