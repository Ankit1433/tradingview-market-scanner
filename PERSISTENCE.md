# Restart persistence verification

Accounts, sessions, preferences, capital/risk settings and personal paper trades require Supabase and its existing migrations. They do not fall back to local files. Account reads fail with 503 when the database is unavailable; the app must not claim an unsaved update succeeded.

Shared signals and swing state can use local files when the database is unavailable. Render free-tier local files are ephemeral; use the configured Supabase path for durable storage across deployments. No new migration or environment variable is introduced by this verification work.

## Automated checks

Run `npm run test:persistence` for accounts, or `npm test` for the full suite including the existing shared-journal recovery check (`test-keepalive.js`).

The account check uses real HTTP routes, password hashing, session handling and the real Supabase REST adapter against an isolated local HTTP database stand-in. It saves preferences, sizing and a paper trade, stops the app process, removes local files and starts a fresh process. Existing sessions must still work and saved data must match. It closes the trade, restarts a third process and checks the exit and 2R result. A second user must not see or close the owner's trade. A simulated database outage must fail with 503 and recover without resetting data.

These checks do not execute SQL migrations or validate a real Supabase project's RLS, constraints, backups or availability. They never connect to production and use only synthetic users and trades.

## Production verification (pending)

Wait for the current Upstox preparation job to finish. Do not restart or deploy while it is running just to perform this check.

1. Sign in at `/personal`. Record your current capital/risk settings, a paper trade's symbol and values, and open/closed counts privately. At `/alerts`, save a distinctive daily alert limit, reload and confirm it was saved.
2. Use the next planned deployment/restart after preparation finishes. No special database action or SQL rerun is needed.
3. Check startup logs for Supabase connection and journal/swing restoration. Compare counts with the preceding logs; market activity may legitimately add signals or close positions, so count equality alone is insufficient.
4. Reopen `/personal` and `/alerts`. The session should remain valid until its normal expiry unless explicitly revoked. Confirm exact saved preferences, capital/risk settings and the recorded paper trade. Reload again. If needed, sign in again to distinguish session expiry from data loss.
5. Check with a friend account that your personal trade and capital remain private. Do not share passwords, cookies or API keys.

If values disappear, stop treating persistence as verified. Check the deployment's Supabase project/configuration and required migrations before creating replacement records. Avoid resetting tables, deleting local caches or rerunning bootstrap as a recovery step.

## Current evidence

- Earlier supplied production logs showed 303 shared journal signals and five swing positions restored from Supabase. This supports shared-state restoration for that deployment only.
- Account restart behavior is covered by the isolated automated check above.
- A controlled before/after comparison of current personal data across a production restart remains unverified until the production procedure is completed.
