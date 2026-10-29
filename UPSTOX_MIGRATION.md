# Upstox migration — implementation and launch gates

Branch: `phase8-upstox`, preserving earlier uncommitted phase work. No deployment or production setting has been changed. TradingView remains the default until an explicit verified configuration cutover.

## Implemented

- Existing `getHist`, screener and Nifty consumers dispatch through `src/marketData` when `MARKET_DATA_PROVIDER=upstox`. Existing REST/SSE signal field names remain compatible. New journal writes include provider provenance in context.
- Read-only Analytics Token via backend `UPSTOX_ACCESS_TOKEN`; sanitized auth errors and blocked retry loops after 401/403. No OAuth/order/portfolio actions.
- JSON NSE instrument-master lookup, explicit Nifty 50 spot mapping, segment checks and ambiguous-symbol rejection.
- Historical/current-day V3 candles, 28-day intraday date chunks, chronological normalization, overlap merging, validation, index null-volume preservation and configured publication delay. Completed daily bars use Phase 0's cutoff. Same-session intraday gaps and daily-session gaps fail closed; intraday stale histories are rejected during the session.
- Shared provider instance, per-instrument in-flight coalescing, short quote/history caching, persistent provider-specific local files and Supabase `scanner_state` snapshots. REST request admission budgets reserve headroom: 40/sec, 450/min, 1,800/30min per process. Retries respect Retry-After and use bounded backoff/jitter. This conservative shared budget is not a distributed cross-host quota service.
- Two-stage screening: fresh batched quotes, then cached daily history for candidates. Market-cap/sector/eligibility metadata is mandatory. Enabling screening requires explicit formula/parity approval and a fresh sourced universe file.
- Optional V3 LTPC stream with the official Upstox schema, binary subscription requests, unsubscribe, transport watchdog, sanitized errors, bounded reconnect and a 500-instrument conservative cap. Stream state is exposed in market status. REST remains the authoritative scanner/candle source; stream snapshots are quote-only and do not synthesize OHLCV. Stream samples are currently diagnostic; they are not a replacement for REST screening snapshots or a dedicated browser tick feed.
- Supabase worker lease for Upstox scanner/personal-worker startup, renewed every 30 seconds, 120-second expiry. Ownership loss stops the process. Upstox worker mode requires the lease migration/database; API-only deployments do not acquire a scanner lease. Configure only one credential-owning worker host.
- Persistent push signal outbox: atomic fsynced local writes plus best-effort Supabase state mirror, restart merging, in-flight preservation, retry and producer event-key deduplication. Ingest skips known producer keys in the recent journal or database. Legacy producers without stable event keys remain accepted, without guaranteed idempotency.
- Shutdown starts a force-exit deadline before draining workers, stops the stream and releases its lease.

## Required migration/configuration

Apply all prior account/evidence/preferences migrations as relevant, then:

`supabase/migrations/202610290002_worker_leases.sql`

Local scanner credentials belong only in `.env` or protected backend settings. Hosted credentials belong in Render environment settings. Never paste tokens into chat or commit them.

```dotenv
MARKET_DATA_PROVIDER=upstox
UPSTOX_ACCESS_TOKEN=<set privately in backend settings>
UPSTOX_FINALIZATION_DELAY_MS=10000
UPSTOX_SCREENING_APPROVED=false
UPSTOX_UNIVERSE_FILE=/absolute/path/to/verified-universe.json
UPSTOX_STREAM_ENABLED=false
UPSTOX_STREAM_SYMBOLS=NIFTY
```

Generate the token in the Upstox Developer Apps Analytics tab; record its expiry privately. Replace/revoke through that console when rotating, update backend settings, and restart so a previous auth-rejection circuit is reset. Only one Analytics Token is supported per account. No order permissions or daily OAuth flow are introduced.

The sourced universe file has this structure (illustrative metadata, **not usable production data**):

```json
{
  "source": "Describe the verified metadata source and universe selection",
  "asOf": "ISO timestamp no older than seven days",
  "adjustmentPolicy": "verified",
  "stocks": [
    {"symbol": "RELIANCE", "marketCap": 1, "sector": "Replace with sourced classification", "eligible": true}
  ]
}
```

All market-cap values are INR. The file must be available on the scanner host and refreshed as needed. A file is not proof of correct metadata; review its source and coverage. Narrowing to a small whitelist changes the universe and must be explicitly accepted. Do not set the approval flag merely to suppress an error.

## Screening parity decisions still required

| Field | Implemented definition/source | Remaining decision |
| --- | --- | --- |
| Price/change | Fresh V3 quote and previous session close | Verify quote timestamps and live examples |
| Average volume | Mean of last ten completed daily volumes | Confirm matches intended TradingView definition |
| Relative volume | Current cumulative volume / previous ten-session average | Verify TradingView semantics; no assumption of exact parity |
| ATRP | Wilder ATR14 / current quote price × 100 | Validate vendor smoothing/denominator differences |
| SMA50/200 | Completed daily closes | Compare to screener's current-day inclusion |
| Three-month performance | Last completed close / close 63 bars earlier − 1 | Fixed-session approximation requires approval |
| Market cap/sector/eligibility | Required sourced manifest | Automated verified metadata ingestion is not implemented |
| Corporate actions | Provider-native values, explicitly unverified | Validate adjustment policy before approval |
| Universe | Manifest-listed NSE equities mapped to master | Historical membership and full-market parity not proven |

