/**
 * OpenAPI 3.0 spec, hand-written rather than generated.
 *
 * Served as JSON at /api/docs.json and rendered by a tiny standalone HTML
 * page at /api/docs. Using the Swagger UI CDN bundle rather than adding
 * swagger-ui-express keeps the dependency list at five packages - worth it
 * for something whose only job is rendering a static spec.
 */

const pkg = require('../../package.json');

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'AnkQuant API',
    version: pkg.version,
    description:
      'Intraday and swing scanner for NSE equities. Public read endpoints are unauthenticated; ' +
      'admin and money-revealing endpoints require an API key via the x-api-key header.\n\n' +
      '**Note:** live-state endpoints return empty results outside market hours (NSE trades ~31 of 168 hours weekly). ' +
      'Use /api/public/signals/recent and /api/public/stats for data that is always populated.',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'Public', description: 'Unauthenticated read endpoints — always populated' },
    { name: 'Intraday', description: 'Live intraday scanner state' },
    { name: 'Swing', description: 'Swing positions and trade journal' },
    { name: 'Ingest', description: 'Authenticated pushes from a remote scanner' },
    { name: 'Admin', description: 'Requires x-api-key' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    schemas: {
      Signal: {
        type: 'object',
        properties: {
          ts: { type: 'string', format: 'date-time' },
          mode: { type: 'string', enum: ['intraday', 'swing'] },
          symbol: { type: 'string', example: 'RELIANCE' },
          signals: { type: 'array', items: { type: 'string' }, example: ['PULLBACK', 'VWAP RECLAIM'] },
          signalCount: { type: 'integer' },
          price: { type: 'number' },
          confluence: { type: 'boolean', description: 'Did this clear the confluence gate' },
          levels: {
            type: 'object',
            nullable: true,
            properties: {
              entry: { type: 'number' },
              stop: { type: 'number' },
              target: { type: 'number' },
              riskReward: { type: 'number', nullable: true },
            },
          },
          context: { type: 'object', nullable: true },
        },
      },
      MarketStatus: {
        type: 'object',
        properties: {
          isOpen: { type: 'boolean' },
          phase: {
            type: 'string',
            enum: ['weekend', 'holiday', 'pre_market', 'opening_range', 'open', 'lunch_lull', 'square_off', 'post_market'],
          },
          nowIST: { type: 'string' },
          nextOpen: { type: 'object', nullable: true },
          holidayDataStale: { type: 'boolean', description: 'True if the current year is absent from the shared NSE calendar' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  paths: {
    '/api/public/signals/recent': {
      get: {
        tags: ['Public'],
        summary: 'Recent signals from the persisted journal',
        description: 'Populated regardless of market hours. This is the primary feed for a front-end.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['intraday', 'swing'] } },
          { name: 'type', in: 'query', schema: { type: 'string' }, example: 'PULLBACK' },
          { name: 'symbol', in: 'query', schema: { type: 'string' } },
          { name: 'confluenceOnly', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          200: {
            description: 'Matching signals, newest first',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer' },
                    signals: { type: 'array', items: { $ref: '#/components/schemas/Signal' } },
                  },
                },
              },
            },
          },
          400: { description: 'Invalid query parameter', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/public/stats': {
      get: {
        tags: ['Public'],
        summary: 'Aggregate statistics',
        description:
          'Signal counts by type/mode/sector, daily histogram, and performance. ' +
          'In PUBLIC_MODE, performance is reported in R-multiples rather than rupees.',
        responses: { 200: { description: 'Aggregates' } },
      },
    },
    '/api/public/market/status': {
      get: {
        tags: ['Public'],
        summary: 'Market session state',
        description: 'Lets a UI distinguish "market closed" from "service broken".',
        responses: {
          200: { description: 'Session state', content: { 'application/json': { schema: { $ref: '#/components/schemas/MarketStatus' } } } },
        },
      },
    },
    '/api/public/health': {
      get: {
        tags: ['Public'],
        summary: 'Aggregate health check',
        description: 'Returns 503 when degraded, so uptime monitors can act on the status code alone.',
        responses: { 200: { description: 'Healthy' }, 503: { description: 'Degraded' } },
      },
    },
    '/api/public/stream': {
      get: {
        tags: ['Public'],
        summary: 'Live signal stream (Server-Sent Events)',
        description:
          'text/event-stream. Events: connected, signal, position, scan_status. ' +
          'Seeds with the last 10 signals on connect so a fresh client is never blank. ' +
          'Heartbeat comment every 25s keeps proxies from closing an idle connection.',
        parameters: [{ name: 'mode', in: 'query', schema: { type: 'string', enum: ['intraday', 'swing'] } }],
        responses: { 200: { description: 'SSE stream', content: { 'text/event-stream': {} } }, 503: { description: 'Too many connections' } },
      },
    },
    '/api/public/candles/{symbol}': {
      get: {
        tags: ['Public'],
        summary: 'Bounded candle history for a symbol chart',
        parameters: [
          { name: 'symbol', in: 'path', required: true, schema: { type: 'string', maxLength: 24 }, example: 'RELIANCE' },
          { name: 'interval', in: 'query', schema: { type: 'string', enum: ['5m', '1d'], default: '5m' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 20, maximum: 250 } },
        ],
        responses: {
          200: { description: 'OHLC candles, oldest first' },
          400: { description: 'Unsupported symbol, interval, or limit' },
          502: { description: 'Candle provider returned no data' },
          503: { description: 'Candle service is busy' },
        },
      },
    },
    '/api/public/live/stocks': {
      get: {
        tags: ['Public'],
        summary: 'Current tracked universe',
        description: 'Returns the live universe, the last successful scan timestamp, and any signal logged for each symbol today. The universe is empty outside market hours by nature — check marketOpen in the response.',
        responses: { 200: { description: 'Tracked stocks' } },
      },
    },
    '/api/ingest/universe': {
      post: {
        tags: ['Ingest'],
        summary: 'Replace the current remote intraday universe snapshot',
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['lastScanAt', 'stocks'],
                properties: {
                  lastScanAt: { type: 'string', format: 'date-time' },
                  stocks: {
                    type: 'array',
                    maxItems: 200,
                    items: {
                      type: 'object',
                      required: ['symbol', 'price'],
                      properties: {
                        symbol: { type: 'string', maxLength: 24 },
                        price: { type: 'number', minimum: 0, exclusiveMinimum: true },
                        change: { type: 'number', nullable: true },
                        relVolume: { type: 'number', nullable: true },
                        sector: { type: 'string', nullable: true, maxLength: 120 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Snapshot accepted' },
          400: { description: 'Invalid snapshot' },
          401: { description: 'Invalid API key' },
          413: { description: 'Snapshot too large' },
        },
      },
    },
    '/api/scanner/stocks': {
      get: { tags: ['Intraday'], summary: 'Live intraday universe', responses: { 200: { description: 'OK' } } },
    },
    '/api/scanner/positions': {
      get: { tags: ['Intraday'], summary: 'Open intraday positions', responses: { 200: { description: 'OK' } } },
    },
    '/api/scanner/signals/{type}': {
      get: {
        tags: ['Intraday'],
        summary: 'Symbols that fired a given signal today',
        parameters: [
          {
            name: 'type',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['pullback', 'orb', 'momentum', 'volume', 'vwap', 'runner', 'afternoon', 'strong'] },
          },
        ],
        responses: { 200: { description: 'OK' }, 404: { description: 'Unknown signal type' } },
      },
    },
    '/api/swing/positions': {
      get: { tags: ['Swing'], summary: 'Open swing positions', responses: { 200: { description: 'OK' } } },
    },
    '/api/swing/trades': {
      get: { tags: ['Swing'], summary: 'Closed trade journal with win rate', responses: { 200: { description: 'OK' } } },
    },
    '/api/swing/analyze/{symbol}': {
      get: {
        tags: ['Swing'],
        summary: 'Evaluate any symbol on demand',
        parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' }, example: 'RELIANCE' }],
        responses: { 200: { description: 'Signal evaluation' } },
      },
    },
    '/api/swing/candidates': {
      get: { tags: ['Swing'], summary: 'Raw screener universe', responses: { 200: { description: 'OK' }, 502: { description: 'Upstream fetch failed' } } },
    },
    '/api/swing/admin/scan': {
      post: {
        tags: ['Admin'],
        summary: 'Force a swing scan now',
        security: [{ ApiKeyAuth: [] }],
        responses: { 200: { description: 'Scan triggered' }, 401: { description: 'Invalid key' }, 503: { description: 'API_KEY not configured' } },
      },
    },
    '/api/swing/positions/{symbol}/close': {
      post: {
        tags: ['Admin'],
        summary: 'Manually close a tracked position',
        description: 'For when you exit in your broker for a reason the scanner cannot see.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['exitPrice'], properties: { exitPrice: { type: 'number' } } } } },
        },
        responses: { 200: { description: 'Closed' }, 400: { description: 'Missing exitPrice' }, 401: { description: 'Invalid key' }, 404: { description: 'No open position' } },
      },
    },
    '/api/scanner/admin/start': {
      post: { tags: ['Admin'], summary: 'Start the intraday loop', security: [{ ApiKeyAuth: [] }], responses: { 200: { description: 'Started' }, 401: { description: 'Invalid key' } } },
    },
    '/api/scanner/admin/stop': {
      post: { tags: ['Admin'], summary: 'Stop the intraday loop', security: [{ ApiKeyAuth: [] }], responses: { 200: { description: 'Stopped' }, 401: { description: 'Invalid key' } } },
    },
  },
};

const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AnkQuant API — Docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <link rel="stylesheet" href="/assets/workspace.css" />
  <link rel="stylesheet" href="/assets/docs.css" />
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to API reference</a>
  <header class="docs-header"><a class="brand" href="/app"><span class="brand-name">Ank<span>Quant</span></span><span class="badge badge-accent">API REFERENCE</span></a><nav aria-label="Documentation navigation"><a href="/personal">Personal workspace</a><a href="/app">Scanner</a><a href="/api/docs.json">OpenAPI JSON</a></nav></header>
  <main id="main-content" tabindex="-1" class="docs-shell"><section class="docs-hero" aria-labelledby="docs-title"><span class="docs-eyebrow">DEVELOPER WORKSPACE</span><h1 id="docs-title">Explore the AnkQuant API</h1><p>Signals, research evidence and your private paper journal. Inspect endpoint contracts and authentication requirements below.</p><div class="docs-notice">PAPER RESEARCH ONLY · No broker integration or order placement. “Try it out” sends real API requests; writes can change your saved settings or paper records.</div></section>
  <div class="docs-links"><a href="/api/docs.json">Download API schema ↗</a><span>Session and machine-key requirements vary by endpoint.</span></div>
  <p id="docs-load-status" role="status">Loading interactive API reference. If it is unavailable, open the OpenAPI JSON link above.</p><div id="swagger-ui"></div></main>
  <footer class="docs-footer">AnkQuant · Private paper research workspace</footer>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js"></script>
  <script>
    window.onload = () => {
      if(typeof SwaggerUIBundle==='undefined')return;
      SwaggerUIBundle({
        url: '/api/docs.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        tryItOutEnabled: true,
        onComplete: () => { document.getElementById('docs-load-status').hidden = true; },
      });
    };
  </script>
</body>
</html>`;

spec.paths['/api/public/outcomes/stats'] = { get: { summary: 'Paper forward outcomes grouped by mode, label, confluence and sector', description: 'No slippage or fees. Every metric includes n and a warning below 30 observations. Missing coverage is not a zero return.', responses: { 200: { description: 'Versioned evidence aggregates and coverage counts' } } } };
spec.paths['/api/public/outcomes/{eventKey}'] = { get: { summary: 'Paper outcome for a signal event key', parameters: [{ in: 'path', name: 'eventKey', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'First touch, R result, horizon returns and excursions' }, 404: { description: 'Signal has no evaluated outcome' } } } };
spec.paths['/api/ingest/outcomes'] = { post: { summary: 'Authenticated idempotent paper outcome ingestion', parameters: [{ in: 'header', name: 'x-api-key', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['outcomes'], properties: { outcomes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } } } } } }, responses: { 200: { description: 'Accepted' }, 400: { description: 'Invalid outcomes' }, 401: { description: 'Invalid key' }, 503: { description: 'API key not configured' } } } };

// Account payload details and setup are documented in PERSONAL_JOURNAL.md.
for (const [path,method,summary] of [
 ['/api/account/bootstrap','post','Create the initial admin (machine API key; one-time)'],
 ['/api/account/register','post','Redeem a single-use friend invite'],
 ['/api/account/login','post','Start an httpOnly session'],
 ['/api/account/logout','post','Revoke the current session'],
 ['/api/account/me','get','Read own identity and settings'],
 ['/api/account/invites','post','Create an invite (admin session)'],
 ['/api/account/settings','post','Save own capital and risk settings'],
 ['/api/account/telegram/link','post','Create one-time private Telegram link'],
 ['/api/account/telegram/unlink','post','Remove own Telegram destination'],
 ['/api/account/journal','get','Read own paper trades and R statistics'],
 ['/api/account/journal','post','Mark a signal taken with personal sizing'],
 ['/api/account/journal/{id}/close','post','Record own manual paper exit'],
]) {
 spec.paths[path] = spec.paths[path] || {};
 spec.paths[path][method] = { summary, description: 'Accounts require Supabase. Browser mutations require a matching Origin. Personal reads/writes derive ownership from the session. See PERSONAL_JOURNAL.md for payloads.', responses: {200:{description:'Success'},400:{description:'Invalid input'},401:{description:'Login required'},403:{description:'Forbidden'},503:{description:'Account database unavailable'}} };
 if(path.includes('{id}'))spec.paths[path][method].parameters=[{in:'path',name:'id',required:true,schema:{type:'string',format:'uuid'}}];
}

spec.paths['/api/account/preferences'] = {
 get: { summary: 'Read own saved alert preferences', description: 'Session required. Filtering is implemented; actual delivery requires a linked private chat and enabled worker.', responses: {200:{description:'Preferences, deliveryActive and IST time zone'},401:{description:'Login required'}} },
 post: { summary: 'Save own validated alert preferences', description: 'Session and matching Origin required. Saves independently of personal capital/risk settings. See PHASE5.md.', responses: {200:{description:'Saved preferences for private signal delivery'},400:{description:'Invalid preferences'},401:{description:'Login required'},403:{description:'Origin rejected'},503:{description:'Database or migration unavailable'}} }
};

spec.paths['/api/account/admin/upstox']={get:{summary:'Read admin Upstox preparation status and comparison report',description:'Admin session required. Includes sourced metadata coverage, exclusions and observed differences; does not certify parity.',responses:{200:{description:'Preparation state/report'},401:{description:'Login required'},403:{description:'Admin required'},503:{description:'Database unavailable'}}}};
spec.paths['/api/account/admin/upstox/prepare']={post:{summary:'Start a read-only source and screener comparison job',description:'Admin session and matching Origin required. Ingest-only host, configured backend token and database required. Scanner lease prevents duplicate jobs; no signals/orders/provider change.',responses:{202:{description:'Job started'},200:{description:'Job already running'},401:{description:'Login required'},403:{description:'Admin/origin rejected'},409:{description:'Preparation configuration conflict'}}}};
spec.paths['/api/account/admin/upstox/report']={post:{summary:'Import an original dated NSE PR archive',description:'Admin session, matching Origin and database-backed ingest API required. Fixed filename/date parsing and 12 MB limit. Does not accept arbitrary source URLs.',parameters:[{in:'header',name:'x-report-date',required:true,schema:{type:'string',format:'date'}},{in:'header',name:'x-nse-source-attested',required:true,schema:{type:'string',enum:['true']}}],requestBody:{required:true,content:{'application/zip':{schema:{type:'string',format:'binary'}}}},responses:{200:{description:'Source report imported'},400:{description:'Invalid body/date'},401:{description:'Login required'},403:{description:'Admin/origin rejected'},409:{description:'Invalid source or configuration'},413:{description:'Archive too large'}}}};
spec.paths['/api/account/admin/workers']={get:{summary:'Admin-only process-local worker activity',description:'Scheduler tick counters, timestamps, next-run times and activity evidence. Does not prove live data correctness. Resets on restart.',responses:{200:{description:'Intraday, swing and outcome activity'},401:{description:'Login required'},403:{description:'Admin required'}}}};
module.exports = { spec, DOCS_HTML };
