/**
 * Pushes the live universe and signals from a local scanner to a remote API.
 *
 * Enabled by setting PUSH_URL. When unset this is inert, so the same code
 * runs unchanged in single-process mode.
 *
 * Design constraints worth being explicit about:
 *
 *   - Pushing must NEVER be able to break scanning. Every failure path here
 *     logs and returns; nothing propagates to the caller. A dropped signal on
 *     the portfolio site is a cosmetic problem, a crashed scanner during
 *     market hours is not.
 *   - Signals are queued and flushed on an interval rather than sent one at a
 *     time. A scan cycle can produce a dozen signals within a second, and a
 *     round-trip per signal from a home connection adds latency to the loop
 *     that actually matters.
 *   - The queue is bounded. If the remote is down for an hour, this drops the
 *     oldest entries rather than growing until the process runs out of memory.
 *     The local journal still has everything; the push is a convenience.
 */

const PUSH_URL = process.env.PUSH_URL || null;
const PUSH_KEY = process.env.PUSH_API_KEY || process.env.API_KEY || null;
const FLUSH_INTERVAL_MS = Number(process.env.PUSH_FLUSH_MS || 5000);
const { createHeartbeat, intervalMs: HEARTBEAT_INTERVAL_MS } = require('../config/keepalive');
const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10000;

const outbox = require('./pushOutbox');
let queue = PUSH_URL ? outbox.load() : [];
let inFlightBatch = [];
let flushBusy = false;
const persist = () => outbox.save(inFlightBatch.concat(queue));
let flushTimer = null;
let heartbeatTimer = null;
let consecutiveFailures = 0;
let enabled = false;
let pendingUniverse = null;
let universePushInFlight = false;

const stats = { sent: 0, failed: 0, dropped: 0 };

function isEnabled() {
  return enabled;
}

async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PUSH_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': PUSH_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Queue a signal for the next flush. Safe to call from anywhere. */
function pushSignal(record) {
  if (!enabled) return;

  if (inFlightBatch.concat(queue).some(row => outbox.identity(row) === outbox.identity(record))) return;

  queue.push(record);
  persist();
}

async function flush() {
  if (!enabled || queue.length === 0 || flushBusy) return;
  flushBusy = true;

  const batch = queue.splice(0, BATCH_SIZE);
  inFlightBatch = batch;

  try {
    const res = await request('/api/ingest/signals', { signals: batch });

    if (res.ok || res.status === 207) {
      stats.sent += batch.length;
      if (consecutiveFailures > 0) {
        console.log(`[push] remote reachable again after ${consecutiveFailures} failure(s)`);
        consecutiveFailures = 0;
      }
      return;
    }

    if (res.status === 401 || res.status === 503) {
      // An auth problem won't fix itself by retrying, and re-queueing would
      // spin forever. Disable and say so loudly.
      console.error(`[push] auth rejected (${res.status}) — disabling push. Check PUSH_API_KEY matches the remote API_KEY.`);
      enabled = false;
      queue = outbox.merge(batch.concat(queue));
      stop();
      return;
    }

    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    stats.failed += batch.length;
    consecutiveFailures += 1;

    // Put the batch back at the front so ordering survives a transient outage.
    queue = outbox.merge(batch.concat(queue));

    if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
      console.warn(`[push] flush failed (${consecutiveFailures} consecutive)`);
    }
  } finally {
    inFlightBatch = [];
    flushBusy = false;
    persist();
  }
}

/** Forward the latest live universe without delaying the scan cycle. */
async function flushUniverse() {
  if (!enabled || universePushInFlight || !pendingUniverse) return;

  const snapshot = pendingUniverse;
  pendingUniverse = null;
  universePushInFlight = true;

  try {
    const res = await request('/api/ingest/universe', snapshot);
    if (res.status === 401 || res.status === 503) {
      console.error(`[push] universe auth rejected (${res.status}) — disabling push. Check PUSH_API_KEY matches the remote API_KEY.`);
      enabled = false;
      pendingUniverse = null;
      stop();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    // The next successful scan will send a fresh snapshot.
    console.warn(`[push] universe sync failed: ${e.message}`);
  } finally {
    universePushInFlight = false;
    if (pendingUniverse) flushUniverse();
  }
}

function pushUniverse(stocks, lastScanAt) {
  if (!enabled) return;
  // Coalesce scans if a slow request is still in flight; only the newest
  // universe matters to the live workspace.
  pendingUniverse = { stocks, lastScanAt };
  flushUniverse();
}

/** Mirror current swing positions to the remote. Called after each swing scan. */
async function pushPositions(positions, totalRealizedPnl, counters, closedTrades) {
  if (!enabled) return;
  try {
    const res = await request('/api/ingest/positions', {
      positions,
      totalRealizedPnl,
      counters,
      closedTrades: (closedTrades || []).slice(-200),
    });
    if (!res.ok) console.warn(`[push] position sync returned ${res.status}`);
  } catch (e) {
    console.warn(`[push] position sync failed: ${e.message}`);
  }
}

const heartbeat = createHeartbeat({
  enabled: () => enabled,
  send: () => request('/api/ingest/heartbeat', {}),
});

function start() {
  if (!PUSH_URL) return;

  if (!PUSH_KEY) {
    console.error('[push] PUSH_URL is set but PUSH_API_KEY is not — push disabled.');
    return;
  }
  if (typeof fetch !== 'function') {
    console.error('[push] global fetch unavailable — Node 18+ required. Push disabled.');
    return;
  }

  enabled = true;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  // Check locally each second; only eligible, interval-spaced checks make HTTP requests.
  heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}); }, Math.min(1000, HEARTBEAT_INTERVAL_MS));
  flushTimer.unref?.();
  heartbeatTimer.unref?.();

  console.log(`[push] enabled — forwarding signals to ${PUSH_URL}`);
  heartbeat().catch(() => {});
}

function stop() {
  if (flushTimer) clearInterval(flushTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  flushTimer = null;
  heartbeatTimer = null;
}

/** Best-effort final flush on shutdown, so a clean restart doesn't lose the queue. */
async function drain() {
  if (!enabled) return;
  stop();
  const rounds = Math.ceil(queue.length / BATCH_SIZE);
  for (let i = 0; i < rounds && queue.length > 0; i++) {
    await flush();
  }
}

function getStats() {
  return { ...stats, queued: queue.length, enabled, consecutiveFailures };
}

async function pushOutcomes(outcomes) {
 if(!PUSH_URL || !PUSH_KEY)return false;
 try {const res=await request('/api/ingest/outcomes',{outcomes});return res.ok;}catch(_){return false;}
}
async function hydrateOutbox() { queue = await outbox.hydrate(queue); if (queue.length) persist(); }
module.exports = { hydrateOutbox, pushOutcomes, start, stop, drain, pushSignal, pushPositions, pushUniverse, isEnabled, getStats };
