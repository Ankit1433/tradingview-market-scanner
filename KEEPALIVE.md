# Render scheduled keepalive

Scanner heartbeats to `/api/ingest/heartbeat` are permitted only Monday–Friday,
08:55:00–15:45:00 Asia/Kolkata, excluding dates in the shared NSE holiday calendar.
The default minimum interval is eight minutes. Configure on the **scanner**:

```dotenv
KEEPALIVE_WINDOW=08:55-15:45
KEEPALIVE_INTERVAL_MS=480000
```

The window must be same-day `HH:MM-HH:MM`; invalid configuration fails at startup.
The interval is milliseconds, a safe integer at least 1,000. A local timer checks
eligibility every second, but emits no heartbeat request outside the window or
before the interval elapses. Startup within the window sends an eligible heartbeat
immediately. Request attempts are spaced even after failure; overlapping heartbeat
requests are suppressed. `PUSH_URL` and its matching push/API key remain required.
Weekends remain excluded even if a special weekend trading session is configured.
The 2025/2026 equity holidays and known special sessions were checked against official NSE circulars on 30 October 2026. Review CALENDAR.md for sources and the pending November 8 special-session timings.

This controls **keepalive traffic**, not legitimate signal/position/evidence pushes,
user visits or other background jobs. It does not force Render to sleep, guarantee
uptime, or eliminate cold-start delays. A sleeping service cannot reliably wake
itself; use the running local scanner or an external scheduler. No production
Render or cron-job.org configuration was changed by this implementation.

## cron-job.org setup/check

1. Sign in to cron-job.org and inspect the existing job list before creating a duplicate.
   Check that the job is enabled, its execution history, last/next execution,
   timezone, timeout, HTTP status, and failure/disable notifications.
2. Target **GET** `https://YOUR-SERVICE.onrender.com/api/public/market/status`.
   In private mode, add the existing `x-api-key` as a protected custom request header.
   Never put it in the URL or commit it. This key also authorizes machine admin
   actions, so restrict access to the cron-job.org account. A missing key produces
   401; a browser login cookie is unsuitable for unattended pinging.
3. Choose **Asia/Kolkata**, Monday–Friday, and explicit custom execution times.
   One simple schedule uses three jobs (cron notation shown for clarity; select
   matching fields in the site's custom schedule UI):

```cron
55 8 * * 1-5
5,15,25,35,45,55 9-14 * * 1-5
5,15,25,35,45 15 * * 1-5
```

   This pings at 08:55, then every ten minutes through 15:45 IST. The external
   interval is independent of the scanner's eight-minute default. Disable any
   old all-day/duplicate job and any scheduler retries that would run off-window.
   If KEEPALIVE_WINDOW is changed, update these external schedules too.
4. **Holidays:** a fixed weekday cron expression cannot consult AnkQuant's holiday
   calendar. Pause all three jobs before each NSE holiday and resume afterward,
   or use an external calendar-aware scheduler that checks the same calendar
   locally *before* sending a request. Do not call the hosted API to decide whether
   it should be called: that already generates holiday traffic. Without this step,
   cron-job.org is not compliant with the no-holiday-traffic requirement.
5. Use a timeout sufficient for a cold start if the plan supports it. Run a manual
   test only inside the permitted window on a non-holiday weekday. Verify a 200
   response in execution history; 401 means authentication, 403 may indicate an
   access/proxy restriction, and timeouts/5xx require checking Render logs and
   service health. Check Render's current free-plan rules and account limits.

Your previous cron job cannot be diagnosed from repository files. Private mode
was added since the earlier public setup, so missing authentication is one
possible cause, not a verified diagnosis. An enabled job with the wrong timezone,
failed cold-start requests, or disabled failure retries are other things to inspect.

## Persistence verification

`npm run test:keepalive` tests pre-window, start, midday, end, post-window, both
weekend days, a configured holiday, window override, interval suppression and
invalid configuration with injected timestamps.

It also uses the **real Supabase REST adapter and journal serialization/hydration**
against a local HTTP fake: connect, record an event, flush its database write,
delete local files, reload the journal module, hydrate from database rows, and
compare event identity, timestamp and levels. This proves the adapter-backed
restart path under simulation; it does not prove persistence in your real project.

For live verification: apply existing migrations, configure backend Supabase
credentials, verify authenticated health reports Supabase, record a controlled
paper signal, restart/redeploy, then confirm the same event key and timestamp
remain in the journal. Do not mistake local-file recovery for database recovery.
No real Supabase credentials or production restart were used in the automated test.
