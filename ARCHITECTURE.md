# AnkQuant — current architecture

Snapshot: 29 October 2026. Describes the implemented `work` checkout, including uncommitted changes. Production deployment, applied migrations and live integrations have not been verified.

```mermaid
flowchart TD
  TV["TradingView · current data source<br/>Screener HTTP + candle WebSocket"]
  CAL["Shared IST clock + NSE calendar<br/>Calendar dates require verification"]

  subgraph SCANNER["Scanner process · local or all-in-one"]
    DATA["Market-data services<br/>Universe, candles, Nifty"]
    LOOPS["Intraday + daily swing schedulers"]
    TA["Indicators + signal evaluation<br/>Three-signal confluence gates"]
    PAPER["Shared paper position managers"]
    JOURNAL["Canonical signal journal"]
    EVIDENCE["Forward outcomes + aggregates"]
    PUSH["Authenticated push client<br/>Memory queue; best-effort reconciliation"]
    HEART["Keepalive heartbeat<br/>Weekdays 08:55–15:45 IST, holidays excluded<br/>Default minimum interval: 8 minutes"]
  end

  subgraph HOST["Express/CommonJS API · Render ingest mode or all-in-one"]
    INGEST["API-key ingest<br/>Signals, universe, swing state, outcomes, heartbeat"]
    ACCESS["Private access controls<br/>Session cookies + roles<br/>API keys for machine calls"]
    API["REST APIs + SSE<br/>Scanner, journal, candles, outcomes, accounts"]
    ACCOUNTS["Invite-only accounts<br/>scrypt passwords + hashed sessions"]
    PERSONAL["Owner-scoped paper journal<br/>Capital, risk, sizing, manual exits, R stats"]
    PREF["Saved alert preferences<br/>Delivery filtering + daily limits + digests"]
  end

  subgraph WORKER["Optional personal worker · exactly one configured owner"]
    REMIND["Verified private Telegram linking<br/>Stop / target / trail / time reminders"]
  end

  DB[("Supabase / PostgreSQL<br/>Signals, outcomes, paper trades, state<br/>Users, invites, sessions, preferences<br/>Personal trades, links, reminders")]
  FILE[("Local JSON / JSONL fallback<br/>Signals, swing state, outcomes<br/>No account-data fallback")]
  UI["Vanilla-JS browser UI<br/>Login · Scanner · Symbol charts<br/>Signal journal · Personal journal<br/>Alert settings · Statistics"]
  TG["Telegram<br/>Shared scanner alerts + private reminders"]
  CRON["cron-job.org · optional external setup<br/>Must schedule hours and holidays externally"]
  BACKTEST["CLI research tools<br/>Intraday replay · swing replay · swing backfill"]

  TV --> DATA
  CAL --> LOOPS
  DATA --> LOOPS --> TA
  TA --> PAPER
  TA --> JOURNAL --> EVIDENCE
  TA --> TG
  PAPER --> TG
  JOURNAL --> PUSH
  PAPER --> PUSH
  EVIDENCE --> PUSH
  DATA --> PUSH
  CAL --> HEART --> PUSH --> INGEST
  INGEST --> API
  UI <-->|"Same-origin REST + SSE"| ACCESS
  ACCESS --> API
  ACCESS --> ACCOUNTS
  API --> PERSONAL
  API --> PREF
  ACCOUNTS --> DB
  PERSONAL --> DB
  PREF --> DB
  JOURNAL --> DB
  EVIDENCE --> DB
  PAPER --> DB
  JOURNAL --> FILE
  EVIDENCE --> FILE
  PAPER --> FILE
  API --> DB
  API -->|"Recent state and journal reads"| FILE
  API -->|"Chart and analysis requests may fetch upstream"| DATA
  DB --> REMIND
  DATA --> REMIND
  CAL --> REMIND
  REMIND --> DB
  REMIND --> TG
  CRON -.->|"Authenticated GET /api/public/market/status"| ACCESS
  BACKTEST --> DATA
```

## Deployment shapes

- **All-in-one:** one process serves the API/UI and runs enabled scanner/evidence loops.
- **Split:** a scanner with working TradingView access pushes to the hosted API. `INGEST_MODE=true` disables scanner/evidence startup on the hosted instance. Candle and some analysis endpoints can still request upstream data.
- The personal worker is independently enabled with `ENABLE_PERSONAL_WORKER=true`; run exactly one Telegram consumer with database and market-data access. It may run on the scanner host.
- The keepalive gate controls heartbeat traffic only. Normal pushes, background work and user visits are separate. An external pinger must exclude holidays before sending requests; the application cannot prevent an already-sent incoming request.

## Storage and access

Market history uses optional Supabase persistence plus documented local fallbacks; not every quote/candle is durably cached. Account identity, sessions, preferences, personal trades and reminder delivery require Supabase and fail closed without it. All database secrets stay on the backend. Personal ownership comes from the session, never a browser-supplied user ID. Machine keys do not impersonate personal users.

The UI service worker caches static assets only, not authenticated HTML/API responses. Scanner favourites are browser-local; account alert watchlists are separately stored preferences.

## State of the roadmap

| Phase | Current state |
| --- | --- |
| 0: Correctness | Implemented; official calendar verification remains |
| 1: Evidence | Implemented; live provider/database checks remain |
| 2: Accounts | Foundation implemented with Phase 4; live migration/account checks remain |
| 3: Per-user signal alerts | Implemented: filtering, digests, private controls and admin heartbeat alerts; live database/Telegram verification remains |
| 4: Personal paper journal | Implemented; live Telegram/database checks remain |
| 5: UI | Implemented; fixture browser flow verified; live integration/full accessibility audit remain |
| 6: Reliability | Partial: scheduled keepalive exists; durable outbox, replica ownership, broader validation/logging/metrics/backup/shutdown hardening remain |
| 7: CI and load testing | Implemented Actions, Playwright, contracts and 50-client SSE regression; remote/staging execution remains unverified |
| 8: Upstox migration | Proposed only; TradingView remains active |

No broker orders, automated trading or cross-user leaderboards are implemented. Test results from earlier work establish local/fixture behavior, not production deployment state. This snapshot involved source inspection and documentation checks only; no new application tests or deployment actions were performed.
