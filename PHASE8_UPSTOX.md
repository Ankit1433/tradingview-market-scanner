# Phase 8 — Official Market Data Migration (Upstox)

Status: **PARTIALLY IMPLEMENTED — guarded staging implementation; live verification and full parity/cutover remain incomplete**. Added on 29 October 2026. See UPSTOX_MIGRATION.md for exact implemented scope and remaining gates.

This phase incorporates the supplied TradingView-to-Upstox proposal and the review amendments below. The amendments govern wherever the original proposal assumes exact screener parity, immediate streaming, unrestricted data sharing, or an automatic production cutover. Phase numbers describe roadmap scope, not permission to deploy or proof that earlier phases are complete.

## Goal and boundaries

Move AnkQuant's market-data ingestion to official Upstox APIs incrementally, preserving the Express/CommonJS architecture, canonical signal schema, existing routes, strategy/risk parameters, personal-account isolation, Telegram features, Supabase/file-fallback behavior, and vanilla-JS UI.

Market data and paper/informational tracking only. No order placement, broker automation, account-setting changes, or unnecessary portfolio access. Secrets stay in backend environment variables. Never print tokens, authorization headers, or token-bearing URLs. Do not change production infrastructure, deploy, or introduce paid services without approval.

The current development checkout is `work`, with earlier phases uncommitted when this phase was proposed. Preserve and inventory that work before creating a migration branch; do not assume `master` contains it. No destructive database resets or unrelated rewrites.

## 8A — Feasibility, permissions and parity

1. Inventory TradingView imports and requests across intraday/swing screeners, history, Nifty, charts, evidence, backfill, backtests and personal reminders. Document the existing data flow.
2. Verify the current official endpoint documentation and Analytics Token support. Configure `MARKET_DATA_PROVIDER` and backend-only `UPSTOX_ACCESS_TOKEN`; document generation, expiry, revocation and rotation. The token is read-only, documented as valid for one year, with one token per account. Do not introduce OAuth without an identified unsupported requirement.
3. With credentials available, verify an equity quote, 5-minute historical/current-day candles, daily history, and the Nifty 50 spot instrument. Separately test the intended cloud host. Mocked tests do not establish authenticated connectivity.
4. Confirm account entitlements and permitted display/storage/redistribution for the private 10–20-person application, including raw charts/quotes and derived alerts. Free API access alone does not establish those permissions. If unresolved, keep multi-user rollout blocked while independent implementation/testing can continue.
5. Produce a field-parity matrix: source, formula, units, lookback, refresh cadence, missing-data policy and expected vendor differences. Cover relative volume, average volume, ATRP, daily change, SMA/EMA, RSI, VWAP, 52-week levels, weekly/monthly/three-month performance, market cap, sector, instrument eligibility and ranking.
6. Do not assume the instrument master contains fundamentals/sector data or that all fields lack an Upstox source. Inspect current supported quote/fundamental/classification endpoints. Any unresolved field needs a verified supplementary source or an explicitly approved limitation. Never silently remove a filter or substitute a different metric.
7. Establish request/storage budgets for cold startup, steady scanning, charts, outcome evaluation, personal reminders and backfills. Respect per-API/per-user second, minute and 30-minute limits across all workers sharing credentials. Document a headroom margin and cold-cache recovery time.

Deliverable: feasibility report with verified facts, unresolved items and explicit parity decisions. No default-provider switch at this milestone.

## 8B — Provider and REST data foundation

- Introduce a narrow provider interface adapted to existing calls: historical candles, current-day candles, batched live quotes, index data, instrument mapping, health and later subscriptions.
- Use JSON instrument masters and stable instrument keys; validate segment/type and reject ambiguous symbols. Maintain explicit Nifty spot mappings, not futures/ETF substitutions. Account for renamed, suspended and delisted instruments.
- Implement historical V3 and current-day intraday V3 with documented date windows and URL encoding. At review time, 5-minute requests have a one-month window and daily requests a ten-year window; recheck before coding.
- Normalize candles into the existing OHLCV shape with Unix-second start timestamps. Sort, deduplicate, validate OHLC relationships and volume, and retain provenance. Do not invent absent prices or volume; index volume may be unavailable.
- Merge history/current-day data, backfill gaps, and use the shared IST exchange calendar and configurable completion/publication delays. Preserve Phase 0 completed-daily-bar handling.
- Verify adjusted/unadjusted data and corporate-action handling before computing long-lookback indicators. Never silently mix adjustment policies.
- Cache incrementally in memory and Supabase with additive migrations. Unique identity: provider + instrument key + interval + candle start. Store fetch time/adjustment-policy metadata and upsert deterministically. Avoid storing vendor data under indistinguishable TradingView keys.
- Coalesce requests and share caches across charts, scans, evidence, replay and reminders. Separate current spot-index percentage change from completed daily index returns.
- Implement bounded timeouts/retries with jitter, Retry-After handling, concurrency controls and per-window throttling. Auth failures stop retry storms. Stale cache can support labelled historical display, never fresh alerts.

