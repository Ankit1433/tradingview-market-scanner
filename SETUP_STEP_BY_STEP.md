# AnkQuant — step-by-step setup from the completed phases

This guide is for the combined implementation on `phase8-upstox`. A local commit is
not a GitHub push or deployment. Phases 0–5 have code/tests, Phase 6 is partial,
Phase 7 CI/load work remains, and Phase 8 is guarded/partially implemented.
Real Supabase/Telegram/Upstox checks remain necessary. Do the staging checks before
inviting friends. No broker orders are placed.

## 1. Get the committed code and install

Open a terminal in your repository folder. Use Node matching `.node-version` if
available; `package.json` requires Node 18 or newer.

```bash
git switch phase8-upstox
npm ci
npm test
```

Optional real-browser fixture test (Chromium must be installed):

```bash
npm run test:browser
```

`npm start` is the application command; it executes `src/index.js`. Do not run
individual `src/jobs/*.js` files directly. The fixture tests require no real tokens.

## 2. Configure Supabase and apply SQL files in order

Open https://supabase.com/dashboard and select/create your project. Back up existing
production data first. Prefer a separate staging project for this first pass.
Open **SQL Editor → New query**. Open each repository SQL file, paste its contents,
and run it **once, in this order**:

1. `supabase/migrations/202610180001_persistent_scanner_data.sql`
2. `supabase/migrations/202610280001_signal_outcomes.sql`
3. `supabase/migrations/202610280002_private_accounts.sql`
4. `supabase/migrations/202610290001_alert_preferences.sql`
5. `supabase/migrations/202610290002_worker_leases.sql`
6. `supabase/migrations/202610290003_personal_alerts.sql`

If an existing project already has some migrations applied, identify those first
and apply only the missing ones. Some account statements are intentionally not
repeatable. Stop on an SQL error rather than resetting tables or blindly rerunning.
Check Table Editor for signals/state/trades/outcomes, accounts/invites/sessions,
preferences, worker leases and `alert_queue`.

Find the project URL and a backend secret key in the project's connection/API key
settings. Use a secret/service-role key, not an anon/public browser key. Put them
only in `.env` or protected backend hosting environment settings.

## 3. Create a local private configuration

```bash
cp .env.example .env
```

Do not overwrite an existing `.env`; edit it instead. Never commit or send it to chat.
For the first local check, set:

```dotenv
PORT=4000
NODE_ENV=development
PRIVATE_MODE=true
PUBLIC_MODE=true
APP_ORIGIN=http://localhost:4000
CORS_ORIGIN=http://localhost:4000
SUPABASE_URL=<your project URL>
SUPABASE_SECRET_KEY=<backend secret key>
API_KEY=<a long randomly generated machine key>
MARKET_DATA_PROVIDER=tradingview
ENABLE_INTRADAY=false
ENABLE_SWING=false
ENABLE_PERSONAL_WORKER=false
ENABLE_OUTCOMES=false
INGEST_MODE=false
SWING_DATA_DIR=./data
SWING_SCAN_TIME=15:45
SWING_BAR_COMPLETE_TIME=15:45
```

Replace placeholders privately. Generate a machine key locally with `openssl rand -hex 32`.
Do not use an example/test key. The machine key authorizes ingest/admin operations;
it is not a friend's login credential. Keep `MARKET_DATA_PROVIDER=tradingview` until
Step 11's Upstox requirements pass.

## 4. Create the first admin

