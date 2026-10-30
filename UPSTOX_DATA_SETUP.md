# Upstox universe, corporate actions and screener comparison

Implemented for the existing CommonJS app. No orders, broker mutations or automatic
provider cutover. The admin workflow runs on the existing Render free service;
it requires the configured Supabase database and backend Analytics Token.

## What changed

- `src/marketData/universe.js` imports NSE's daily MCAP report, joins the active
  Upstox NSE_EQ/EQ instrument master by symbol/ISIN, and obtains sectors from the
  official Upstox company-profile endpoint. No company cap is fabricated from the
  profile's **sector** market cap. Full mapped-equity coverage is required; a
  missing row or classification blocks publication rather than silently dropping
  a stock. NSE_EQ/EQ is an explicit scope difference from legacy TradingView
  filters that may include preferred shares, depositary receipts or other types.
  The generated scope is `NSE_EQ_EQ_COMPANY`: company INE identifiers are required;
  known INF fund units in EQ series are listed as out-of-scope rather than given
  invented company sectors. An unavailable company MCAP row still blocks coverage.
- CSV dates, headers, duplicates, prices/shares/capitalisation consistency and
  source age are validated. ZIP extraction accepts only the exact dated MCAP
  member, limits sizes and never writes archive paths. Original report URLs,
  trade dates, hashes, INR units and per-field provenance are retained.
- Sectors/profiles are cached for seven days. NSE cap snapshots retain their
  original source date, with a seven-day maximum age. A completed session's
  report may not yet be published: preparation tries up to three prior trading
  sessions on HTTP 404. Active scanners refresh generated metadata as sessions
  advance. A temporarily inaccessible source can defer refresh for 15 minutes
  while using a still-valid original snapshot; its date is never advanced.
  An expired snapshot cannot support scanning.
- Generated files default to `SWING_DATA_DIR/upstox/universe.json`. Profiles,
  reports, universe and comparison are also mirrored into existing
  `scanner_state` rows. Restart recovery uses Supabase if local files disappear.
  Universe and comparison publication also await explicit database commits before
  the job reaches review-required. No new migration is needed. A changed symbol/ISIN universe requires another
  comparison before the generated manifest is used for scanning.
- `src/marketData/corporateActions.js` checks the official corporate-actions
  endpoint on equity history reads, including warm-cache reads. Results refresh
  at least hourly and across IST dates. Split, bonus, rights and unknown
  non-dividend actions inside the requested history, with a minimum 250-session
  lookback, through today's IST date
  quarantine that symbol. Invalid/missing action data fails closed. Indices do
  not use equity ISIN actions. Short personal-reminder/chart requests retain the
  same minimum action lookback; a two-bar fetch cannot clear a known quarantine. No split ratios are guessed and no candles are
  rewritten. Existing personal positions/reminders also cannot consume a
  quarantined equity history.
- The owner selected **exclude affected stocks and show exclusions** on 30
  October 2026. Reports contain each excluded symbol, action category and date.
  Cash dividends retain provider-native prices; returns are not total returns.
  This policy does not certify every vendor's dividend adjustment methodology,
  reconstruct historical universe membership or establish backtest parity.
- `screening.js` centralizes completed-daily metrics and unchanged threshold
  values. It preserves the documented ten-session volume mean, Wilder ATR14
  divided by current price, completed-close SMA50/200, five/21/63-session
  performance approximations and available 250-session high/low range. These
  definitions can differ from vendor screener definitions and must be reviewed.
- Discovery lists missing/invalid/stale quotes in `quoteExclusions`. Individual
  unusable histories are quarantined with fixed reasons and gap dates; strict
  direct/index reads still fail, and auth/network outages remain fatal rather
  than becoming an empty market. These are visible data-availability exclusions,
  not fabricated bars or a permanent whitelist.
- Daily cache entries can survive six hours while their last completed session
  remains correct. New completed sessions force refresh. Intraday cache lifetime
  remains short. Full history plus action checking is coalesced so concurrent
  readers cannot bypass an unfinished audit.
- Discovery quotes are refreshed after cold history preparation before final
  filters run. Live-session quotes must be within 60 seconds. Outside live
  hours, only the latest trading session's final five-minute quote window is
  accepted; it is a closed-session snapshot, not a live tick. Prior-session or
  older snapshots at the next open are revalidated, including cache hits.

## Official sources checked