Deliverable: offline contract tests plus authenticated REST checks when credentials are available. Keep TradingView as the active provider until validation gates pass; any fallback must be explicit and visible.

## 8C — Internal screeners and controlled comparison

- Build a two-stage pipeline: lightweight universe discovery from batched quotes/metadata and cached daily metrics, then detailed candle evaluation for candidates.
- Preserve current thresholds and formulas unless an evidenced correction or parity limitation is documented and approved. Instrument eligibility must exclude unintended instruments.
- Preserve quote/discovery polling schedules. Run candle-based signal evaluation once per newly completed bar; retain explicitly quote-based cross-cycle momentum behavior.
- Use one captured clock per evaluation and input freshness checks. Missing/stale index data must not look freshly updated or silently weaken an enabled gate; document the chosen unavailable-input policy.
- Run provider comparisons for matched instruments, dates, timeframes, corporate-action policy, universe eligibility, ranking and calculated signals. Record explanations for material differences.
- Only one active provider may emit operational alerts or mutate shared paper-position state. Comparison runs produce isolated reports.
- Preserve deterministic signal identity/deduplication across retries/restarts without incorrectly merging observations from different feeds. Retain provider provenance in compatible context/storage metadata.

Deliverable: parity/coverage report, measured request usage and restart tests. Exact vendor equality is not assumed.

## 8D — Streaming and data health

- Add Market Data Feed V3 after the REST/scanner foundation is validated.
- Decode the official versioned Protobuf schema; manage subscriptions, unsubscribe, heartbeat, exponential reconnect with jitter and bounded recovery.
- Verify applicable connection/subscription limits and token authorization. Share one owned feed process rather than opening one upstream connection per browser.
- Use streaming for supported quote freshness/price updates. Final scanner candles remain authoritative REST candles unless a separately verified aggregation model is approved.
- Reconcile after reconnect and backfill missing intervals. Prevent duplicate connections within a process; multiple replicas require a scheduler/feed ownership guard aligned with Phase 6.
- Expose safe provider/connection status, last quote/candle observation, last completed scan, and live/cached/stale state. Do not label zero-volume instruments stale solely because the last trade is old; distinguish transport health, quote timestamp and candle availability.

Deliverable: reconnect/subscription/freshness tests and authenticated feed verification, separately reported.

## 8E — Staging, cutover and rollback

Before switching the default provider, define numerical acceptance thresholds in the feasibility report and validate them on staging:

- Required screener fields and approved limitations accounted for.
- Candle coverage, completion timing, freshness and corporate-action behavior checked.
- Request budgets and cache behavior measured under cold/warm conditions.
- Both strategies, Nifty gates, UI charts, evidence, backtests and personal reminders verified.
- Auth expiry, provider outage, reconnect, restart and deduplication tests pass.
- No secrets in logs/frontend; no orders or broker mutations.
- Data-use permissions resolved for the intended audience.

Keep all-in-one and split deployment supported. Official no-static-IP support is promising but is not proof of cloud connectivity. Retain split operation until hosted data retrieval and ownership are verified. If consolidation is later chosen, document exactly which process owns scanning, streaming, evidence and personal reminders.

Change `MARKET_DATA_PROVIDER=upstox` by an explicit configuration cutover after validation, with production approval. Retain provider-separated cache/history and a documented rollback configuration; rollback must not mix caches, re-emit old alerts or destroy journal data. Remove obsolete TradingView dependencies only after the rollback window is agreed.

## Tests and reporting

Use fake credentials and recorded/synthetic provider fixtures in tests. Cover token failures, instrument identity, candle shapes and ordering, timezone/session boundaries, special sessions, missing/partial candles, null volume, splits, chunking, rate windows, retries, cache upserts, process recovery, signal parity, alert deduplication, SSE/API contracts and UI behavior. Run the complete existing suite and relevant browser tests.

Report separately:

1. Implemented.
2. Verified with automated tests, exact commands/results.
3. Verified with authenticated Upstox requests, including execution host.
4. Not yet verified, with exact remaining steps.

No real Upstox token, entitlement, data-use permission or live response was verified during proposal review. This document authorizes no production deployment and records no implementation success.

## Official references

- Analytics Token: https://upstox.com/developer/api-documentation/analytics-token/
- Historical V3: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
- Intraday V3: https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/
- Market Data Feed V3: https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- Instruments: https://upstox.com/developer/api-documentation/instruments/
- Rate limits: https://upstox.com/developer/api-documentation/rate-limiting/

Use current official documentation at implementation time; do not assume every service uses V3 or hardcode plan-specific limits without checking.
