# Phase 1 — Paper evidence

All evidence is **paper — no slippage or fees**. It is independent of live paper-position P&L and does not place orders.

## Outcome definitions

Eligible signals have a valid timestamp, intraday/swing mode, and finite positive entry/stop with entry > stop. Each journal event is an observation; multiple labels share that observation and label groups are not additive or independent trials.

Risk is recorded entry minus recorded stop. Recorded targets take precedence. Missing targets are explicitly derived as entry +10 points intraday or entry +2.5R swing. These are signal-level measurements, not a claim that the live sizing engine opened a position at these levels.

Intraday evaluation begins at the next 5-minute bar strictly after the signal timestamp, excluding the bar containing the signal. It ends at the session close. Swing evaluation begins in the next trading session and measures +1/+3/+5 session closes. Complete OHLC bars only are used. The calendar comes from Phase 0; its 2026 dates remain unverified.

If stop and target are touched in one bar, stop wins. Fills use the modeled level even across gaps: no gap slippage is modeled. The first-touch result is -1R or target R. If neither level is hit, result R is the final horizon close return. First-touch scanning ends at EOD or +5 sessions. MFE/MAE are positive magnitudes in R over the full horizon, including price movement after a hypothetical exit. Horizon returns likewise continue after first touch. Intrabar excursion ordering is not inferred.

Every expected session/bar must be available from the start of the observation. Missing coverage yields `unavailable`; future horizons yield `pending`. An earlier known first touch can have a result while later horizons remain pending/unavailable. Aggregates therefore publish a separate finite-observation count for every metric. n < 30 always carries a warning; zero-sample means are null.

## Storage and migration

Apply `supabase/migrations/202610280001_signal_outcomes.sql` after the existing migration. It adds a server-only `signal_outcomes` table, keyed by event key and calculation version. It does not alter the canonical signal schema or existing tables.

Without Supabase, outcomes persist atomically in `SWING_DATA_DIR/signal-outcomes.json`. With Supabase, they are mirrored through the existing write queue and hydrated on boot. A missing migration falls back to local outcomes with a warning; apply the migration before expecting database durability. Existing outcomes act as per-event checkpoints. Completed rows skip repeated history fetches; pending/unavailable rows are retried. Read APIs use the persisted outcome snapshot in memory, not database queries on each request.

The historical journal iterator paginates database events and streams local active/archived journals, deduplicating by event key. It is not limited to the recent 500/2,000-record API windows. Legacy rotated files must remain on disk to be included. Retained history is evaluated; records already deleted cannot be recovered.

## Running and split deployment

A non-ingest instance with at least one scanning mode enabled runs evaluation immediately after storage initialization, then every 15 minutes after each pass. `ENABLE_OUTCOMES=false` disables the automatic worker. The worker captures one clock per pass and fetches up to 5,000 recent bars per symbol/mode. This provider limit means old records may remain unavailable; it does not claim full historical coverage.

The scanner persists outcomes and POSTs them to `/api/ingest/outcomes` using its existing push URL/key. Completed outcomes are forwarded again on later passes, allowing retries after network failure. This is periodic reconciliation, not a durable outbox (Phase 6). Ingest instances do not run the worker. Signal ingestion now preserves optional validated producer timestamps/event keys so evidence can join the originating journal record; legacy payloads remain accepted.

A single scanner/evaluator should own a signal's results. Multiple independent writers and a distributed scheduler are not handled in this phase. Snapshots and aggregate queries hold all stored outcomes in memory; this is intended for the small private deployment, not unlimited data volume.

## API and UI

- `GET /api/public/outcomes/stats`: overall, signal-label, confluence, mode and sector groups, with coverage counts and metric-specific sample sizes/warnings.
- `GET /api/public/outcomes/:eventKey`: full result, target provenance, first touch, and horizon metrics.
- `POST /api/ingest/outcomes`: existing API-key authentication; 1–50 versioned outcomes; repeated event/version writes replace the existing row.
- `/journal`: paper-evidence table with grouping selector, result sample size/warnings, pending/unavailable counts, and empty/error states. Detailed horizon metrics are exposed through the API; broader stats UI remains Phase 5.

These read APIs follow the existing public API access model until invite-only access is implemented in Phase 2. Do not assume this phase makes the deployment private.

## Swing replay

`npm run backtest:swing -- --symbols=RELIANCE,TCS` fetches up to 1,000 daily bars per supplied symbol and the index. The universe is explicitly supplied, not reconstructed historical screener membership. Each decision sees only its completed daily prefix, with EMA/ATR annotation recalculated on that prefix and index returns cut off on the same date.

Three signals plus structural entry/stop create a next-session-open candidate. The replay shares swing risk constants, stop resolution, sizing, capital and concurrency caps. It uses OHLC stop-first exits, partial target booking, breakeven, an end-of-bar chandelier update effective next bar, and a session time stop. Candidates rank by signal count then symbol for determinism. This replay is a documented OHLC model; the live paper manager checks closes and its ranking also uses current screener performance, so results are not exact live execution replication. Open positions are reported separately rather than treated as closed winners. Calendar dates, missing feed history, fixed-universe selection and missing fees/slippage limit conclusions.

## Local verification

```bash
npm run test:evidence
npm test
SWING_DATA_DIR=/tmp/ankquant-evidence-demo npm run outcomes -- --fixture=fixtures/evidence.json
npm run backtest:swing -- --fixture=fixtures/swing-replay.json
```

Fixture commands do not require market-data credentials or Supabase. The replay fixture may produce zero entries with the real evaluators; the tests additionally inject deterministic setups to verify entry/exit timing and future-data invariance. Live commands require a working TradingView feed. Tests cover collision ordering, completion/coverage, R/excursions, target derivation, sample-size denominators, persistence/restart, idempotent HTTP ingestion and historical journal iteration.
