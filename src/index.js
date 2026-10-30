require('dotenv').config();
require('./config/validate').validate();

const { createServer } = require('./server');
const { start, stop } = require('./jobs/scanLoop');
const { start: _start, stop: _stop } = require('./jobs/swingLoop');
const { closeClient } = require('./services/tvHistory');
const signalJournal = require('./state/signalJournal');
const swingState = require('./state/swingState');
const supabaseStore = require('./services/supabaseStore');
const paperTradeStore = require('./services/paperTradeStore');
const { closeAll } = require('./services/eventStream');
const { PUBLIC_MODE, API_KEY_CONFIGURED } = require('./middleware/auth');
const { start: __start, drain } = require('./services/pushClient');

const personalLoop = require('./jobs/personalLoop');
const outcomeLoop = require('./jobs/outcomeLoop');
const outcomeStore = require('./state/outcomeStore');

const market = require('./marketData');
let marketLease, marketFeed;

const PORT = process.env.PORT || 4000;

// Both loops are opt-out rather than opt-in, but independently - running only
// the swing side (a much lighter process) is a reasonable setup if you're not
// actively day trading.
// INGEST_MODE runs this as a read-only API that receives signals over HTTP
// instead of scanning for them itself. That's the deployable half of a split
// setup: scanner at home where the data sources work, API in the cloud where
// it's reachable.
const INGEST_MODE = process.env.INGEST_MODE === 'true';
const ENABLE_INTRADAY = !INGEST_MODE && process.env.ENABLE_INTRADAY !== 'false';
const ENABLE_SWING = !INGEST_MODE && process.env.ENABLE_SWING !== 'false';

// Warm from local files first so the service can still start if Supabase is
// temporarily unreachable. When configured, hydrate the durable copy before
// starting either scanner loop.
signalJournal.load();
swingState.load();

const app = createServer();
const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`Docs at http://localhost:${PORT}/api/docs`);
  if (PUBLIC_MODE) {
    console.log(
      'PUBLIC_MODE on — rupee figures redacted to R-multiples on public reads',
    );
  }
  if (!API_KEY_CONFIGURED) {
    console.warn(
      'WARNING: API_KEY not set — admin and ingest endpoints are DISABLED (they fail closed, not open)',
    );
  }
  if (INGEST_MODE) {
    console.log(
      'INGEST_MODE — no local scanning; serving reads and accepting pushed signals',
    );
  }
});

let startupStage='storage';
async function initializeStorageAndLoops() {
  if (await supabaseStore.connect()) {
    await Promise.all([
      signalJournal.hydrateFromSupabase(),
      swingState.hydrateFromSupabase(),
    ]);
    await paperTradeStore.hydrateIntradayPositions();
  }

  startupStage='bootstrap_admin';
  await require('./services/bootstrapAdmin').onStartup();
  // Diagnostic runs independently and cannot enable scanners or block readiness.
  require('./services/upstoxStartupCheck').runCheck().catch(()=>{
    console.warn('[upstox-check] UPSTOX_CONNECTIVITY_CHECK_FAILED');
  });

  startupStage='scanner_ownership';
  if (ENABLE_INTRADAY || ENABLE_SWING) marketLease = await require('./services/scannerOwnership').ensure({onLost:()=>{process.exitCode=1;shutdown();}});
  startupStage='provider_setup';
  if (market.name === 'upstox') {
    if (!process.env.UPSTOX_ACCESS_TOKEN) throw new Error('UPSTOX_TOKEN_MISSING');
    if ((ENABLE_INTRADAY || ENABLE_SWING) && process.env.UPSTOX_SCREENING_APPROVED !== 'true') throw new Error('UPSTOX_SCREENING_PARITY_APPROVAL_AND_METADATA_REQUIRED');
    if (ENABLE_INTRADAY || ENABLE_SWING) {const universe=require('./marketData/universe');await universe.assertPrepared(market.provider(),await universe.loadManifest(market.provider(),{refresh:true}));}
    if (ENABLE_INTRADAY || ENABLE_SWING) {
      if (!supabaseStore.status().connected) throw new Error('UPSTOX_WORKERS_REQUIRE_DATABASE_LEASE');

      if (process.env.UPSTOX_STREAM_ENABLED === 'true') {
        marketFeed = new (require('./marketData/feed').Feed)({ provider: market.provider() });
        const names=(process.env.UPSTOX_STREAM_SYMBOLS || 'NIFTY').split(',').map(s=>s.trim()).filter(Boolean);
        marketFeed.subscribe(await Promise.all(names.map(async s=>(await market.provider().instrument(s)).instrument_key)));
        marketFeed.on('reconnected',()=>{ market.provider().memory.clear(); });
        marketFeed.on('data',()=>{});
        await marketFeed.start();
        market.provider().feed = marketFeed;
      }
    }
  }
  startupStage='outcome_storage';
  await outcomeStore.hydrate();
  if (!INGEST_MODE && process.env.ENABLE_OUTCOMES !== 'false' && (ENABLE_INTRADAY || ENABLE_SWING)) outcomeLoop.start();

  startupStage='scanner_start';
  if (ENABLE_INTRADAY) {
    start().catch((e) => {
      console.error('Failed to start intraday scan loop:', e);
    });
  } else {
    console.log('Intraday loop disabled (ENABLE_INTRADAY=false)');
  }

  if (ENABLE_SWING) {
    try {
      _start();
    } catch (e) {
      console.error('Failed to start swing loop:', e);
    }
  } else if (!INGEST_MODE) {
    console.log('Swing loop disabled (ENABLE_SWING=false)');
  }

  startupStage='outbox_start';
  if (!INGEST_MODE) { await require('./services/pushClient').hydrateOutbox(); __start(); }
  startupStage='telegram_worker';
  if (process.env.PRIVATE_MODE !== 'false' && process.env.ENABLE_PERSONAL_WORKER === 'true') await personalLoop.start();
}

initializeStorageAndLoops().catch((e) => {
  if(shuttingDown)return;
  require('./operations/log').log('error','startup_failed',{...require('./operations/failureDetails').details(e,startupStage),error:e});
  process.exitCode=1;shutdown();
});

let shuttingDown=false;
async function shutdown() {
  if(shuttingDown)return;shuttingDown=true;
  closeAll();
  const httpClosed=new Promise(resolve=>server.close(resolve));
  console.log('\nShutting down...');
  const deadline=setTimeout(()=>process.exit(1),10000);deadline.unref();
  marketFeed?.stop();
  stop();
  _stop();
  await personalLoop.stop();
  await require('./services/upstoxPreparation').stop();
  await outcomeLoop.stop();
  // Best-effort flush of anything still queued for the remote API.
  await drain().catch(() => {});
  await supabaseStore.flush().catch(() => {});
  closeAll();
  await closeClient();
  await marketLease?.stop();
  server.closeIdleConnections?.();
  await httpClosed;
  process.exit(process.exitCode||0);
  // force-exit if something hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
