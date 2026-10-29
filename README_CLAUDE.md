# AnkQuant — Current Features and Architecture

Codebase handoff for Claude. Snapshot: 28 October 2026. This describes the checked-out implementation, not verified production configuration or live market-data availability.

## What this project is

AnkQuant is a Node.js market scanner for Indian equities, with independent intraday and daily swing strategies. It finds technical setups, sends Telegram alerts, tracks simulated positions, and exposes a browser dashboard and APIs.

It does not connect to a broker or execute real orders. Paper P&L and position records are simulations. The candle/history integration explicitly requests NSE symbols; the upstream screener scans the India market, so do not assume complete BSE support.

## Implemented features

### Browser application

- `/` serves the scanner page for HTML requests and API metadata for other requests.
- `/app`: responsive live intraday workspace with stock search, sorting, all/watchlist/setup/confluence filters, market and scanner status, selected-stock details, signal levels, and an SVG 5-minute candlestick chart.
- Watchlist saved in browser `localStorage`; it filters tracked symbols rather than adding symbols to the scanner universe. No cross-device sync.
- SSE updates plus periodic REST refreshes.
- `/journal`: recorded intraday and swing signals, symbol/mode/type/date/confluence filters, summary counts, selected-signal context, charts with interval selection, and CSV export of filtered loaded rows.
- Journal views use a bounded recent window, with up to 500 matches returned per request; they are not a paginated explorer of all database history.
- `/demo`: public signal tape.
- Installable PWA with manifest, icons, and service worker. The `/app` shell can launch offline; API requests and streams always use the network.
- `/api/docs` and `/api/docs.json`: Swagger UI and OpenAPI specification.

The frontend is plain HTML/CSS/JavaScript in self-contained pages. There is no React, Next.js, TypeScript, frontend bundler, or separate frontend build step.

### Intraday scanner

- Uses 5-minute candle signals and a live TradingView screener universe.
- Main universe: price ₹100–₹3,000, daily change above 2%, relative volume above 2, ATRP above 2, and average 10-day volume above 500,000.
- Early universe: change 0.5–3%, relative volume above 1.2, ATRP above 1.5, and the same liquidity floor.
- Each screener request is capped at 100 results and ranked by relative volume.
- Seven signal types: `PULLBACK`, `ORB BREAKOUT`, `NO-PULLBACK RUNNER`, `AFTERNOON BREAKOUT`, `MOMENTUM`, `VOLUME SPIKE`, and `VWAP RECLAIM`.
- EMA and session-resetting VWAP calculations, cross-cycle momentum tracking, volume-spike checks, Nifty relative-strength checks, and confluence scoring.
- Confluence threshold: **3 signals**. Structural entry/stop levels are needed for position sizing; a signal event does not guarantee a paper position was opened.
- Normal entry window: 09:20–12:30 IST. Separate afternoon-pattern window: 13:00–15:10 IST.
- Target loop delays: 15 seconds early in the session, 30 seconds mid-session, and 20 seconds later. The delay starts after the cycle finishes, so actual intervals include scan duration.
- Daily reset, duplicate-alert tracking, periodic summaries, and end-of-day summary.

### Swing scanner

- Evaluates daily candles across up to 150 candidates, ranked initially by three-month performance.
- Universe: price ₹100–₹5,000, average volume above 300,000, market cap above ₹500 crore, ATRP above 2, price and SMA50 above SMA200, and daily change below 5%.
- Six signals: `BASE BREAKOUT`, `MA PULLBACK`, `MA STACK`, `52W HIGH`, `VOLUME DRYUP`, and `RS LEADER`.
- Uses EMA20/50/200, Wilder ATR14, RSI, rolling highs/lows, volume contraction, and 60-day index-relative returns. RS leadership requires at least 8 percentage points of outperformance.
- Confluence threshold: **3 signals**. A structural signal (`BASE BREAKOUT` or `MA PULLBACK`) is also required to label the journal event as confluence and attempt a paper entry. Three contextual signals alone may be recorded but are not entry confluence.
- Candidates that pass the signal-count gate are ranked by signal count, then three-month performance.
- Scheduled once per weekday at or after **15:45 IST**, checked every five minutes. A late startup can run the day's scan later. Existing positions are managed before new entries.
- Manual scan and manual paper-position close APIs.
- Historical swing signal backfill for 1–5 completed sessions, with event deduplication. Backfill requires Supabase and market history; it does not open positions or send Telegram alerts.