- [NSE CMTR60423: MCAP report format](https://nsearchives.nseindia.com/content/circulars/CMTR60423.pdf)
  specifies `MCAPDDMMYYYY.csv` in the PR archive, `Issue Size`,
  `Close Price/Paid up value(Rs.)` and **`Market Cap(Rs.)`**. This field is INR,
  not lakhs/crores; the importer validates cap against issue size times close.
- [NSE ETF EQ-series example](https://www.nseindia.com/get-quote/equity/NIFTYBEES/Nippon-India-ETF-Nifty-50-BeES):
  EQ series alone is insufficient to identify company shares.
- [NSE All Reports](https://www.nseindia.com/all-reports): CM – Bhavcopy (PR.zip).
- [Upstox company profile](https://upstox.com/developer/api-documentation/get-company-profile/):
  sector classification; its sector cap is intentionally ignored.
- [Upstox corporate actions](https://upstox.com/developer/api-documentation/get-corporate-actions/):
  effective dates, event categories and details.
- [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/):
  read-only Fundamentals and market-data access without a static IP.

Source documentation is verified; real fundamentals/report access using the
owner's Render deployment still requires the workflow below.

## Render workflow — no Shell

1. Keep `INGEST_MODE=true`, both scanner toggles false and the existing provider
   while preparing. Remove `UPSTOX_CHECK_ON_START` so its separate diagnostic
   process does not compete for token quota. Keep the real token backend-only.
2. Sign in as admin and open `/personal`. Under **Upstox data setup**, click
   **Prepare universe and compare**. Click **Refresh status** to inspect progress.
   This starts one background job, guarded by the existing scanner worker lease.
   It does not journal signals, change paper positions or send alerts.
3. The first full-universe build can take a long time due to API limits and
   upstream latency. Profile/report caches survive restart through Supabase.
   An interrupted job is shown as interrupted; retry resumes cached data.
   Keep the service awake using the already configured market-window pinger;
   this feature adds no self-pings or outside-window keepalive traffic.
4. If the job reports `UPSTOX_METADATA_SOURCE_FORBIDDEN` or source unavailable,
   download **CM – Bhavcopy (PR.zip)** from NSE All Reports for a recent completed
   trading day. Expand **If NSE blocks the server download**, select its date,
   upload the original ZIP, attest its source and retry preparation. The upload
   is admin-only/same-origin and stored with its source date/hash, not treated as
   independent certification of its download origin.
5. If coverage is incomplete, inspect the exact missing symbols/reasons. A partial
   build does not replace the previous valid universe. Do not invent missing
   market caps, rename sectors to force a match or approve a silent whitelist.
6. When the job reaches **review-required**, expand the report. It compares the
   actual existing NSE TradingView candidate filters with Upstox candidates in
   all three modes, and shows only-in-one-feed symbols, field differences,
   sector differences, exclusions and matched sample counts.
7. The quote/baseline capture occurs after warming daily history and within a
   maximum 60-second observation window. Feeds are **not simultaneous ticks**.
   Review tolerances are displayed per field, not hidden; no match or fewer
   than 30 matched candidates warns rather than proving parity. Formula,
   classification, scope and current/complete-candle differences remain visible.
   The report never sets `approved=true`, the environment approval flag, or the
   active provider. Review multiple sessions before relying on comparisons.

If TradingView blocks cloud baseline access, the comparison reports
`UPSTOX_COMPARISON_BASELINE_UNAVAILABLE`. The generated metadata remains available,
but a generated universe cannot start operational scans without a completed
comparison report. Remote access failure is not recorded as a passing comparison.

## Cutover after reviewing the real report

The owner must explicitly accept the documented screener-definition differences
and resolve the intended private multi-user data permissions. No code flag can
certify vendor equivalence or grant provider permission. Then configure Render:

```dotenv
MARKET_DATA_PROVIDER=upstox
UPSTOX_SCREENING_APPROVED=true
INGEST_MODE=false
ENABLE_INTRADAY=true
ENABLE_SWING=true
ENABLE_OUTCOMES=true
UPSTOX_STREAM_ENABLED=false
```

The default universe path needs no environment key. If a path override is desired,
set `UPSTOX_UNIVERSE_FILE=/app/data/upstox/universe.json` before preparation and keep
it the same for cutover. `UPSTOX_DATA_USE_CONFIRMED=true` records only an actual
owner confirmation; the existing launch checker still reports that separately.
Keep private mode, origin, DB credentials and Telegram settings configured.
Do not simultaneously run the previous local scanner with the same token/state.
Streaming remains disabled pending its separate live validation.

Review saved sector alert preferences after cutover: Upstox classifications can
differ from TradingView. Confirm scanner/provider status and a completed scan, both strategies, chart
access and restart recovery on the actual host. Render sleeping, full-universe
latency/resource use, data-source failures and Telegram connectivity are separate
production concerns. Paper/informational only; no slippage, fees or order execution.

## Rollback

Return to `INGEST_MODE=true`, disable scanner toggles and restore the previous
provider configuration. Keep journal/account data and all additive state rows.
This restores the hosted ingest UI; a TradingView feed requires its separate
working scanner host. Do not delete worker leases or reset tables to force cutover.

## Automated verification

```bash
node test-upstox-preparation.js
node test-upstox-admin.js
npm test
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

Tests use synthetic source archives, provider payloads and account stores. They
cover units/provenance, malformed ZIP/CSV/dates/duplicates, incomplete coverage,
caching/recovery/age limits, real history quarantine wiring, concurrent audits,
strict thresholds, closed-session quote freshness, read-only comparisons,
background-job dedupe/error sanitization, admin/friend/anonymous authorization,
same-origin writes, binary imports and desktop/mobile UI. They do not certify
live NSE downloads, full Fundamentals coverage, performance or screening parity.

## NSE report close precision correction

The owner's original 29 October 2026 PR archive contains 2,366 EQ rows. Fifteen
failed the original relative-only cap check: for example FILATFASH displays
0.15 while cap / issue size implies 0.17. The largest observed absolute implied
price difference across that report is approximately 0.02 INR. Import validation
now accepts either the original 1% relation or an absolute difference of at most
0.025 INR (plus numerical epsilon), with an implied/displayed price ratio bound
of 0.5–1.5. This is a bounded compatibility rule for the observed display precision,
not a claim that every NSE report always uses the same rounding policy. Large
unit mismatches still fail. Reported company caps are retained verbatim; no prices
or capitalisations are repaired. A three-row real-data regression fixture is
included; the full uploaded archive is not committed. Import success/failure
is now displayed next to the import button as well as the page-level status.

A recent imported report is also considered during initial preparation if the
newer completed session's archive cannot be reached. The original date/hash are
preserved and the report records the requested date and download failure reason.
Only the prior three trading-session candidates are searched, and the existing
seven-day validation still applies. This avoids demanding another upload merely
because preparation crosses the daily completion cutoff.

## Screener and corporate-action review (#2)

Preparation compares intraday, early and swing NSE candidates against TradingView within the existing maximum 60-second capture window. The report now evaluates all 14 numeric fields: price, daily change, relative volume, ten-session average volume, ATR%, company market cap, SMA50, SMA200, three-month return, volume, weekly/monthly returns and 52-week high/low. Sector must be present and match. Missing fields, unmatched candidates and differences outside documented review tolerances prevent a mode from reporting `withinReviewTolerances`. Fewer than 30 matches always produces a sample warning; no matches is not a passing comparison. These are review thresholds, not guarantees of equivalence.

`checks` in the report describes the comparison fields, metadata exclusions and corporate-action coverage. Preparation audits histories of price-eligible candidates; this is not a claim that every stock has been audited. The live history path rechecks corporate actions for stocks it subsequently evaluates. The minimum audit window is 250 trading sessions. Splits, bonus, rights and unknown non-dividend actions quarantine the affected history; invalid corporate-action data is also excluded. Authentication/network failures stop the operation rather than appearing as an empty market. Cash dividends remain provider-native and returns are not total returns. No split factors or adjusted prices are guessed.

The report always remains `review-required` with `approved:false`, including when all observed comparisons pass. Read the per-mode failures, unmatched lists, structural exclusions and source dates before making a provider cutover decision. Stock exclusions requested by the owner do not exempt other stocks from corporate-action checks. No order placement or automatic provider switching occurs.

Local fixture tests verify this behavior. Authenticated production comparisons, exchange/provider corporate-action payloads and production scanner worker behavior remain unverified until the deployed preparation job completes and its report is reviewed. No new migration or environment setting is required.

Comparison evidence is versioned as `reviewVersion:2`. Older comparison artifacts must be regenerated by rerunning preparation before scanning; universe data and signal schemas are unchanged, and no SQL migration is needed.
