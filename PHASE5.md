# Phase 5 — Vanilla JavaScript UI

The frontend stays on plain HTML/CSS/JavaScript with Express routes. Existing scanner filters, journal CSV export, login and personal-journal behavior are retained.

## Pages and data

- `/app`: scanner filters, browser watchlist, chart detail and link to the symbol workspace.
- `/symbol?symbol=RELIANCE&interval=5m`: candles through the existing endpoint, 5-minute/daily selector, matching intraday/swing signal history, keyboard-accessible markers, recorded levels and a “Mark as taken · Paper” action. Signals are limited to the latest 500 matches; candles to 100 intraday or 120 daily bars. Markers only appear when a signal falls inside a displayed 5-minute interval or matches the daily candle's IST date. Feed gaps do not snap markers to unrelated candles. Chart history can include a forming bar and is labelled accordingly.
- `/alerts`: saved per-account modes, signal types, minimum signal count, price range, sectors, quiet hours in IST, daily limit, watchlist-only mode, account watchlist and digest preference. **Delivery filters are implemented by Phase 3:** actual dispatch requires its migration, linked chat and enabled worker. The page and API state this explicitly. These settings do not change personal paper reminders or the scanner's browser-only favourites.
- `/stats`: own personal paper R statistics alongside shared signal evidence grouped by mode, label, confluence or sector. Choose first-touch/final results, EOD or +1/+3/+5 session returns, percentage returns, MFE or MAE. Every metric displays its own finite-observation n, with n < 30 warning and null means rendered as an em dash. Pending/unavailable counts remain visible.
- `/journal`: signal history, evidence summary and links to personal paper tracking.
- `/personal`: own risk settings, paper trades, manual exits, Telegram linking and admin invitations.
- `/login`: invite registration and login. Forms now prevent duplicate submissions while awaiting a response.

Shared navigation links the pages. New pages provide skip links, labelled fields, fieldsets, live status messages, focus outlines, accessible tables, mobile layouts and explicit loading/empty/error/retry states. New UI values use textContent; chart labels do not inject feed text as HTML. Authenticated API 401s on the new pages redirect to login. Authenticated HTML remains uncached by the service worker.

## Migration

Apply `supabase/migrations/202610290001_alert_preferences.sql` after the private-account migration. It adds `app_users.alert_preferences` as JSONB. Existing rows receive `{}` and the API supplies defaults. Saving uses an owner-filtered update on that column alone; capital/risk settings are not overwritten. Accounts and preference persistence require Supabase; there is no file fallback.

`GET /api/account/preferences` returns `{ preferences, deliveryActive: true, timeZone: 'Asia/Kolkata' }`.
`POST /api/account/preferences` validates known fields, discards unknown fields, requires a session and matching Origin, and derives ownership exclusively from the session. Signal types must match the supported labels; modes cannot be empty; price ranges, signal count, quiet times, daily limit, symbols and booleans are bounded/validated.

## Verification

```bash
npm test
npm run test:phase5
npm run test:browser
```

The browser smoke test requires Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`) and uses CDP through the `ws` development dependency. It starts an isolated HTTP server and fixture account store; it does not contact Supabase, Telegram or TradingView. It verifies login, preferences save/reload, symbol markers, feed-error handling, mobile document overflow, statistics and journal rendering. Screenshots are written to `/tmp/ankquant-ui-previews`.

To verify real integration, apply the migration, start the app and log in with an invited account. Save preferences, reload, and verify another account retains its own values. Open a live symbol and inspect its signals; inspect `/stats` with your stored evidence. Real Supabase migration execution and live-market chart availability are not proven by fixture tests. Automated keyboard/markup checks and visual inspection do not constitute a comprehensive screen-reader audit.

See PHASE3.md for delivery enforcement and setup. CI and the broader Phase 7 Playwright/load suite remain separate work.
