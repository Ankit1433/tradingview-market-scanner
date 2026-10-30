# Scanner worker verification (#3)

`npm run test:workers` exercises the actual intraday, swing and outcome schedulers using synthetic market data and an injected clock. It verifies intraday discovery during market hours, a post-close swing pass, same-day swing deduplication, outcome evaluation/save/forwarding, next-run timestamps, duplicate-start protection and shutdown. This is part of `npm test`. It does not contact Upstox, send Telegram messages or place orders.

## Admin activity endpoint

After deployment, sign in as admin and open `/api/account/admin/workers`. Anonymous requests receive 401; friends receive 403. It reports each worker's running/active flags, cycle counts, last-start/finish/failure times, next-run time and most recent activity. No tokens, capital, prices or personal trade details are returned. This additive endpoint requires no migration.

Counters belong to the current process and reset on restart. A completed tick includes waiting for market hours, a holiday or the swing schedule; it is not proof that any signal was generated. `discoveryFetch` shows intraday discovery returned; `scanPass` shows a swing orchestration pass returned; `evaluated` counts outcome records processed. Zero candidates or zero outcomes can be valid. Failure counts and the normal logs must also be checked: existing scanners can catch individual errors and continue, so a finished tick or scan pass alone does not establish full data coverage.

## Production procedure (pending)

Do not enable scanning before completing universe preparation and reviewing screener/corporate-action evidence. Do not deploy while preparation is running.

Once approved and deployed with `MARKET_DATA_PROVIDER=upstox`, `INGEST_MODE=false`, `ENABLE_INTRADAY=true`, `ENABLE_SWING=true`, `ENABLE_OUTCOMES=true`:

1. During an NSE trading session, inspect the endpoint twice across an intraday cycle. Confirm running=true, increasing ticks and a recent discoveryFetch, with no continuing failures. Check provider/data errors in Render logs and the timestamps of any new journal signals. An empty signal set does not itself indicate failure.
2. After the configured swing scan time (default 15:45 IST), confirm a scanPass for that IST date. Check the swing logs and candidate coverage. Polling before that time should show ticks without a scan pass. Same-day repeats should not create another daily scan.
3. With eligible journal signals available, inspect the outcome worker across its 15-minute interval. Confirm recent evaluated activity and inspect `/api/public/outcomes/stats` and an eligible event's `/api/public/outcomes/{eventKey}`. Incomplete forward horizons can legitimately remain pending; confirm coverage rather than interpreting missing results as zero returns.
4. Confirm only one scanner owns the worker lease. Existing lease/handoff tests cover duplicate-replica exclusion locally; production ownership still requires observation.

When `INGEST_MODE=true`, all three scanner workers are intentionally disabled on that host. If only an ingest host is running, enabling the UI does not start a scanner. Outside the NSE session, intraday ticks may simply wait; swing remains scheduled after close. The outcomes worker processes evidence independently of the intraday session window when started.

A production deployment and observations above are still required before declaring live workers verified. These local changes do not enable scanners, approve data use or alter Render settings.
