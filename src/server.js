const express = require('express');
const path = require('path');
const scannerRoutes = require('./routes/scanner');
const swingRoutes = require('./routes/swing');
const publicRoutes = require('./routes/public');
const { router: ingestRoutes } = require('./routes/ingest');
const { rateLimit, PUBLIC_MODE, API_KEY_CONFIGURED } = require('./middleware/auth');
const { spec, DOCS_HTML } = require('./docs/openapi');
const pkg = require('../package.json');

function createServer() {
  const app = express();

  // Trust the first proxy hop so req.ip is the real client behind a reverse
  // proxy - without this the rate limiter buckets every request under the
  // proxy's own address and effectively rate-limits the whole world as one user.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '100kb' }));

  // Permissive CORS on reads: a portfolio front-end on a different origin has
  // to be able to call this. Writes are protected by the API key, not by CORS.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.use('/api', rateLimit);

  app.get('/', (req, res) => {
    res.json({
      name: 'NSE Scanner API',
      version: pkg.version,
      docs: '/api/docs',
      publicMode: PUBLIC_MODE,
      adminEnabled: API_KEY_CONFIGURED,
      endpoints: {
        public: '/api/public',
        intraday: '/api/scanner',
        swing: '/api/swing',
        stream: '/api/public/stream',
        demo: '/demo',
        ingest: '/api/ingest',
        health: '/api/public/health',
      },
    });
  });

  // Live demo page - a single self-contained HTML file, no build step.
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'demo.html'));
  });

  app.get('/api/docs.json', (req, res) => res.json(spec));
  app.get('/api/docs', (req, res) => res.type('html').send(DOCS_HTML));

  app.use('/api/ingest', ingestRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/scanner', scannerRoutes);
  app.use('/api/swing', swingRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', docs: '/api/docs' });
  });

  // Final error handler. Without this, an unhandled throw in a route leaks a
  // stack trace to the client in Express's default handler.
  app.use((err, req, res, _next) => {
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createServer };