Temporarily add to your local `.env`:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=<your email>
BOOTSTRAP_ADMIN_PASSWORD=<your unique password, 12–128 characters>
```

Then run:

```bash
npm run accounts:bootstrap
```

It runs `scripts/bootstrap-admin.js` against your configured Supabase project.
It works only while the account table is empty. If an admin already exists, log
in instead. Remove the bootstrap password from `.env` after success.

Start the app:

```bash
npm start
```

Open http://localhost:4000/login and sign in. Visit:

- `/app` — scanner dashboard (empty while scanning is disabled).
- `/journal` — shared signal history.
- `/symbol?symbol=RELIANCE` — symbol chart; requires working market-data access.
- `/personal` — own sizing, paper journal, Telegram linking, admin invites.
- `/alerts` — own signal alert preferences.
- `/stats` — paper evidence and personal R statistics.
- `/api/docs` — authenticated API documentation.

Login succeeds without scanning enabled. A chart outage is separate from a login
failure. If login says the account operation is unavailable, check database
configuration/migrations; don't disable private mode to work around it.

## 5. Set up Telegram

Open Telegram and find the official **@BotFather** account. Create a bot with
`/newbot` if needed. Keep the bot token private; record its username without `@`.
Set these backend values on the host that owns the Telegram worker:

```dotenv
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_BOT_USERNAME=<bot username without @>
ENABLE_PERSONAL_WORKER=true
SIGNAL_ALERTS_ENABLED=true
```

Restart the service. In `/personal`, choose **Link Telegram**, open the generated
link, and press **Start** in a private bot chat. Links expire after ten minutes and
are single-use. Reload `/personal` to confirm linking. Configure `/alerts` and save.
No private alert can arrive until a fresh eligible signal exists.

In the private bot chat:

- `/pause` — pause setup/signal alerts.
- `/resume` — resume and clear mute.
- `/mute 60` — mute signal alerts for 60 minutes.

These controls do not disable personal paper-position reminders. Set no shared
`TELEGRAM_CHAT_ID` if you want exclusively private user alerts. Exactly **one**
process may own this bot's getUpdates consumer; the database worker lease guards it.

## 6. Configure Render's hosted API

Open https://dashboard.render.com and select the existing web service. Confirm its
connected repository and branch. **The code must first be pushed to GitHub**; a
local commit alone cannot be deployed. After reviewing the commit, you can run:

```bash
git push -u origin phase8-upstox
```

This guide does not push, merge to master, or deploy for you. Select the intended
branch deliberately in Render. Use build command `npm ci --omit=dev`, start command
`npm start`, and health check path `/healthz`.

For split deployment, configure the hosted API's protected environment settings:

```dotenv
NODE_ENV=production
PRIVATE_MODE=true
PUBLIC_MODE=true
INGEST_MODE=true
ENABLE_INTRADAY=false
ENABLE_SWING=false
ENABLE_OUTCOMES=false
APP_ORIGIN=https://YOUR-SERVICE.onrender.com
CORS_ORIGIN=https://YOUR-SERVICE.onrender.com
SUPABASE_URL=<same project URL>
SUPABASE_SECRET_KEY=<backend secret key>
API_KEY=<same machine key used by the scanner>
MARKET_DATA_PROVIDER=tradingview
ENABLE_PERSONAL_WORKER=true
SIGNAL_ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_BOT_USERNAME=<username>
```

Production login requires HTTPS because its cookie is Secure. APP_ORIGIN must be
exactly the browser origin, with no `/app` path. Use the actual service/custom-domain
URL, not localhost. Do not put bootstrap passwords in permanent Render settings.

**Free-tier note:** the repository's `render.yaml` already specifies a resource plan
and persistent disk; it is not a verified free-tier blueprint. Do not apply it blindly
or create a paid disk. Use the existing free service settings and Supabase durability,
understanding that local files may be ephemeral. Confirm current plan constraints in
your Render dashboard before changes. Keepalive does not guarantee uptime.

In split mode the hosted worker must be independent of the scanner to report
scanner outages. Its personal paper reminders additionally require working candle
access; TradingView may reject cloud IPs. Do not mark those reminders verified until
tested there. Signal delivery can use journal data received from the local scanner.

## 7. Start the local scanner

On your always-on local machine, use the same repository and Supabase project. Its
`.env` differs from the hosted API:

```dotenv
NODE_ENV=development
APP_ORIGIN=http://localhost:4000
INGEST_MODE=false
ENABLE_INTRADAY=true
ENABLE_SWING=true
ENABLE_OUTCOMES=true
ENABLE_PERSONAL_WORKER=false
MARKET_DATA_PROVIDER=tradingview
PUSH_URL=https://YOUR-SERVICE.onrender.com
PUSH_API_KEY=<matches hosted API_KEY>
KEEPALIVE_WINDOW=08:55-15:45
KEEPALIVE_INTERVAL_MS=480000
```

Keep its Supabase settings and machine key configured, then run `npm start`. Leave
this process/machine running during scans. Do not start a second scanner against the
same state. Verify the exchange calendar in `src/config/nseCalendar.js`; current
inherited dates are unverified. Intraday runs during the session; swing defaults to
a completed daily scan after 15:45 IST. Avoid TEST_MODE against real alert users.

Open the hosted `/app` and confirm scanner contact, fresh universe data and provider
status during market hours. An empty universe outside hours is expected. Ingest
mode deliberately runs no local scan loops on Render.

## 8. Check your old cron-job.org job

Open https://console.cron-job.org and inspect existing jobs, enable state, timezone,
execution history and response codes before creating duplicates. Set timezone
**Asia/Kolkata** and target:

`GET https://YOUR-SERVICE.onrender.com/api/public/market/status`

