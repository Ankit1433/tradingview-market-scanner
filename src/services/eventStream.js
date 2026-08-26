/**
 * Server-Sent Events broadcaster.
 *
 * SSE rather than WebSocket because the traffic here is strictly one
 * directional - the server pushes signals, the client never sends anything
 * back. SSE gets automatic browser reconnection for free, rides over plain
 * HTTP (so it survives proxies and CDNs that mangle WebSocket upgrades), and
 * needs no client library. A WebSocket here would be a heavier tool doing a
 * strictly smaller job.
 *
 * The heartbeat matters: idle proxies and load balancers close connections
 * that go quiet, and on a scanner most of the day IS quiet. A comment frame
 * every 25s keeps the connection alive without emitting a real event.
 */

const HEARTBEAT_MS = 25000;
const MAX_CLIENTS = 100;

let clients = new Set();
let nextId = 1;
let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(': heartbeat\n\n');
      } catch (_) {
        removeClient(client);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function stopHeartbeat() {
  if (heartbeat && clients.size === 0) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function removeClient(client) {
  clients.delete(client);
  stopHeartbeat();
}

/** Attach an Express response as an SSE stream. Returns the client handle. */
function addClient(req, res, { filter = null } = {}) {
  if (clients.size >= MAX_CLIENTS) {
    res.status(503).json({ error: 'Too many active stream connections.' });
    return null;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops nginx buffering the stream into uselessness
  });
  res.flushHeaders?.();

  const client = { id: nextId++, res, filter, connectedAt: Date.now() };
  clients.add(client);
  startHeartbeat();

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId: client.id, ts: new Date().toISOString() })}\n\n`);

  req.on('close', () => removeClient(client));
  req.on('error', () => removeClient(client));

  return client;
}

/**
 * Push an event to every connected client whose filter matches.
 * Never throws - a broken client connection must not propagate into the
 * scan loop that called this.
 */
function broadcast(eventName, payload) {
  if (clients.size === 0) return 0;

  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;

  for (const client of clients) {
    try {
      if (client.filter && payload.mode && client.filter !== payload.mode) continue;
      client.res.write(frame);
      delivered += 1;
    } catch (_) {
      removeClient(client);
    }
  }
  return delivered;
}

function clientCount() {
  return clients.size;
}

function closeAll() {
  for (const client of clients) {
    try {
      client.res.end();
    } catch (_) {
      /* ignore */
    }
  }
  clients = new Set();
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

module.exports = { addClient, broadcast, clientCount, closeAll };
