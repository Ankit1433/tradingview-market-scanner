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
    title: 'NSE Scanner API',
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
            properties: { entry: { type: 'number' }, stop: { type: 'number' } },
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
          holidayDataStale: { type: 'boolean', description: 'True if the hardcoded holiday list is for a past year' },
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
    '/api/public/live/stocks': {
      get: {
        tags: ['Public'],
        summary: 'Current tracked universe',
        description: 'Empty outside market hours by nature — check marketOpen in the response.',
        responses: { 200: { description: 'Tracked stocks' } },
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
  <title>NSE Scanner API — Docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/docs.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        layout: 'BaseLayout',
        tryItOutEnabled: true,
      });
    };
  </script>
</body>
</html>`;

module.exports = { spec, DOCS_HTML };
