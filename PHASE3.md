# Phase 3 — Private signal alerts

## Implemented behavior

Signal alerts use each linked user's saved modes, signal types (any selected label),
minimum distinct agreeing-signal count, inclusive price range, exact sector list,
account watchlist, daily cap and quiet hours. Empty type/sector lists mean all.
Watchlist-only with an empty account list matches nothing. Times are Asia/Kolkata;
overnight quiet periods work, and equal start/end means quiet all day.

Signals must be valid, at most 15 minutes old and not future-dated. The worker reads
recent database signals, including pushed signals in split mode. It does not read a
local-file-only journal. Replayed older events are deliberately not alerted. The
per-user/day dedupe key contains IST signal date, mode, symbol and sorted distinct
signal labels; repeated prices/observations of that same setup are suppressed.

Daily limits count admitted **signals**, including pending/skipped entries, rather
than Telegram messages. A digest of eight setups consumes eight slots. Reservation
and dedupe are enforced by a SQL function locking the owner row. Queued alerts are
rechecked against current preferences and controls before sending; a mismatch is
skipped rather than delivered after a long delay. Signal entries expire after 15
minutes. Discovery may catch up on recent events after restart; database uniqueness
prevents already-admitted setups from being duplicated.

Digest preference batches up to eight signal rows for one user into a message,
reducing the batch if necessary to stay within Telegram's text limit. Admin/control
messages never enter a signal digest. No personal sizes/capital appear in signal
alerts or outage notifications. All setup/reminder messages are paper/informational.

## Delivery and controls

The personal worker now owns one shared per-chat send path for private signal alerts,
command replies and personal reminders. Cooldown timestamps persist on accounts.
Telegram retry_after defers that chat for the requested period; another chat can
continue. Successful sends reserve at least 1.1 seconds before the next message.
Failures remain pending. Reminders are attempted before signal draining so a busy
signal scan does not continuously displace existing paper-trade reminders.

After one-time private Telegram linking, the owner can send:

- `/pause`: pause signal alerts.
- `/resume`: resume and clear the mute.
- `/mute`: mute signal alerts for 60 minutes.
- `/mute MINUTES`: mute for 1–10,080 minutes.

Only verified private chats can control their owner account. Groups cannot redeem
links or issue account controls. These controls do not disable personal paper
stop/target/trail/time reminders. Bot offset and queued replies are persisted.

A Supabase worker lease permits one Telegram poller/delivery worker. Cooldowns,
queue state, command offset, user controls and outage state survive process restart.
A crash after Telegram accepts a send but before its database acknowledgement may
still cause a duplicate: delivery is at-least-once, not exactly-once. Queue claims
and rate limiting depend on the one-worker lease, not arbitrary concurrent bot
consumers. Do not run another tool against getUpdates for the same bot.

## Migration and settings

Apply `supabase/migrations/202610290003_personal_alerts.sql` after the existing
accounts/preferences and worker-lease migrations. It adds account controls/cooldown,
`alert_queue` and its capped/deduped enqueue function, with backend-only access.
No browser secret or machine key is introduced.

Configure the worker host:

```dotenv
PRIVATE_MODE=true
ENABLE_PERSONAL_WORKER=true
SIGNAL_ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=<backend setting only>
TELEGRAM_BOT_USERNAME=<bot username>
```

Supabase must be configured and reachable. Accounts need verified private Telegram
links. Missing migrations cause database operations to fail closed/retry; a saved
preference does not prove successful delivery. The preferences API now reports that
filtering is enabled unless SIGNAL_ALERTS_ENABLED=false, plus a worker-dependent
status message. It is not a live bot-health guarantee.

For split deployments, run this worker on the **hosted ingest API**, independently
of the scanner, so it can send outage alerts while the scanner is down. It reads
shared Supabase events. Personal position reminders additionally need working
market-history access on that worker host. With Upstox, verify host connectivity and
budget API calls across both hosts; cross-host token quotas remain a Phase 8/6
limitation. There is one scanner ownership lease and a separate Telegram worker
lease. Existing shared scanner Telegram broadcasts remain separate; leave
TELEGRAM_CHAT_ID unset if you want only private delivery.

SIGNAL_ALERTS_ENABLED=false disables signal discovery/dispatch and outage monitoring;
private linking, command replies and personal reminders still operate. It does not
remove saved preferences or pending records (which expire normally).

## Admin heartbeat monitoring

In ingest mode, the worker checks scanner contact during open exchange sessions
using the shared calendar. It uses the newest heartbeat/push timestamp and a stale
threshold of max(10 minutes, twice configured keepalive interval plus 30 seconds).
This accommodates the eight-minute default without false alarms between heartbeats.
A persisted outage incident queues one notification per linked admin. Unchanged
outages stay quiet, including across restarts. Fresh scanner contact closes the
incident; a subsequent outage can notify again. Closed-market dates generate no
new warning; pending warnings are skipped once recovered or market hours end.
This monitors scanner contact, not every market-data dependency.

## Verification

```bash
npm run test:alerts
npm test
npm run test:browser
```

Tests use synthetic signals, injected clocks, fake persistence and a fake Telegram
sender. They cover all preference filters, stale/future signals, quiet boundaries,
per-user caps/dedupe, restart replay, controls, digests, per-chat retry isolation and
outage/recovery behavior. PostgreSQL migrations and Telegram delivery require staging
verification; in-memory SQL-function substitutes do not prove database concurrency.
Apply the migration, link two test users, set different filters/quiet hours, ingest
controlled fresh paper signals and verify only the intended chat receives them.
Exercise a 429/restart scenario and a scanner outage without exposing tokens.
