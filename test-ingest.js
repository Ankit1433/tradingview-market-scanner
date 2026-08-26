/**
 * Verifies the split deployment: a remote API in INGEST_MODE receiving
 * signals pushed over HTTP from a scanner process.
 *
 * Boots a real API server, points a real pushClient at it, and checks the
 * signals arrive, auth is enforced, batching works, and failures degrade
 * safely rather than throwing.
 *
 * Run: node test-ingest.js
 */

process.env.SWING_DATA_DIR = '/tmp/ingest-test-data';
process.env.API_KEY = 'ingest-key-abc';
process.env.INGEST_MODE = 'true';
process.env.PUBLIC_MODE = 'true';
process.env.RATE_LIMIT_PER_MIN = '5000';

const PORT = 4611;
const BASE = `http://localhost:${PORT}`;
const KEY = 'ingest-key-abc';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass += 1; }
  else { console.log(`  ✗ ${name} ${detail}`); fail += 1; }
}

const post = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch (_) {}
  return { status: r.status, body: parsed };
};
const get = async (p, headers = {}) => {
  const r = await fetch(BASE + p, { headers });
  return { status: r.status, body: await r.json() };
};

async function run() {
  const { createServer } = require('./src/server');
  const journal = require('./src/state/signalJournal');
  const swingState = require('./src/state/swingState');

  journal.reset();
  swingState.reset();

  const server = createServer().listen(PORT);
  await new Promise((r) => setTimeout(r, 250));

  console.log('\n=== INGEST AUTH ===');
  {
    const noKey = await post('/api/ingest/signals', { symbol: 'X', mode: 'intraday', signals: ['A'] });
    check('rejects a push without a key', noKey.status === 401, `got ${noKey.status}`);

    const badKey = await post('/api/ingest/signals', { symbol: 'X', mode: 'intraday', signals: ['A'] }, { 'x-api-key': 'nope' });
    check('rejects a push with a wrong key', badKey.status === 401);

    const noKeyPos = await post('/api/ingest/positions', { positions: [] });
    check('position sync requires a key', noKeyPos.status === 401);

    const noKeyHb = await post('/api/ingest/heartbeat', {});
    check('heartbeat requires a key', noKeyHb.status === 401);
  }

  console.log('\n=== SIGNAL INGEST ===');
  {
    const single = await post('/api/ingest/signals', {
      symbol: 'reliance', mode: 'intraday',
      signals: ['PULLBACK', 'VWAP RECLAIM', 'VOLUME SPIKE'],
      price: 2456.3, confluence: true,
      levels: { entry: 2456.3, stop: 2430 },
      context: { sector: 'Energy Minerals', change: 2.4 },
    }, { 'x-api-key': KEY });
    check('accepts a single signal', single.status === 200 && single.body.accepted === 1, JSON.stringify(single.body));
    check('uppercases the symbol', single.body.symbols[0] === 'RELIANCE');

    const batch = await post('/api/ingest/signals', {
      signals: [
        { symbol: 'INFY', mode: 'swing', signals: ['BASE BREAKOUT'], price: 1584, confluence: false },
        { symbol: 'TCS', mode: 'swing', signals: ['MA STACK', 'RS LEADER'], price: 3900, confluence: true },
      ],
    }, { 'x-api-key': KEY });
    check('accepts a batch', batch.status === 200 && batch.body.accepted === 2, JSON.stringify(batch.body));

    const feed = await get('/api/public/signals/recent');
    check('pushed signals appear in the public feed', feed.body.count === 3, `got ${feed.body.count}`);
    check('newest first ordering preserved', feed.body.signals[0].symbol === 'TCS', feed.body.signals[0]?.symbol);
    check('levels survived the round trip', feed.body.signals[2].levels.entry === 2456.3);
  }

  console.log('\n=== INGEST VALIDATION ===');
  {
    const noSym = await post('/api/ingest/signals', { mode: 'intraday', signals: ['A'] }, { 'x-api-key': KEY });
    check('rejects a missing symbol', noSym.status === 400);

    const badMode = await post('/api/ingest/signals', { symbol: 'X', mode: 'daily', signals: ['A'] }, { 'x-api-key': KEY });
    check('rejects an invalid mode', badMode.status === 400, JSON.stringify(badMode.body));

    const noSignals = await post('/api/ingest/signals', { symbol: 'X', mode: 'swing', signals: [] }, { 'x-api-key': KEY });
    check('rejects an empty signals array', noSignals.status === 400);

    const badPrice = await post('/api/ingest/signals', { symbol: 'X', mode: 'swing', signals: ['A'], price: 'lots' }, { 'x-api-key': KEY });
    check('rejects a non-numeric price', badPrice.status === 400);

    const mixed = await post('/api/ingest/signals', {
      signals: [
        { symbol: 'GOOD', mode: 'swing', signals: ['MA STACK'], price: 100 },
        { symbol: 'BAD', mode: 'nonsense', signals: ['X'] },
      ],
    }, { 'x-api-key': KEY });
    check('partial batch returns 207', mixed.status === 207, `got ${mixed.status}`);
    check('accepts the valid half', mixed.body.accepted === 1);
    check('reports the rejected half', mixed.body.rejected === 1 && mixed.body.errors[0].symbol === 'BAD');

    const huge = await post('/api/ingest/signals', {
      signals: Array.from({ length: 101 }, (_, i) => ({ symbol: `S${i}`, mode: 'swing', signals: ['A'] })),
    }, { 'x-api-key': KEY });
    check('rejects an oversized batch', huge.status === 413);
  }

  console.log('\n=== POSITION SYNC ===');
  {
    const sync = await post('/api/ingest/positions', {
      positions: [
        { symbol: 'INFY', entry: 1580, stop: 1524, qty: 89, riskPerShare: 56, target: 1720, barsHeld: 3, signals: ['BASE BREAKOUT'], highest: 1610 },
      ],
      totalRealizedPnl: 12500,
      counters: { positionsOpened: 4, stopHits: 1, targetHits: 2, trailExits: 1, timeStops: 0 },
      closedTrades: [{ symbol: 'TCS', entry: 3800, exit: 3950, qty: 50, pnl: 7500, reason: 'trail', barsHeld: 8, signals: ['MA STACK'] }],
    }, { 'x-api-key': KEY });
    check('accepts a position sync', sync.status === 200 && sync.body.synced === 1, JSON.stringify(sync.body));

    const pos = await get('/api/swing/positions');
    check('synced position is visible', pos.body.open.length === 1 && pos.body.open[0].symbol === 'INFY');
    check('redaction still applies to synced data', pos.body.redacted === true && pos.body.open[0].qty === undefined);

    const priv = await get('/api/swing/positions', { 'x-api-key': KEY });
    check('full view shows synced quantity', priv.body.open[0].qty === 89);

    const trades = await get('/api/swing/trades', { 'x-api-key': KEY });
    check('synced closed trades visible', trades.body.stats.total === 1 && trades.body.stats.totalPnl === 12500, JSON.stringify(trades.body.stats));

    // A second sync must REPLACE, not merge - otherwise a closed position
    // lingers on the hosted instance after it closed on the scanner.
    const resync = await post('/api/ingest/positions', { positions: [] }, { 'x-api-key': KEY });
    check('empty sync clears positions', resync.body.synced === 0);
    const after = await get('/api/swing/positions', { 'x-api-key': KEY });
    check('replaces rather than merges', after.body.open.length === 0, JSON.stringify(after.body.open));
  }

  console.log('\n=== LIVENESS ===');
  {
    const hb = await post('/api/ingest/heartbeat', {}, { 'x-api-key': KEY });
    check('heartbeat accepted', hb.status === 200 && hb.body.ok === true);

    const st = await get('/api/ingest/status');
    check('status reports recent contact', st.body.stale === false, JSON.stringify(st.body));
    check('status counts pushed signals', st.body.totalPushed >= 4, `got ${st.body.totalPushed}`);

    const market = await get('/api/public/market/status');
    check('market status exposes scanner liveness', market.body.scanner !== undefined);
    check('reports remote scanner mode', market.body.scanner.mode === 'remote', JSON.stringify(market.body.scanner));
    check('reports scanner as reporting', market.body.scanner.reporting === true);

    const health = await get('/api/public/health');
    check('health reports ingest mode', health.body.checks.mode === 'ingest');
    check('health tracks upstream scanner', health.body.checks.upstreamScanner === 'reporting');
    check('ingest instance is not degraded by having no local loops', health.body.status === 'ok', JSON.stringify(health.body.checks));
  }

  console.log('\n=== SSE FROM PUSHED SIGNALS ===');
  {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/public/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();

    // drain the connect + replay frames
    let warm = '';
    const wd = Date.now() + 1500;
    while (Date.now() < wd) {
      const { value, done } = await reader.read();
      if (done) break;
      warm += dec.decode(value, { stream: true });
      if (warm.includes('event: connected')) break;
    }
    check('stream connected', warm.includes('event: connected'));

    await post('/api/ingest/signals', {
      symbol: 'PUSHLIVE', mode: 'intraday', signals: ['MOMENTUM'], price: 500, confluence: false,
    }, { 'x-api-key': KEY });

    let live = '';
    const ld = Date.now() + 2500;
    while (Date.now() < ld) {
      const { value, done } = await reader.read();
      if (done) break;
      live += dec.decode(value, { stream: true });
      if (live.includes('PUSHLIVE')) break;
    }
    check('pushed signal broadcasts over SSE', live.includes('PUSHLIVE'), live.slice(0, 120));
    controller.abort();
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('\n=== PUSH CLIENT (real HTTP to the API above) ===');
  {
    process.env.PUSH_URL = BASE;
    process.env.PUSH_API_KEY = KEY;
    process.env.PUSH_FLUSH_MS = '300';

    delete require.cache[require.resolve('./src/services/pushClient')];
    const pushClient = require('./src/services/pushClient');

    pushClient.start();
    check('push client enables with URL + key', pushClient.isEnabled() === true);

    const before = (await get('/api/public/stats')).body.signals.totalRecorded;

    pushClient.pushSignal({ ts: new Date().toISOString(), mode: 'intraday', symbol: 'CLIENTA', signals: ['PULLBACK'], price: 111, confluence: false });
    pushClient.pushSignal({ ts: new Date().toISOString(), mode: 'swing', symbol: 'CLIENTB', signals: ['MA STACK', '52W HIGH'], price: 222, confluence: true });
    check('queues without throwing', pushClient.getStats().queued === 2, JSON.stringify(pushClient.getStats()));

    await new Promise((r) => setTimeout(r, 900));

    const after = (await get('/api/public/stats')).body.signals.totalRecorded;
    check('queued signals reached the API', after === before + 2, `${before} -> ${after}`);
    check('client reports them sent', pushClient.getStats().sent >= 2, JSON.stringify(pushClient.getStats()));
    check('queue drained', pushClient.getStats().queued === 0);

    const feed = await get('/api/public/signals/recent?limit=5');
    const syms = feed.body.signals.map((s) => s.symbol);
    check('pushed symbols present in the feed', syms.includes('CLIENTA') && syms.includes('CLIENTB'), syms.join(','));

    await pushClient.pushPositions(
      [{ symbol: 'VIACLIENT', entry: 900, stop: 870, qty: 10, riskPerShare: 30, target: 975, barsHeld: 1, signals: ['MA PULLBACK'], highest: 910 }],
      5000, { positionsOpened: 1 }, [],
    );
    const pos = await get('/api/swing/positions', { 'x-api-key': KEY });
    check('pushPositions syncs over HTTP', pos.body.open.length === 1 && pos.body.open[0].symbol === 'VIACLIENT', JSON.stringify(pos.body.open));

    pushClient.stop();
  }

  console.log('\n=== PUSH CLIENT FAILURE HANDLING ===');
  {
    process.env.PUSH_URL = 'http://127.0.0.1:9';  // nothing listening
    process.env.PUSH_API_KEY = KEY;
    process.env.PUSH_FLUSH_MS = '200';

    delete require.cache[require.resolve('./src/services/pushClient')];
    const dead = require('./src/services/pushClient');
    dead.start();

    dead.pushSignal({ ts: new Date().toISOString(), mode: 'intraday', symbol: 'UNREACHABLE', signals: ['A'], price: 1 });
    await new Promise((r) => setTimeout(r, 700));

    const st = dead.getStats();
    check('unreachable remote does not throw', true);
    check('failures counted', st.failed > 0, JSON.stringify(st));
    check('signal re-queued rather than lost', st.queued > 0, JSON.stringify(st));
    dead.stop();

    // auth rejection must disable rather than retry forever
    process.env.PUSH_URL = BASE;
    process.env.PUSH_API_KEY = 'wrong-key';
    delete require.cache[require.resolve('./src/services/pushClient')];
    const badAuth = require('./src/services/pushClient');
    badAuth.start();
    badAuth.pushSignal({ ts: new Date().toISOString(), mode: 'swing', symbol: 'AUTHFAIL', signals: ['A'], price: 1 });
    await new Promise((r) => setTimeout(r, 700));
    check('auth failure disables the client instead of looping', badAuth.isEnabled() === false, JSON.stringify(badAuth.getStats()));
    badAuth.stop();

    // no URL configured -> inert
    delete process.env.PUSH_URL;
    delete require.cache[require.resolve('./src/services/pushClient')];
    const off = require('./src/services/pushClient');
    off.start();
    check('inert when PUSH_URL is unset', off.isEnabled() === false);
    off.pushSignal({ mode: 'swing', symbol: 'IGNORED', signals: ['A'] });
    check('pushSignal is a no-op when disabled', off.getStats().queued === 0);
  }

  journal.reset();
  swingState.reset();
  server.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