Private mode requires the machine `x-api-key` in protected request headers. Missing
authentication returns 401 and is one possible reason an old public ping stopped.
Never put the key in the URL. Use weekday custom times only, and manually pause
on NSE holidays (a fixed weekday schedule cannot read our calendar).
See KEEPALIVE.md for the three-job 08:55–15:45 schedule and timeout troubleshooting.
Do not run manual pings outside the allowed window. Scanner heartbeats are gated
in code; an external scheduler must exclude holidays before making its request.

## 9. Invite and test with one friend first

In `/personal`, use the admin-only invite button and share the one-day invite
privately. Your friend opens `/login`, enters their own email/password and the
invite code, then chooses **Accept invite** and signs in. They link their own
private Telegram and save their own preferences.

Verify that:

1. Friend cannot create invites or read shared account amounts.
2. Each account sees only its own `/personal` trades, capital and settings.
3. Different alert preferences produce the intended private recipients.
4. Pause/mute affect signals, not existing paper-position reminders.
5. `/journal` → selected setup → **Mark as taken · Paper** opens personal entry.
6. Manual paper close updates own R statistics; no broker order occurs.
7. A controlled scanner outage during market hours queues one admin warning, not
   repeated unchanged warnings. A new warning is allowed after recovery/new outage.

These are real-service checks; passing local mocked tests does not substitute for them.

## 10. Verify evidence and restart persistence

Tests and optional CLI tools:

```bash
npm run test:keepalive
npm run test:alerts
npm run test:personal
npm run outcomes
npm run backtest:swing -- --symbols=RELIANCE,TCS
```

`outcomes` and live backtests contact the configured data source. Offline examples:

```bash
SWING_DATA_DIR=/tmp/ankquant-evidence-demo npm run outcomes -- --fixture=fixtures/evidence.json
npm run backtest:swing -- --fixture=fixtures/swing-replay.json
```

For real restart verification, first confirm Supabase reports healthy in the
**authenticated** detailed health endpoint `/api/public/health`. Record a controlled
paper signal/trade and note its event/trade identity privately. Restart/redeploy the
API, then confirm identities/history survive. Check Supabase Table Editor too, so
local-file recovery is not mistaken for durable database recovery.

## 11. Upstox — staging only until the gates pass

Open https://account.upstox.com/developer/apps and consult the official Analytics
Token documentation: https://upstox.com/developer/api-documentation/analytics-token/.
Generate the read-only Analytics Token; store it privately on the intended backend
host as `UPSTOX_ACCESS_TOKEN`. Do not send it to friends or paste it into chat.

After configuring a sourced universe manifest and reviewing screening/corporate-
action/calendar differences, run **on that configured host**:

```bash
npm run launch:check
npm run launch:check -- --live
npm run check:upstox
```

The default launch check is offline. Live commands need real credentials/network
access; they print sanitized results, not tokens. Approval flags record actual
review/permissions, not a shortcut around missing checks. Review
UPSTOX_MIGRATION.md before setting `UPSTOX_SCREENING_APPROVED` or changing
`MARKET_DATA_PROVIDER=upstox`. Keep `UPSTOX_STREAM_ENABLED=false` until its live
subscription/reconnect path is tested. Current streaming is diagnostic quote state,
not a complete browser tick-delivery feature.

No automatic metadata enrichment source or production screening parity has been
certified. Do not launch an Upstox scanner with invented market-cap/sector values.
A small whitelist is a changed universe and requires explicit acceptance. Confirm
multi-user display/alert data-use permission with Upstox. Do not switch the default
provider merely because fixture tests pass. No Upstox production cutover is done
by this guide.

## 12. Remaining work after setup

Phase 6 still needs full transactional outbox/concurrent-ingest guarantees, broader
metrics/logging/validation, backup/restore and further hardening. Phase 7 CI and load
qualification remain. Phase 8 metadata/parity, authenticated checks and controlled
cutover remain. Backup your Supabase project and stage migrations; no automated
backup/restore command has been implemented yet.

Useful guides: PHASE1.md, PERSONAL_JOURNAL.md, PHASE3.md, PHASE5.md, KEEPALIVE.md,
UPSTOX_MIGRATION.md, ARCHITECTURE.md and FUTURE_ARCHITECTURE.md. The future diagram
is a target design, not a claim that all phases are deployed.