### Paper position management

| Behavior | Intraday | Swing |
| --- | --- | --- |
| Default risk budget per trade | ₹5,000 | ₹5,000 |
| Default capital allocation | ₹200,000 | ₹200,000 |
| Initial stop | Setup/structural level | 2× ATR14, tightened to structure |
| First target | +10 points | 2.5R |
| At target | Book 50%, move stop to breakeven | Book 50%, move stop to breakeven |
| Runner trail | 1.5% from peak | Peak minus 2.5× ATR |
| Time exit | Square-off from 15:15 IST | 15 sessions if still below 1R |
| Additional exposure control | Configurable leverage, default 1 | Maximum 5 open positions |

Both strategies cap sizing by risk and remaining allocated capital. The two books have separate capital settings; there is no shared account-wide broker risk engine. Swing exits are checked against daily close data during scan passes, not continuously against live ticks.

### Telegram

- Compact Market Pulse alerts, TradingView links, paper entry/exit notifications, scan summaries, and command polling.
- Commands include `/stocks`, `/positions`, `/strong`, `/pullback`, `/momentum`, `/volume`, `/vwap`, `/runner`, `/afternoon`, `/swing`, `/swingstats`, and `/help`.
- Telegram command polling happens in the intraday scan cycle; a swing-only deployment should not assume independent command polling.

## Architecture

Single CommonJS Node.js service, with Express serving both the API and static pages. Main dependencies: Express, Axios, `@mathieuc/tradingview`, `@supabase/server`, dotenv, and node-cron. Runtime minimum is Node 18; `.node-version` pins 24.21.0.

```text
TradingView screener HTTP + chart WebSocket
                    |
             market-data services
                    |
       intraday loop / daily swing loop
                    |
       indicators -> signals -> paper positions
                    |
          +---------+-----------+
          |         |           |
       Telegram   journal    state/trade storage
                    |           |
                    +-----+-----+
                          |
                  Express REST + SSE
                          |
                scanner / journal / demo
```

The upstream candle connection uses WebSocket. Browser updates use server-sent events (SSE), not WebSocket. SSE has heartbeats and recent-signal replay on connection.

### Main modules

```text
src/index.js                    Startup, storage hydration, loop toggles, shutdown
src/server.js                   Express app, pages, middleware, API mounting
src/config/constants.js         Intraday strategy/risk settings
src/config/swingConstants.js    Swing strategy/risk settings and schedule
src/config/timeUtils.js         IST time helpers
src/services/tvScanner.js       Main and early intraday screener requests
src/services/swingScanner.js    Swing universe requests
src/services/tvHistory.js       TradingView OHLCV history client
src/services/nifty.js           Cached intraday index comparison
src/services/telegram.js        Alert formatting and bot commands
src/services/eventStream.js     SSE connections and broadcasts
src/services/marketStatus.js    Session/holiday/next-open presentation
src/services/supabaseStore.js   Server-side database adapter and write queue
src/services/paperTradeStore.js Trade persistence and intraday restoration
src/services/pushClient.js      Remote signal/universe/swing-state forwarding
src/indicators/ta.js            Intraday indicators
src/indicators/signals.js       Intraday setup evaluators
src/indicators/swingTa.js       Daily technical indicators
src/indicators/swingSignals.js  Daily setup evaluators
src/trading/positionManager.js  Intraday paper lifecycle
src/trading/swingPositionManager.js  Swing paper lifecycle
src/trading/momentum.js         Cross-cycle momentum
src/trading/volume.js           Volume-spike detection
src/state/dailyState.js         Ephemeral intraday runtime state
src/state/swingState.js         Durable swing state with local fallback
src/state/signalJournal.js      Canonical signal records and recent queries
src/jobs/scanLoop.js            Self-rescheduling intraday loop
src/jobs/swingLoop.js           Daily swing scan scheduling/orchestration
src/jobs/swingBackfill.js       Historical completed-session signal generation
src/routes/                    Public, scanner, swing, and ingest routes
src/middleware/auth.js          API-key checks, redaction, per-IP rate limiting
src/docs/openapi.js             API spec and docs page
src/backtest/backtest.js        Intraday bar-by-bar replay
public/                        Pages, PWA assets, service worker
supabase/migrations/           Database schema
```

