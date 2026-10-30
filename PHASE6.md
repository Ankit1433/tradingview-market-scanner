# Phase 6 — Reliability implementation

Implemented code is distinct from verified production behavior. Apply the migration
and exercise the real staging failure paths before relying on these guarantees.

## Signal journal and outgoing delivery

Apply `supabase/migrations/202610290004_reliable_signal_delivery.sql` after all
previous migrations. It adds backend-only `signal_outbox` and
`persist_signal_delivery`. When Supabase is connected and PUSH_URL is configured,
the journal's persistence operation inserts the signal event and its outgoing
intent in one PostgreSQL transaction. There can be no committed event from that
operation without its associated delivery intent. Queue identity includes a hash
of the destination URL; changing destinations creates a distinct delivery namespace.

The push client also persists a fsynced local queue. Before transmission it awaits
the database transaction for its batch, when database mode is connected. Rows are
removed from the database outbox only after receiver acceptance. A crash after
acceptance but before acknowledgement causes replay, not loss. The receiver's
stable-key idempotency absorbs replay. Partial HTTP 207 responses acknowledge only
accepted indices; rejected entries remain pending. Invalid partial responses are
retried. Auth failure retains queued entries and disables repeated pushes.

Older `scanner_state` snapshot queues are no longer the source of truth. Persistent
local queues are merged with database outbox rows on startup; changing PUSH_URL does
not migrate old database rows automatically. Outcome forwarding retains its separate
periodic reconciliation path; it is not covered by the signal outbox transaction.

The scan loops still journal synchronously and queue database writes asynchronously.
A process crash before that database operation commits can lose the newest signal
if its local filesystem is also ephemeral. Thus the transactional guarantee starts
at the **persistence operation**, not at the instant a signal evaluator returns.
Persistent scanner disk or a synchronous end-to-end journal API would be needed to
remove that remaining acceptance window. Local-only mode has no distributed
transaction; preserve its data directory. Never call this exactly-once delivery.

## Concurrent ingest

Incoming signals now await an atomic database insert using event_key uniqueness.
Only the insert winner appends to the recent/local journal and broadcasts SSE.
Concurrent duplicate requests receive success without duplicate side effects in
that process. With no database, a per-key promise lock plus retained-file lookup
prevents duplicate appends in one process; multiple local-only replicas are unsupported.
Legacy payloads without stable event keys remain accepted but cannot guarantee
idempotency across otherwise distinct receipt timestamps.

If a receiver crashes after committing the event but before appending/broadcasting,
replay does not rebroadcast it: durable history is correct, but that live SSE event
can be missed. Clients should reload/replay journal history on reconnect. This is
not a transactional SSE broadcaster or guaranteed event bus.

## Worker coordination and shutdown

Scanner startup and admin start/scan routes share one ownership coordinator for
both TradingView and Upstox. Production scanner mode requires reachable database
coordination. Ingest-only instances reject local scanner starts. A lost lease stops
both scanner loops and triggers process shutdown when started through the entrypoint.
Development local-file mode remains available but has no multi-process coordination.
The Telegram worker retains its independent lease.

Shutdown is reentrant-safe, stops accepting HTTP work, closes SSE, stops workers,
waits for any in-flight signal flush, drains pending batches/database operations,
closes the provider/feed, and releases ownership. A ten-second deadline forces exit
with failure if draining hangs. Persisted unacknowledged data is recovered later.
External calls can still outlast that deadline, so verify crash/recovery on staging.

## Validation, logs and metrics

`src/config/validate.js` runs before server imports/startup. It rejects invalid
boolean/numeric settings, malformed URLs, incomplete database credentials, missing
push credentials, invalid production origin and required worker/provider secrets.
Validation errors identify setting names, never their values.

HTTP request logs are structured JSON with generated request ID, method, route
pattern, response status and elapsed time; URLs/query strings, bodies, cookies and
auth headers are not logged. A redaction helper protects structured fields and
error objects. Older scanner/service messages remain partly plain text; this is
not a complete rewrite of every historical console call.

`GET /api/admin/metrics` requires the machine API key and returns process-local
request counters, uptime, memory use, push state and provider health. These counters
reset on restart and are not a hosted metrics/alerting system. `/healthz` remains
minimal liveness; the authenticated detailed health route remains separate.

## Signal-journal backup and restore

```bash
npm run journal:backup -- backup /safe/path/journal-backup.json
npm run journal:backup -- restore /safe/path/journal-backup.json
npm run journal:backup -- restore /safe/path/journal-backup.json --apply
```

Backup enumerates retained database/local/archived signals and writes a new file
with checksum, version and private filesystem permissions. It refuses to overwrite
an existing backup. A configured-but-unreachable database fails backup unless
--local is explicit; local-only exports are labelled in the result. Restore without --apply is validation-only. Database restore
uses duplicate-ignoring upserts and never deletes existing rows. Run real restores
with scanner/ingest writers stopped, back up first, then restart/hydrate the API.

Explicit `--apply --local` writes a retained archive, not the full live API window.
This tool backs up **signals only**, not accounts, sessions, personal trades,
reminders or the whole Supabase project. Use Supabase/database backup facilities for
full recovery. Backup paths should be outside the repository and access-controlled;
backups may contain private signal context. Export is not a guaranteed consistent
snapshot across concurrent writers; use a maintenance window.

## Verification and remaining limits

`npm run test:reliability` covers configuration failures, redaction, concurrent ingest
with local and database-insert fakes, transaction/ack adapter calls, checksums and
CLI backup/dry-run restore, partial HTTP acknowledgements, protected metrics and
real-process SIGTERM. `npm test` runs the full suite. The real PostgreSQL
migration, RPC transaction rollback, cross-replica locking and host-kill recovery
have not been verified without a staging database. Run those before production.

Remaining hardening includes fully synchronous durable signal acceptance, complete
legacy-log conversion, production-scale queue/candle retention and query budgets,
full database backup/restore automation and real failure/load qualification. Phase 7
CI/contract/load testing and Phase 8 live/parity gates remain separate.
