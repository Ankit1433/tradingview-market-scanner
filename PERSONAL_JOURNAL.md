# Private accounts and personal paper journal

This change supplies the account and Telegram-linking prerequisites for Phase 4.
Phase 3 delivery and Phase 5 pages are now implemented separately; see PHASE3.md and PHASE5.md.
All personal trades and reminders are informational paper tracking. No orders are placed.

## Learning map

1. `src/middleware/accounts.js` hashes passwords with salted scrypt. Login generates a random opaque token; only its SHA-256 hash is stored. The browser receives the raw token in a seven-day httpOnly, SameSite=Strict cookie, Secure in production.
2. `src/routes/accounts.js` identifies the account from the cookie. Every personal query derives `user_id` from that account; supplied owner IDs are ignored. Existing machine keys never impersonate a user.
3. `src/services/accountStore.js` performs server-only database queries. SQL functions atomically consume invites, create the first admin, link private Telegram chats, and serialize concurrent sizing checks for an owner.
4. `src/trading/personalJournal.js` is the pure sizing/statistics/reminder logic. Quantity is capped by the user's risk budget and available capital. R uses each trade's initial entry minus stop, independent of quantity.
5. `src/jobs/personalLoop.js` checks observed closes and persists deduplicated reminders, then delivers them only to the owner's verified private chat. It never automatically closes a trade.

## Deployment and migration

Apply `supabase/migrations/202610280002_private_accounts.sql` after both existing migrations.
It adds `app_users`, `app_invites`, `app_sessions`, `app_telegram_links`,
`personal_trades`, and `personal_reminders`, plus service-role-only functions.
All tables enable RLS and revoke browser-role access. The application backend holds
the secret/service-role key. Accounts, sessions, personal settings/trades and reminders
**require Supabase**. They have **no local-file fallback** and fail closed if unavailable.
Existing scanner journal, swing state and evidence retain their documented file fallbacks.

`PRIVATE_MODE` defaults to true. Existing data/page/SSE URLs now require a session or
machine key. This is an intentional access-policy change; JSON signal shapes stay the same.
`PRIVATE_MODE=false` explicitly restores legacy public mode for local compatibility testing.
Account endpoints always require sessions regardless of that flag. Friends cannot read
shared scanner positions, summaries or swing money endpoints; shared aggregate performance
uses redacted values. Existing machine admin/ingest actions still require their API key.

Set `APP_ORIGIN` to the exact browser origin (e.g. your HTTPS deployment origin).
It is required in private production mode. Browser mutations require a matching Origin.
Set `NODE_ENV=production` behind HTTPS for Secure cookies. Health probes can use `/healthz`
for minimal liveness; authenticated `/api/public/health` remains the detailed health check.
HTML/account responses are no-store. The service worker retires earlier caches and caches
only static assets, never authenticated pages or APIs. Private pages no longer launch offline.

Create the first admin with backend-only `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` (12–128 characters), then run:

```bash
npm run accounts:bootstrap
```

Remove the bootstrap password afterward. The database allows bootstrap only while no
accounts exist. Alternatively, `POST /api/account/bootstrap` accepts email/password with
the existing machine API key; it is subject to the same one-time database guard.
Sign in at `/login`, open `/personal`, and create a one-day, single-use friend invite.
Only hashes of invite codes are stored; the code is shown to its creating admin once.
Registration never accepts a requested role; invited accounts are always friends.

## Using the journal

Open `/journal`, select a recorded signal, then choose **Mark as taken · Paper**.
The signal event must exist in Supabase; a local-only signal cannot be taken until synced.
Set personal capital/risk, enter your entry/stop, and optionally enter quantity/target.
Blank quantity uses risk-based sizing; blank target uses 2.5R. Explicit quantity must also
fit the owner's risk and capital limits. The database checks limits under a user-row lock,
so simultaneous requests cannot bypass the capital cap. Each user can take an event once.

Users can record a manual paper exit. Closing is owner-scoped and only succeeds once.
Statistics report closed/open counts, sum/mean initial-risk R and win rate, with n < 30 warning.
No leaderboard or cross-user sizes/capital endpoint is provided. The UI/API loads the latest
1,000 personal trades and reports the limit; statistics cover that window.

## Telegram and reminders

Set `TELEGRAM_BOT_USERNAME` on the API host. The Link Telegram action issues a ten-minute
one-time `/start` deep link. Set `TELEGRAM_BOT_TOKEN` and `ENABLE_PERSONAL_WORKER=true`
on exactly one process with access to the same database and working TradingView history.
It may be the local scanner in a split deployment. Only Telegram private chats can redeem
links; group/channel messages cannot. Reload `/personal` to see successful link status.
Unlinking immediately prevents future queued deliveries; previously sent messages remain.

Private mode disables the old bot command poller to avoid competing getUpdates consumers
and exposing shared account commands. The worker polls for links every five seconds and
checks personal trades approximately every minute. Use one worker/bot consumer only.

Stop/target reminders compare a fresh completed observed close to the fixed levels.
Trailing reminders compare that close to the highest close observed by this worker since
entry. Daily swing bars use the Phase 0 completion cutoff. Intraday time reminders begin
at 15:15 IST; user-configured session time stops also apply. Reminders are deduplicated
once per trade/kind, survive restarts in the database, and carry no quantities/capital.
They do not model intra-bar touches or recover every missed observation after downtime.
Stale observations and non-trading days do not trigger checks; no feed means no reminder.

Delivery rechecks the owner's current chat and open-trade status. It is globally throttled
(one send per 1.1 seconds), and Telegram 429 retry_after defers subsequent delivery until
that delay expires. Transient failures remain pending. A crash after Telegram accepts a
message but before the database marks delivery can cause a duplicate. Distributed worker
claims/exactly-once delivery remain future reliability work. Phase 3 now shares durable per-chat cooldowns across signals, command replies and reminders; see PHASE3.md.

## API

All browser POSTs require a same-origin Origin header:

- `/api/account/register`, `/login`: invite registration/login; ten attempts per IP or email per 15 minutes.
- `/api/account/me`, `/logout`: session identity and revocation.
- `/api/account/invites`: admin-only invite creation.
- `/api/account/settings`: owner-only capital/risk settings.
- `/api/account/telegram/link`, `/telegram/unlink`: private chat linking.
- `GET /api/account/journal`: owner's trades and R statistics.
- `POST /api/account/journal`: take an existing event with personal levels/sizing.
- `POST /api/account/journal/:id/close`: owner-only manual paper exit.

Sessions expire after seven days; logout deletes the stored session. Open SSE connections
end at expiry and recheck revocation every 30 seconds. There is no password reset,
account deletion, role promotion UI or distributed login limiter in this increment.

## Verification

```bash
npm run test:personal
npm test
```

HTTP tests use an injected in-memory account-store fake (never enabled by a production
environment flag). They cover hashing, cookies, invite reuse, owner isolation, CSRF,
machine-key separation, outage behavior, logout, sizing and private reminder routing.
They do not execute PostgreSQL migrations or send Telegram messages. Apply migrations
and verify registration/linking/delivery on a staging deployment before inviting friends.