### Storage and startup

1. Load local journal and swing state so the service can start without the database.
2. Start the HTTP server.
3. Connect to Supabase if configured, hydrate durable journal/swing state, and restore eligible current-day intraday positions.
4. Start enabled scan loops and optional remote push client.
5. On shutdown, stop loops, attempt queue flushes, close SSE and market-history connections, and stop HTTP.

Supabase tables:

| Table | Purpose |
| --- | --- |
| `signal_events` | Timestamped signal records, event deduplication keys, labels, price, levels, and context |
| `scanner_state` | JSON state snapshots keyed by name |
| `paper_trades` | Normalized intraday/swing trade lifecycles, sizing, stops, targets, exits, P&L, and metadata |

Database access stays on the server. The migration enables RLS and revokes direct table access from browser roles. The backend uses a secret/service-role key.

Without a working Supabase connection, journal/swing state use local JSONL/JSON files under `SWING_DATA_DIR` (default `./data`). Intraday runtime state remains primarily in memory and resets daily. Live quotes are not stored as a full historical time series. Recent API reads use the loaded in-memory journal window rather than querying the entire database on each request.

Canonical signal fields include `ts`, `mode`, `symbol`, `signals`, `signalCount`, `price`, `confluence`, `levels`, and `context`, with identity/deduplication fields normalized by the journal. Preserve this contract across recording, ingestion, REST, SSE, CSV, and frontend consumers.

## Deployment modes

### All-in-one

One process runs the HTTP API, browser pages, scanner loops, Telegram integration, and storage. Suitable for a machine with working TradingView access.

### Split scanner and hosted API

```text
Local/home scanner -> authenticated HTTP pushes -> hosted API -> browsers
       |                                           |
  TradingView                                  journal/storage
  Telegram                                     REST + SSE
```

- Scanner: set `PUSH_URL` and `PUSH_API_KEY` to forward batched signals, latest universe snapshots, swing positions/trades, and heartbeats.
- Hosted instance: set `INGEST_MODE=true`; startup skips local scan loops and accepts authenticated ingest writes.
- Signals have a bounded in-memory retry queue; universe snapshots are coalesced. This is not a durable message broker or guaranteed delivery pipeline.
- Split position synchronization currently mirrors swing state; do not assume it mirrors the complete intraday position book.
- Heartbeats let the hosted UI distinguish a quiet market from a scanner that stopped reporting.
- TradingView may reject datacenter IPs, which motivates the split deployment.
- Important exception: chart candle requests and some analysis/candidate routes still make direct upstream requests on the API host. Ingest mode does not eliminate every market-data dependency or serve as a blanket prohibition on all scan-related routes.

Dockerfile, Compose profiles (`api`, `full`), and a Render blueprint are included. `render.yaml` defaults to ingest/public mode with a persistent data disk. See `DEPLOY.md` for deployment instructions. Repository configuration does not prove a deployment is currently live.

## API surface

