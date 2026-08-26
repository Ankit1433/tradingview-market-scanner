/**
 * Ingest endpoint — lets a scanner running somewhere else push signals into
 * this API.
 *
 * Why this exists: the market data sources are undocumented internal
 * TradingView endpoints, reached with a browser-shaped user-agent. That
 * traffic pattern from a datacenter IP is exactly what gets filtered, so a
 * cloud-hosted scanner tends to get 403s or empty responses while the same
 * code works fine from a residential connection.
 *
 * So the deployable shape is: scanner runs where the data works (a home
 * machine), this API runs where it's reachable (a cloud host), and signals
 * travel between them over an authenticated POST. The API becomes a
 * read-serving process with no outbound market-data dependency at all,
 * which also means it doesn't need a persistent scan loop or an egress
 * allowance.
 *
 * The same server code runs in both modes. INGEST_MODE only changes whether
 * the local scan loops start.
 */

const express = require('express');

const router = express.Router();
const journal = require('../state/signalJournal');
const eventStream = require('../services/eventStream');
const swingState = require('../state/swingState');
const { requireKey } = require('../middleware/auth');

// Tracks the last successful push, so /health and the demo page can tell the
// difference between "no signals fired" and "the scanner stopped reporting".
const ingestState = {
  lastPushAt: null,
  lastPushFrom: null,
  totalPushed: 0,
  lastHeartbeatAt: null,
};

const VALID_MODES = ['intraday', 'swing'];

function validateSignal(s) {
  if (!s || typeof s !== 'object') return 'signal must be an object';
  if (!s.symbol || typeof s.symbol !== 'string') return 'symbol is required';
  if (s.symbol.length > 32) return 'symbol too long';
  if (!VALID_MODES.includes(s.mode)) return `mode must be one of: ${VALID_MODES.join(', ')}`;
  if (!Array.isArray(s.signals) || s.signals.length === 0) return 'signals must be a non-empty array';
  if (s.signals.length > 20) return 'too many signal labels';
  if (s.signals.some((l) => typeof l !== 'string' || l.length > 64)) return 'signal labels must be short strings';
  if (s.price !== undefined && s.price !== null && typeof s.price !== 'number') return 'price must be a number';
  return null;
}

/**
 * Accept one or many signals. Batching matters because a single scan cycle
 * can produce a dozen signals at once, and a round-trip per signal from a
 * home connection to a cloud host adds up.
 */
router.post('/signals', requireKey, (req, res) => {
  const body = req.body || {};

  // Disambiguation matters here: a single signal carries `signals` as an array
  // of LABEL STRINGS, while a batch carries `signals` as an array of signal
  // OBJECTS. Checking Array.isArray(body.signals) first would parse a single
  // signal's labels as if each label were a whole signal. Presence of a
  // top-level `symbol` is what identifies the single-signal form.
  let incoming;
  if (typeof body.symbol === 'string') {
    incoming = [body];
  } else if (Array.isArray(body.signals)) {
    incoming = body.signals;
  } else {
    return res.status(400).json({
      error: 'Send either a single signal (with a top-level "symbol") or { signals: [ ...signal objects ] }.',
    });
  }

  if (incoming.length === 0) {
    return res.status(400).json({ error: 'No signals supplied.' });
  }
  if (incoming.length > 100) {
    return res.status(413).json({ error: 'Batch too large — send at most 100 signals per request.' });
  }

  const accepted = [];
  const rejected = [];

  for (let i = 0; i < incoming.length; i++) {
    const sig = incoming[i];
    const problem = validateSignal(sig);
    if (problem) {
      rejected.push({ index: i, symbol: sig?.symbol ?? null, reason: problem });
      continue;
    }

    try {
      const stored = journal.record({
        mode: sig.mode,
        symbol: sig.symbol.toUpperCase(),
        signals: sig.signals,
        price: sig.price ?? null,
        confluence: Boolean(sig.confluence),
        levels: sig.levels || null,
        context: sig.context || null,
      });
      eventStream.broadcast('signal', stored);
      accepted.push(stored.symbol);
    } catch (e) {
      rejected.push({ index: i, symbol: sig.symbol, reason: e.message });
    }
  }

  ingestState.lastPushAt = new Date().toISOString();
  ingestState.lastPushFrom = req.ip;
  ingestState.totalPushed += accepted.length;

  // 207 when the batch was partially accepted — the pusher needs to know some
  // records didn't land, without losing the ones that did.
  const status = rejected.length === 0 ? 200 : accepted.length > 0 ? 207 : 400;
  res.status(status).json({ accepted: accepted.length, rejected: rejected.length, symbols: accepted, errors: rejected });
});

