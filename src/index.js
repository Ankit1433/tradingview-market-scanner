require('dotenv').config();

const { createServer } = require('./server');
const scanLoop = require('./jobs/scanLoop');
const swingLoop = require('./jobs/swingLoop');
const { closeClient } = require('./services/tvHistory');
const journal = require('./state/signalJournal');
const eventStream = require('./services/eventStream');
const { PUBLIC_MODE, API_KEY_CONFIGURED } = require('./middleware/auth');
const pushClient = require('./services/pushClient');

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

// Load the persisted signal journal before serving anything - the public
// endpoints read from it, and an unloaded journal would report zero history.
journal.load();

const app = createServer();
const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`Docs at http://localhost:${PORT}/api/docs`);
  if (PUBLIC_MODE) {
    console.log('PUBLIC_MODE on — rupee figures redacted to R-multiples on public reads');
  }
  if (!API_KEY_CONFIGURED) {
    console.warn('WARNING: API_KEY not set — admin and ingest endpoints are DISABLED (they fail closed, not open)');
  }
  if (INGEST_MODE) {
    console.log('INGEST_MODE — no local scanning; serving reads and accepting pushed signals');
  }
});

if (ENABLE_INTRADAY) {
  scanLoop.start().catch((e) => {
    console.error('Failed to start intraday scan loop:', e);
  });
} else {
  console.log('Intraday loop disabled (ENABLE_INTRADAY=false)');
}

if (ENABLE_SWING) {
  try {
    swingLoop.start();
  } catch (e) {
    console.error('Failed to start swing loop:', e);
  }
} else if (!INGEST_MODE) {
  console.log('Swing loop disabled (ENABLE_SWING=false)');
}

if (!INGEST_MODE) {
  pushClient.start();
}

async function shutdown() {
  console.log('\nShutting down...');
  scanLoop.stop();
  swingLoop.stop();
  // Best-effort flush of anything still queued for the remote API.
  await pushClient.drain().catch(() => {});
  eventStream.closeAll();
  closeClient();
  server.close(() => process.exit(0));
  // force-exit if something hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