| Group | Endpoints |
| --- | --- |
| Public signals/stats | `GET /api/public/signals/recent`, `/api/public/stats` |
| Public runtime | `GET /api/public/market/status`, `/api/public/health`, `/api/public/live/stocks` |
| Live events | `GET /api/public/stream?mode=intraday` or `mode=swing` |
| Charts | `GET /api/public/candles/:symbol?interval=5m` or `interval=1d` |
| Intraday reads | `GET /api/scanner/health`, `/stocks`, `/positions`, `/summary`, `/signals/:type` under the same prefix |
| Intraday controls | `POST /api/scanner/admin/start`, `/api/scanner/admin/stop` |
| Swing reads | `GET /api/swing/health`, `/positions`, `/trades`, `/candidates`, `/analyze/:symbol` under the same prefix |
| Swing controls | `POST /api/swing/admin/scan`, `/admin/start`, `/admin/stop`, `/positions/:symbol/close` under the same prefix |
| Ingest writes | `POST /api/ingest/signals`, `/positions`, `/heartbeat`, `/universe` under the same prefix |
| Ingest status | `GET /api/ingest/status` |

Signal queries support mode, signal type, symbol, and confluence filtering. Candle reads validate symbol/interval/bar count, cache results briefly, and coalesce identical pending requests.

### Access controls

- Admin and ingest writes require `x-api-key` or a Bearer token matching `API_KEY`.
- Missing server key disables protected actions with HTTP 503; invalid/missing request keys return 401.
- `PUBLIC_MODE=true` applies money/quantity redaction on supported reads; a valid key permits full figures where implemented. It is not a user login system.
- `/api` has an in-memory, fixed-window per-IP limiter, default 60 requests/minute.
- CORS defaults to `*` and is configurable. Express trusts one proxy hop.
- No multi-user accounts, per-user portfolios, broker OAuth, or database-backed sessions are implemented.

## Local setup and configuration

```bash
npm ci
cp .env.example .env
# Configure the variables needed for the desired mode.
npm start
```

Default address: `http://localhost:4000`.

| Variables | Purpose |
| --- | --- |
| `PORT` | HTTP port |
| `ENABLE_INTRADAY`, `ENABLE_SWING` | Independently disable loops with `false`; both enabled by default |
| `TEST_MODE` | Changes market-hour handling; not an offline fixture mode |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram delivery |
| `TV_SESSION`, `TV_SIGNATURE` | Optional TradingView session credentials |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Optional durable database; legacy `SUPABASE_SERVICE_ROLE_KEY` also supported |
| `SWING_DATA_DIR` | Local journal/state directory |
| `API_KEY`, `PUBLIC_MODE` | Protected actions and public-read redaction |
| `RATE_LIMIT_PER_MIN`, `CORS_ORIGIN` | HTTP configuration |
| `INGEST_MODE` | Hosted receiver mode |
| `PUSH_URL`, `PUSH_API_KEY`, `PUSH_FLUSH_MS` | Scanner-to-host forwarding |

Strategy thresholds, capital, and sizing are JavaScript constants; swing timing can be configured through environment variables. Keep secrets in backend environment settings; never put them in public pages or this handoff.

For a local UI/API launch without automatic scanning:

```bash
ENABLE_INTRADAY=false ENABLE_SWING=false npm start
```

Charts and explicit analysis requests can still contact TradingView in that configuration.

## Validation and research tools

```bash
npm test
npm run test:swing
npm run test:swing-backfill
npm run test:api
npm run test:ingest
npm run test:signal-consistency
npm run backtest
npm run backfill:swing -- --sessions=2
```

The test suite includes offline synthetic checks for swing indicators/lifecycle, backfill, API/auth/redaction/SSE, real local-HTTP ingestion, and signal consistency across the journal, REST, SSE replay, statistics, and frontend field contracts. These do not establish live feed reliability or strategy profitability. Frontend contract checks are not full browser visual tests.