/**
 * Mirror position state from the remote scanner. Replaces wholesale rather
 * than merging: the scanner is the single source of truth for what's open,
 * and a merge would leave a position visible here after it closed there.
 */
router.post('/positions', requireKey, (req, res) => {
  const { positions, totalRealizedPnl, counters, closedTrades } = req.body || {};

  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: 'positions must be an array' });
  }
  if (positions.length > 100) {
    return res.status(413).json({ error: 'Too many positions in one push.' });
  }

  try {
    const state = swingState.getState();
    const next = {};

    for (const p of positions) {
      if (!p || typeof p.symbol !== 'string') continue;
      next[p.symbol.toUpperCase()] = {
        entry: Number(p.entry) || 0,
        stop: Number(p.stop) || 0,
        initialStop: Number(p.initialStop) || Number(p.stop) || 0,
        stopBasis: p.stopBasis || null,
        atrAtEntry: Number(p.atrAtEntry) || 0,
        qty: Number(p.qty) || 0,
        riskPerShare: Number(p.riskPerShare) || 0,
        target: Number(p.target) || 0,
        partialBooked: Boolean(p.partialBooked),
        runnerQty: Number(p.runnerQty) || 0,
        highest: Number(p.highest) || Number(p.entry) || 0,
        barsHeld: Number(p.barsHeld) || 0,
        openedOn: p.openedOn || null,
        signals: Array.isArray(p.signals) ? p.signals : [],
        closed: Boolean(p.closed),
      };
    }

    state.openPositions = next;
    if (typeof totalRealizedPnl === 'number') state.totalRealizedPnl = totalRealizedPnl;
    if (counters && typeof counters === 'object') state.counters = { ...state.counters, ...counters };
    if (Array.isArray(closedTrades)) state.closedTrades = closedTrades.slice(-500);

    swingState.save();

    ingestState.lastPushAt = new Date().toISOString();
    ingestState.lastPushFrom = req.ip;

    eventStream.broadcast('position', { mode: 'swing', synced: true, count: Object.keys(next).length });

    res.json({ synced: Object.keys(next).length });
  } catch (e) {
    console.error('[ingest] position sync failed:', e.message);
    res.status(500).json({ error: 'Failed to sync positions.' });
  }
});

/**
 * Liveness ping from the scanner. Without this, a scanner that dies at 10am
 * is indistinguishable from a quiet market — both produce zero signals.
 */
router.post('/heartbeat', requireKey, (req, res) => {
  ingestState.lastHeartbeatAt = new Date().toISOString();
  ingestState.lastPushFrom = req.ip;
  res.json({ ok: true, at: ingestState.lastHeartbeatAt });
});

router.get('/status', (req, res) => {
  const last = ingestState.lastHeartbeatAt || ingestState.lastPushAt;
  const ageMs = last ? Date.now() - new Date(last).getTime() : null;

  res.json({
    lastPushAt: ingestState.lastPushAt,
    lastHeartbeatAt: ingestState.lastHeartbeatAt,
    totalPushed: ingestState.totalPushed,
    secondsSinceContact: ageMs === null ? null : Math.floor(ageMs / 1000),
    // 10 minutes of silence during a session means something is wrong.
    stale: ageMs === null ? true : ageMs > 10 * 60 * 1000,
  });
});

module.exports = { router, ingestState };
