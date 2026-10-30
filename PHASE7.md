# Phase 7 — Tests and CI

## Implemented

`.github/workflows/test.yml` runs on pushes, pull requests and manual dispatch.
It grants repository read permission only, uses no application secrets, has job
timeouts, and cancels older runs for the same workflow/ref. There is no deployment
or production configuration step.

- Regression matrix: Node 22 and 24 on Ubuntu 24.04, `npm ci`, `npm test`, and
  `npm run test:load`. The ordinary suite now includes API contract checks.
- Browser job: Node 24, Playwright's Chromium installation, desktop/mobile E2E tests.
- Seven-day artifacts: SSE JSON report, Playwright HTML report, screenshots/traces
  from failed tests. These contain synthetic test users/data, not production secrets.
- Test output directories are gitignored. `npm ci --omit=dev` still excludes browser
  and schema-validation tooling from production installations.

## Browser coverage

`tests/e2e/user-flow.spec.js` uses real application routes and session/password code
against a test-only account-store fake and synthetic candle adapter. Each browser
project has an isolated local fixture process. Browser requests outside that local
origin are blocked. No database, broker or Telegram access is required.

Four tests across desktop Chromium and Pixel-sized mobile Chromium verify:

1. Unauthenticated redirect, login, httpOnly/Strict session cookie, preference
   save/reload, signal journal, paper-entry link, logout and revoked access.
2. A second user's preference isolation and an injected save error that leaves
   the form editable without persisting changes.

Existing `npm run test:browser` remains an optional broader CDP smoke test for
symbol markers, keyboard behavior and feed-error handling. CI's required browser
job uses Playwright; the older optional CDP script is not separately run there.
This is not a comprehensive accessibility or every-browser compatibility audit.

## API contracts

`tests/contracts/signal.schema.json` defines the canonical signal contract. The
contract test checks real REST responses and SSE replay against that schema,
including identity/timestamp preservation, signalCount agreement, auth failures,
invalid-query errors, market status, health, statistics and account preferences.
Unknown additional signal fields remain allowed for backward-compatible additions.
These checks supplement the existing route/ingest/account suites; they do not
validate every possible OpenAPI response or every live provider payload.

## SSE load test

`tests/sse-load.js` opens **50 simultaneous authenticated sessions/streams** (one
fixture account, alternating intraday/swing filters), broadcasts 40 events, and
checks **1,000 client deliveries**, filtering, duplicate detection, disconnects,
reconnection and final cleanup. A local p95 threshold of five seconds catches
major stalls. RSS delta and measured latency are reported, not advertised as
production capacity. It writes `test-results/sse-load.json`.

This is a short local burst/load regression, not a sustained soak test. It excludes
real Supabase session lookup latency, Render sleep/cold starts, proxies, the public
Internet, slow-reader saturation and large production journals. Those require
staging/performance qualification. Multiple fixture clients sharing an account
still exercise the real cookie-authentication and SSE registration paths.

## Run locally

```bash
npm ci
npm test
npm run test:contracts
npm run test:load
npx playwright install chromium
npm run test:e2e
```

On Linux CI, `npx playwright install --with-deps chromium` also installs OS browser
dependencies. If you already have compatible Chromium, an optional local override is:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

The override is not used by the GitHub workflow. Inspect local reports with:

```bash
npx playwright show-report
```

## Verify GitHub execution

After reviewing/committing/pushing these changes, open your repository's **Actions**
tab and select **AnkQuant tests**. Verify both Node matrix jobs and the browser job,
and inspect artifacts on failure. GitHub-hosted execution has not been run from
this workspace; writing a workflow is not evidence that a remote run succeeded.
Only the installed local Node/Chromium versions are verified locally.

Phase 6 live SQL/replica/crash tests and Phase 8 authenticated provider/parity checks
remain separate requirements. A green fixture CI run is not production launch approval.