The supplied live quote schema and instrument master do not establish a complete field-parity solution by themselves. Never remove missing filters silently. Private 10–20-user display/alert permissions and account entitlements still need confirmation with the provider.

## Request/storage budget and limitations

A warm 150-symbol one-candle-request-per-five-minutes design uses about 900 requests per 30 minutes before extra workloads. Cold universe screening can require hundreds/thousands of daily history requests; the limiter deliberately waits, so cold startup may take much longer than one normal scan cycle. Chart, outcome, backfill and reminder jobs share this process's budget, but do not yet have priority/fairness scheduling. Persistent state snapshots can grow to 10,000 bars per instrument/interval; normalized candle-table pagination, retention, cross-process cache sharing and large-universe load qualification remain unfinished.

The instrument master refreshes daily and persists a shared snapshot; automatic fundamental enrichment remains unfinished. Live discovery is quote-filtered before daily technical requests, but exact full-universe equivalence to TradingView is not certified. Five-minute signal functions are still called by the existing tick loop, with cached completed bars; a separate once-per-new-bar evaluation scheduler has not been implemented.

The durable outbox is backed by the scanner's persistent local data directory with an asynchronous database mirror. Ephemeral local storage plus an unflushed database write can still lose the newest records. This is not a transactional database outbox. Concurrent ingest arrivals are not transactionally serialized with journal append/broadcast; database uniqueness protects persisted events but exactly-once local/SSE effects under concurrent races are not guaranteed.

Do not launch multiple independent hosts using the same token: the lease guards this application's configured workers, not unrelated tools, browser-only REST processes, or another application using the account. There is no global account quota coordinator. A stale/unverified NSE calendar can reject valid sessions; verify the year's calendar before launch.

## Exact validation commands

```bash
npm test
npm run test:browser
npm run check:upstox
```

The first two use synthetic fixtures/local servers and establish no live provider success. `check:upstox` needs a real backend token and reachable instrument master/API. It performs quotes and completed 5-minute/daily histories for RELIANCE and Nifty, printing prices/counts/timestamps but never credentials. It must succeed on the actual intended host. An authentication success alone does not prove screeners, streaming, redistribution permissions or corporate-action parity.

Verify both scanners against the approved universe in staging, enable the optional feed only after authenticated authorization/subscription/reconnect checks, and inspect `/api/public/market/status` and authenticated health. Exercise restart, lease-loss, token-expiry, network-outage and cache-recovery behavior. Confirm no duplicate signals/alerts before inviting friends.

## Tonight's cutover and rollback

**This code is not certified launch-ready merely because tests pass.** Live token checks, official calendar verification, parity/universe approval, migration execution, resource usage and private-data-use permissions remain gates. No authenticated Upstox request succeeded during implementation because no token was configured in the execution environment.

Until those checks pass, keep the currently verified deployment/provider configuration. If staging is approved for cutover, change the provider explicitly and restart exactly one worker. Keep split deployment supported and do not assume Render has working API/WebSocket egress without testing it there. No paid infrastructure has been added.

Rollback: stop the Upstox scanner/feed, release/expire the lease, restore `MARKET_DATA_PROVIDER=tradingview`, disable streaming and restart one worker. Retain provider-separated caches/journal provenance. Do not run both providers' alert-producing workers simultaneously or reset production tables. Supabase schema additions can remain; no destructive rollback is needed.

Sources: official [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/), [historical V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/), [intraday V3](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/), [quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/), [rate limits](https://upstox.com/developer/api-documentation/rate-limiting/). The vendored schema is from Upstox's official Python repository `examples/websocket/market_data/v3/MarketDataFeedV3.proto`; recheck schema updates before enabling production streaming.

## Readiness hardening update

Instrument-master downloads are now coalesced and persisted across restart. Candle
freshness is checked against the last expected completed bar/session even on warm
cache hits and outside market hours. A candle closing inside the short cache TTL
forces refresh. Candidate quotes that expire while daily history is being loaded
cause the scan to fail closed rather than emit alerts from an old snapshot.

```bash
npm run launch:check
npm run launch:check -- --live
npm run compare:screeners -- baseline.json candidate.json
```

The launch checker prints only configuration presence and actionable checks, never
credential values. The default command performs no live calls. `--live` checks
required database tables and equity/index quote/history samples on the executing
host. A successful report is not deployment approval, proof of exact screener parity,
or legal/data-use certification. `UPSTOX_DATA_USE_CONFIRMED=true` records the owner's
confirmation only after actual permissions have been resolved.

Offline comparison inputs must have matching `asOf` timestamps and `stocks` objects
keyed by symbol. Reports expose added/removed symbols, sector mismatches, numeric
differences and missing fields; no tolerance or parity approval is fabricated.
The authoritative current status is the latest readiness report and test results,
not the earlier proposal's target-state diagram.