The intraday backtest replays bars for manually configured symbols; it cannot reconstruct the historical screener universe. A swing daily replay is now implemented; see PHASE1.md for next-open entries, OHLC stop-first exits, isolated simulation state and fixed-universe limitations. Swing backfill produces historical setup records using today's candidate universe, so it is not a historical portfolio simulation.

## Known limitations and inconsistencies

1. TradingView screener and chart access use undocumented interfaces. Upstream changes and host/IP restrictions can break data access.
2. Daily stock/index analysis, position management, and backfill now filter completed sessions using one IST cutoff (default 15:45). Scheduled swing scans default to 15:45 and use the shared trading calendar.
3. Calendar dates require annual official verification. The inherited 2026 list is explicitly unverified; missing years warn and fall back to weekends plus available calendar data.
4. Swing position management is periodic and close-based. It cannot simulate intraday stop execution accurately or protect a real broker position.
5. Both schedulers and market status use the shared NSE calendar. Special sessions require explicit overrides.
6. Memory-held rate limits, SSE clients, scan state, and push queues are process-local. Multiple replicas are not coordinated through a shared scheduler or event bus.
7. Local fallback files need persistent storage to survive host replacement. Optional Supabase persistence does not make live quote history comprehensive.
8. Remote forwarding is best-effort, and full intraday position synchronization is not implemented.
9. Paper outcomes are not broker fills and do not establish slippage-adjusted real performance.

## Guidance for Claude working on this codebase

Treat this as an existing Express/CommonJS application. Read the relevant modules before editing. Preserve the independent strategy configurations, canonical signal schema, paper-trading labels, backend-only secrets, and authenticated ingest/admin boundaries. Keep database and file fallback behavior aligned. Verify both all-in-one and ingest deployment paths when changing data flow. Verify annual calendar dates before relying on schedules. Distinguish implemented behavior from proposed features and unverified deployment state.

## Phase 1 update

Paper outcome tracking, versioned file/Supabase storage, authenticated split ingestion, grouped evidence APIs, journal sample-size warnings and a swing replay CLI are implemented. See PHASE1.md for the migration, conventions, coverage limitations and verification commands. Existing signal ingestion preserves optional producer timestamps/event keys.

## Private accounts and personal paper journal

See [PERSONAL_JOURNAL.md](PERSONAL_JOURNAL.md) for the new required migration, admin bootstrap, private-mode access changes, personal sizing/journal, verified Telegram links, worker configuration, and test limits. Private mode now defaults to enabled; account data requires Supabase. Phase 3 private filtering, digests and controls are implemented; see PHASE3.md for activation and verification.

## Phase 5 UI

Symbol charts with recorded-signal markers, saved account alert preferences, and detailed evidence statistics are implemented in vanilla JavaScript. See [PHASE5.md](PHASE5.md) for routes, the additive preference migration, browser tests and limitations. Alert delivery filtering is implemented by Phase 3 and requires its database migration and worker setup.

## Planned Phase 8

**Official Market Data Migration (Upstox)** is defined in [PHASE8_UPSTOX.md](PHASE8_UPSTOX.md).
It includes the reviewed parity, permissions, request-budget, provider/caching,
streaming, cutover and rollback requirements. It is proposed work, not an
implemented or authenticated Upstox integration. Phases 3, 6 and 7 remain separate.

## Phase 8 implementation update

The phase8-upstox branch adds a selectable REST/provider/diagnostic-stream adapter, persistent candle cache, lease guard and persistent signal outbox improvements. TradingView remains default. See UPSTOX_MIGRATION.md for required metadata/migration, unverified live checks and remaining implementation limits. Do not infer that Phase 8 is complete or production-deployed.

## Phase 3 private alerts

Preference enforcement, durable daily-capped/deduped queues, digests, private bot controls, per-chat cooldown/retry and admin outage notifications are implemented. See [PHASE3.md](PHASE3.md) for the migration, worker placement, controls and live-verification limits. Live Telegram/Supabase checks remain unverified.
