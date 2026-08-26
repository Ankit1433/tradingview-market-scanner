/**
 * End-to-end API verification. Boots a real server on a throwaway port,
 * exercises every endpoint, and checks auth/redaction/SSE behave as intended.
 *
 * Run: node test-api.js
 */

process.env.SWING_DATA_DIR = '/tmp/api-test-data';
process.env.API_KEY = 'test-key-12345';
process.env.PUBLIC_MODE = 'true';
process.env.ENABLE_INTRADAY = 'false';
process.env.ENABLE_SWING = 'false';
process.env.RATE_LIMIT_PER_MIN = '1000';

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-key-12345';

const { createServer } = require('./src/server');
const journal = require('./src/state/signalJournal');
const swingState = require('./src/state/swingState');
const { openPosition } = require('./src/trading/swingPositionManager');

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    fail += 1;
  }
}

const get = async (p, headers = {}) => {
  const r = await fetch(BASE + p, { headers });
  let body = null;
  try {
    body = await r.json();
  } catch (_) {
    /* non-JSON */
  }
  return { status: r.status, body, headers: r.headers };
};

const post = async (p, body = {}, headers = {}) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await r.json();
  } catch (_) {
    /* ignore */
  }
  return { status: r.status, body: parsed };
};

async function run() {
  // ---- seed data ----
  journal.reset();
  swingState.reset();

  journal.record({
    mode: 'intraday',
    symbol: 'RELIANCE',
    signals: ['PULLBACK', 'VWAP RECLAIM', 'VOLUME SPIKE'],
    price: 2450,
    confluence: true,
    levels: { entry: 2450, stop: 2430 },
    context: { sector: 'Energy Minerals', change: 2.4, relVolume: 3.1 },
  });
  journal.record({
    mode: 'intraday',
    symbol: 'TATASTEEL',
    signals: ['MOMENTUM'],
    price: 145,
    confluence: false,
    context: { sector: 'Non-Energy Minerals', change: 1.8 },
  });
  journal.record({
    mode: 'swing',
    symbol: 'INFY',
    signals: ['BASE BREAKOUT', 'RS LEADER'],
    price: 1580,
    confluence: true,
    levels: { entry: 1580, stop: 1520 },
    context: { sector: 'Technology Services', atr: 28, rsi: 62 },
  });

  openPosition('INFY', 1580, 28, 1520, { dateKey: '2026-08-25', signals: ['BASE BREAKOUT'] });

  const app = createServer();
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 200));

  console.log('\n=== ROOT & DOCS ===');
  {
    const root = await get('/');
    check('GET / returns service metadata', root.status === 200 && root.body.name);
    check('advertises docs path', root.body.docs === '/api/docs');
    check('reports publicMode', root.body.publicMode === true);
    check('reports adminEnabled', root.body.adminEnabled === true);

    const specRes = await get('/api/docs.json');
    check('OpenAPI spec served', specRes.status === 200 && specRes.body.openapi === '3.0.3');
    check('spec has paths', Object.keys(specRes.body.paths).length > 10, `${Object.keys(specRes.body.paths).length} paths`);

    const html = await fetch(`${BASE}/api/docs`);
    const text = await html.text();
    check('Swagger UI page renders', html.status === 200 && text.includes('swagger-ui'));
  }

  console.log('\n=== SIGNAL JOURNAL ===');
  {
    const all = await get('/api/public/signals/recent');
    check('returns seeded signals', all.status === 200 && all.body.count === 3, JSON.stringify(all.body?.count));
    check('newest first', all.body.signals[0].symbol === 'INFY', all.body.signals[0]?.symbol);

    const intraday = await get('/api/public/signals/recent?mode=intraday');
    check('filters by mode', intraday.body.count === 2, `got ${intraday.body.count}`);

    const swing = await get('/api/public/signals/recent?mode=swing');
    check('swing filter works', swing.body.count === 1 && swing.body.signals[0].symbol === 'INFY');

    const byType = await get('/api/public/signals/recent?type=PULLBACK');
    check('filters by signal type', byType.body.count === 1 && byType.body.signals[0].symbol === 'RELIANCE');

    const bySymbol = await get('/api/public/signals/recent?symbol=tatasteel');
    check('symbol filter is case-insensitive', bySymbol.body.count === 1);

    const conf = await get('/api/public/signals/recent?confluenceOnly=true');
    check('confluenceOnly filter', conf.body.count === 2, `got ${conf.body.count}`);

    const bad = await get('/api/public/signals/recent?mode=nonsense');
    check('rejects an invalid mode', bad.status === 400);

    const badLimit = await get('/api/public/signals/recent?limit=abc');
    check('rejects a non-numeric limit', badLimit.status === 400);

    const limited = await get('/api/public/signals/recent?limit=1');
    check('honours limit', limited.body.count === 1);
  }

  console.log('\n=== STATS ===');
  {
    const s = await get('/api/public/stats');
    check('stats returns 200', s.status === 200);
    check('counts total recorded', s.body.signals.totalRecorded === 3, `got ${s.body.signals.totalRecorded}`);
    check('splits by mode', s.body.signals.byMode.intraday === 2 && s.body.signals.byMode.swing === 1);
    check('computes confluence rate', s.body.signals.confluenceRate === 66.7, `got ${s.body.signals.confluenceRate}`);
    check('aggregates by type', s.body.signals.byType.length > 0);
    check('aggregates by sector', s.body.signals.topSectors.length === 3, `got ${s.body.signals.topSectors.length}`);
    check('builds a daily histogram', Array.isArray(s.body.signals.daily) && s.body.signals.daily.length >= 1);
    check('reports uptime', typeof s.body.system.uptimeSeconds === 'number');
    check('PUBLIC_MODE hides rupee P&L', s.body.performance.swingRealizedPnl === undefined, JSON.stringify(s.body.performance));
  }

  console.log('\n=== MARKET STATUS ===');
  {
    const m = await get('/api/public/market/status');
    check('returns 200', m.status === 200);
    check('has isOpen boolean', typeof m.body.isOpen === 'boolean');
    check('has a named phase', typeof m.body.phase === 'string');
    check(
      'phase is one of the known values',
      ['weekend', 'holiday', 'pre_market', 'opening_range', 'open', 'lunch_lull', 'square_off', 'post_market'].includes(m.body.phase),
      m.body.phase,
    );
    check('publishes session times', m.body.session.open === '09:15' && m.body.session.close === '15:30');
    check('flags holiday-data staleness', typeof m.body.holidayDataStale === 'boolean');
    if (!m.body.isOpen) check('provides nextOpen when closed', m.body.nextOpen !== null, JSON.stringify(m.body.nextOpen));
  }

  console.log('\n=== HEALTH ===');
  {
    const h = await get('/api/public/health');
    check('returns a status code', h.status === 200 || h.status === 503);
    check('has a status field', ['ok', 'degraded'].includes(h.body.status));
    check('reports individual checks', h.body.checks && h.body.checks.api === 'ok');
    check('reports API key configured', h.body.checks.apiKeyConfigured === true);
    check('includes market phase', typeof h.body.marketPhase === 'string');
  }

  console.log('\n=== AUTH ===');
  {
    const noKey = await post('/api/swing/admin/scan');
    check('admin scan rejected without a key', noKey.status === 401, `got ${noKey.status}`);

    const badKey = await post('/api/swing/admin/scan', {}, { 'x-api-key': 'wrong' });
    check('admin scan rejected with a wrong key', badKey.status === 401);

    const startNoKey = await post('/api/scanner/admin/start');
    check('intraday start rejected without a key', startNoKey.status === 401);

    const stopNoKey = await post('/api/scanner/admin/stop');
    check('intraday stop rejected without a key', stopNoKey.status === 401);

    const closeNoKey = await post('/api/swing/positions/INFY/close', { exitPrice: 1600 });
    check('manual close rejected without a key', closeNoKey.status === 401);

    const withKey = await post('/api/scanner/admin/stop', {}, { 'x-api-key': KEY });
    check('valid key is accepted', withKey.status === 200, `got ${withKey.status}`);

    const bearer = await post('/api/scanner/admin/stop', {}, { authorization: `Bearer ${KEY}` });
    check('Bearer token form also works', bearer.status === 200);
  }

  console.log('\n=== REDACTION (PUBLIC_MODE) ===');
  {
    const pub = await get('/api/swing/positions');
    check('positions redacted without a key', pub.body.redacted === true);
    check('quantity hidden', pub.body.open[0].qty === undefined, JSON.stringify(pub.body.open[0]));
    check('capital deployed hidden', pub.body.capitalDeployed === undefined);
    // Stop is 1524, not the 1520 structural level passed in: the ATR stop
    // (1580 - 2*28) is tighter, so it correctly wins. Setup levels stay
    // visible under redaction - they're the interesting part for a portfolio.
    check('entry/stop still visible', pub.body.open[0].entry === 1580 && pub.body.open[0].stop === 1524, `stop=${pub.body.open[0].stop}`);

    const priv = await get('/api/swing/positions', { 'x-api-key': KEY });
    check('full data with a key', priv.body.redacted === undefined && priv.body.capitalDeployed > 0, JSON.stringify(priv.body).slice(0, 120));
    check('quantity visible with a key', priv.body.open[0].qty > 0);

    // close a trade so the journal has content, then re-check redaction
    await post('/api/swing/positions/INFY/close', { exitPrice: 1700 }, { 'x-api-key': KEY });

    const pubTrades = await get('/api/swing/trades');
    check('trades redacted without a key', pubTrades.body.redacted === true);
    check('rupee P&L hidden', pubTrades.body.stats.totalPnl === undefined);
    check('R-multiple shown instead', typeof pubTrades.body.stats.totalR === 'number', JSON.stringify(pubTrades.body.stats));
    check('per-trade pnl hidden', pubTrades.body.trades[0].pnl === undefined);
    check('per-trade R shown', typeof pubTrades.body.trades[0].rMultiple === 'number');
    check('return % shown', typeof pubTrades.body.trades[0].returnPct === 'number');

    const privTrades = await get('/api/swing/trades', { 'x-api-key': KEY });
    check('rupee P&L visible with a key', typeof privTrades.body.stats.totalPnl === 'number');
  }

  console.log('\n=== SSE STREAM ===');
  {
    const controller = new AbortController();
    const res = await fetch(`${BASE}/api/public/stream`, { signal: controller.signal });
    check('stream returns 200', res.status === 200);
    check('correct content type', res.headers.get('content-type')?.includes('text/event-stream'), res.headers.get('content-type'));
    check('buffering disabled for proxies', res.headers.get('x-accel-buffering') === 'no');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // read the connect frame + replayed history
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: signal')) break;
    }

    check('sends a connected event', buffer.includes('event: connected'), buffer.slice(0, 80));
    check('replays recent history on connect', buffer.includes('event: signal'), 'no replayed signal frame');
    check('replay frames are flagged', buffer.includes('"replay":true'));

    // live broadcast reaches the open connection
    const eventStream = require('./src/services/eventStream');
    check('stream client registered', eventStream.clientCount() === 1, `got ${eventStream.clientCount()}`);

    const delivered = eventStream.broadcast('signal', { mode: 'intraday', symbol: 'LIVETEST', price: 100 });
    check('broadcast reports delivery', delivered === 1, `delivered ${delivered}`);

    let live = '';
    const liveDeadline = Date.now() + 2000;
    while (Date.now() < liveDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      live += decoder.decode(value, { stream: true });
      if (live.includes('LIVETEST')) break;
    }
    check('live event reaches the client', live.includes('LIVETEST'), live.slice(0, 100));

    controller.abort();
    await new Promise((r) => setTimeout(r, 200));
    check('client removed on disconnect', eventStream.clientCount() === 0, `got ${eventStream.clientCount()}`);

    const badMode = await get('/api/public/stream?mode=bogus');
    check('rejects an invalid stream mode', badMode.status === 400);
  }

  console.log('\n=== RATE LIMITING ===');
  {
    const r = await get('/api/public/stats');
    check('sets X-RateLimit-Limit', r.headers.get('x-ratelimit-limit') !== null);
    check('sets X-RateLimit-Remaining', r.headers.get('x-ratelimit-remaining') !== null);
    check('sets X-RateLimit-Reset', r.headers.get('x-ratelimit-reset') !== null);
  }

  console.log('\n=== ERROR HANDLING ===');
  {
    const nf = await get('/api/nonexistent');
    check('404 on unknown route', nf.status === 404 && nf.body.error === 'Not found');
    check('404 points at the docs', nf.body.docs === '/api/docs');

    const badSignal = await get('/api/scanner/signals/notarealtype');
    check('404 on unknown signal type', badSignal.status === 404);

    const noPos = await post('/api/swing/positions/GHOSTCO/close', { exitPrice: 100 }, { 'x-api-key': KEY });
    check('404 closing a nonexistent position', noPos.status === 404);

    swingState.reset();
    openPosition('TESTX', 100, 2, 97, { dateKey: '2026-08-25', signals: ['BASE BREAKOUT'] });
    const noPrice = await post('/api/swing/positions/TESTX/close', {}, { 'x-api-key': KEY });
    check('400 closing without exitPrice', noPrice.status === 400, `got ${noPrice.status}`);
  }

  console.log('\n=== CORS ===');
  {
    const opt = await fetch(`${BASE}/api/public/stats`, { method: 'OPTIONS' });
    check('preflight returns 204', opt.status === 204);
    check('allows cross-origin', opt.headers.get('access-control-allow-origin') === '*');
    check('allows the api key header', opt.headers.get('access-control-allow-headers')?.includes('x-api-key'));
  }

  // cleanup
  journal.reset();
  swingState.reset();
  server.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  process.exit(1);
});
