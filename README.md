# NSE Scanner — Intraday + Swing

A market scanner for NSE equities with two independent modes sharing one
codebase:

- **Intraday** — polls a live universe of high-relative-volume stocks every
  15–30s, evaluates seven 5-minute-timeframe signals per symbol, and sizes a
  position only when multiple signals agree. Flat by 15:15.
- **Swing** — runs once daily after the close, evaluates six daily-timeframe
  signals across a structurally-filtered universe, and tracks multi-day
  positions with ATR-based stops and R-multiple targets.

Originally a Python/Colab notebook, rewritten as an Express service.

---

## Why two modes and not one

They are not the same strategy on different timeframes — they disagree on
almost every parameter, and the disagreements are the interesting part:

| | Intraday | Swing |
|---|---|---|
| **Candles** | 5-minute | Daily |
| **Universe filter** | Already moving (change > 2%, rel vol > 2x) | *Not* extended today (change < 5%), above 200DMA |
| **Poll cadence** | 15–30s tick loop | Once daily, after close |
| **Stop basis** | Fixed points / structural level | ATR-scaled (2× ATR14), tightened to structure |
| **Target** | Fixed +10 points | 2.5R |
| **Trail** | 1.5% from peak | Chandelier (peak − 2.5× ATR) |
| **Confluence gate** | 3+ signals | 2+ signals |
| **Time limit** | Square-off at 15:15 | Time stop at 15 sessions under 1R |
| **State** | In-memory, wiped daily | Persisted to disk |

Two of those deserve explanation:

**The universe filters are near-opposites.** The intraday scan wants stocks
already in motion. For a swing entry that's exactly backwards — a stock up 6%
today is a *bad* swing entry, because your stop now sits far below and your
risk-per-share is inflated by the move you missed. So the swing screener
explicitly excludes stocks up more than 5% on the day.

**The confluence gate is lower for swing (2 vs 3), not higher.** Daily signals
are individually much rarer than 5-minute ones — a daily base breakout is a
genuine event, where a 5-minute one happens constantly. Requiring three
simultaneous daily signals would produce almost no trades. The intraday gate
was raised to 3 after live data showed 2 agreeing 5-min signals was often just
two common conditions coinciding by chance.

---

## Intraday signals

| Signal | Condition | Provides a stop? |
|---|---|---|
| **Pullback** | Uptrend (EMA9 > EMA20), price within 0.3% of EMA9, green candle, rising volume | Yes — below EMA9 |
| **ORB breakout** | Clears the 9:15–9:45 opening range high | Yes — opening range low |
| **No-pullback runner** | Above EMA9/VWAP for 8+ bars without touching EMA9 | Yes — below EMA9 |
| **Afternoon breakout** | ~2h base within 2% range, broken on 3× volume | Yes — old base high |
| **Momentum** | Price / change% / rel volume all rising across 5 cycles | No |
| **Volume spike** | Current bar ≥ 3× the prior 5-bar average | No |
| **VWAP reclaim** | Cross back above VWAP on ≥1.5× average volume | No |

## Swing signals

| Signal | Condition | Provides a stop? |
|---|---|---|
| **Base breakout** | 20-day base within 12% range, broken on 1.8× base volume | Yes — base low |
| **MA pullback** | Pullback into EMA20/EMA50 with trend intact, ≤15% deep | Yes — recent swing low |
| **MA stack** | Price > EMA20 > EMA50 > EMA200, all rising | No |
| **52W high** | Within 5% of the 52-week high | No |
| **Volume dry-up** | Recent 5-day volume ≤70% of the prior base average | No |
| **RS leader** | 60-day return beats the index's | No |

In both modes, signals without a natural stop level contribute to the
confluence count but can't define an entry on their own.

---

## Position management

Sizing is capped by three independent ceilings in both modes — max rupee risk
per trade, total allocated capital, and capital already deployed — so combined
exposure can't exceed the limit. Swing adds a fourth: a hard cap on concurrent
open positions, because five positions each risking the full per-trade budget
is a much larger drawdown exposure than the capital figure alone suggests.

**Intraday lifecycle:** stop hit → full exit. Target (+10pts) → book half, stop
to breakeven, trail the rest at 1.5% from peak. Anything still open at 15:15 →
force-exit.

**Swing lifecycle:** stop hit → full exit. Target (2.5R) → book half, stop to
breakeven. Runner trails chandelier-style at peak − 2.5× ATR, which widens with
volatility instead of using a fixed percentage — a 1.5% trail on a daily chart
would stop out on ordinary noise. Positions still under 1R after 15 sessions
are cut by the time stop, since dead capital in a swing book is a real cost in
a way it isn't intraday.

**Both are calculators, not broker connections.** They tell you what to do; you
place the orders.

---

## Architecture

```
src/
  config/
    constants.js          Intraday tunables
    swingConstants.js     Swing tunables — deliberately separate, since the
                          two strategies share almost no numbers
    timeUtils.js          IST-aware time helpers
  services/
    tvScanner.js          Intraday scan universe
    swingScanner.js       Swing scan universe (different filters entirely)
    tvHistory.js          Historical OHLCV candles (websocket client)
    telegram.js           Alerts + /command polling for both modes
    nifty.js              Cached index change for the intraday RS gate
    eventStream.js        SSE broadcaster with heartbeat + reconnect support
    marketStatus.js       Session phase, holidays, next open
    pushClient.js         Forwards signals to a remote instance (queued, bounded)
  indicators/
    ta.js                 EMA / session-resetting VWAP
    swingTa.js            ATR (Wilder), SMA, RSI, rolling high/low
    signals.js            Seven intraday signal evaluators
    swingSignals.js       Six daily signal evaluators
  trading/
    positionManager.js       Intraday: fixed-point targets, square-off
    swingPositionManager.js  Swing: ATR stops, R-multiples, time stop
    momentum.js              Cross-cycle momentum history
    volume.js                Volume explosion detection
  state/
    dailyState.js         Intraday state — in-memory, reset daily
    swingState.js         Swing state — persisted to disk, survives restarts
    signalJournal.js      Append-only JSONL journal of every signal fired
  jobs/
    scanLoop.js           Intraday cycle — tiered 15–30s polling
    swingLoop.js          Swing cycle — once daily after close
  backtest/
    backtest.js           Bar-by-bar replay of intraday logic, no look-ahead
  routes/
    scanner.js            Intraday REST API
    swing.js              Swing REST API
    public.js             Unauthenticated read API + SSE
    ingest.js             Authenticated push endpoint for a remote scanner
  middleware/
    auth.js               API key auth, rate limiting, money redaction
  docs/
    openapi.js            OpenAPI 3.0 spec + Swagger UI page
  server.js
  index.js                Starts HTTP server + both loops
public/
  demo.html               Self-contained live demo page, no build step
Dockerfile                Non-root, tini init, health check
docker-compose.yml        api / full profiles
test-swing.js             65 assertions — swing indicators + position lifecycle
test-api.js               79 assertions — auth, redaction, SSE, journal, errors
test-ingest.js            49 assertions — split architecture over real HTTP
```

**Stack:** Node.js, Express, Axios, WebSocket.

Design notes worth calling out:

- **Swing state is persisted; intraday state is not.** This is the main
  architectural split. Intraday positions are closed by 15:15, so losing
  tracking on a restart is survivable. A swing position is held for weeks — if
  the process restarts and the scanner forgets it, it silently stops managing
  a stop on money that's still at risk. Swing state is written atomically
  (temp file + rename) on every mutation and reloaded on boot. A corrupt state
  file is backed up rather than overwritten, because destroying the only
  record of open positions is worse than the crash it's avoiding.
- **The swing scan runs after the close, not intraday.** Daily signals
  evaluated against a still-forming candle are simply wrong — a "breakout on
  1.8× volume" checked at 11:00 compares a third of a day's volume against
  full-day averages. This is the single most common way a daily-timeframe
  backtest silently diverges from live results.
- **The intraday loop reschedules with `setTimeout` after each cycle
  completes**, rather than firing on a fixed `setInterval`, so a slow cycle
  can't stack up behind itself.
- **Every signal evaluator fails open** — returns `null`/`false`/`0` rather
  than throwing, so one bad symbol never kills a cycle.
- **Swing fetches daily candles once per symbol per scan** and passes the
  array to all six evaluators, rather than the intraday pattern of one fetch
  per signal. At ~150 symbols × 6 signals that difference is ~900 avoided
  round-trips.
- **ATR uses Wilder's smoothing**, not an SMA of true range. The shortcut is
  common and gives visibly different values — which matters when ATR is
  setting your stop distance.
- **SSE rather than WebSocket** for the live stream. The traffic is strictly
  one-directional; SSE gets browser reconnection for free, rides plain HTTP so
  it survives proxies that mangle WebSocket upgrades, and needs no client
  library. A 25s heartbeat keeps idle proxies from closing the connection —
  which matters on a scanner, because most of the day is idle.
- **The journal is JSONL, appended.** Rewriting a JSON array on every signal
  would be O(n) as it grows, and a crash mid-write would corrupt the whole
  file. With line-delimited appends a torn write costs one record.
- **Journal and stream writes are wrapped in try/catch inside the scan loops.**
  Alerting is the primary job; the API feed is secondary and must never be able
  to take a scan cycle down. The push client follows the same rule — an
  unreachable remote logs and re-queues, it never propagates.
- **A dead scanner and a quiet market produce identical empty feeds.** The
  scanner heartbeats to the API, and `/api/public/market/status` reports
  `scanner.reporting`, so the UI can say which one it's looking at.

---

## API

Interactive docs at **`/api/docs`** (OpenAPI 3.0). Live demo page at **`/demo`**.

### Public — no auth, always populated

| Endpoint | Returns |
|---|---|
| `GET /api/public/signals/recent` | Signal journal, newest first. Filter by `mode`, `type`, `symbol`, `confluenceOnly` |
| `GET /api/public/stats` | Signal counts by type/mode/sector, daily histogram, win rate |
| `GET /api/public/market/status` | Session phase, next open, holiday flag |
| `GET /api/public/health` | Aggregate health; 503 when degraded |
| `GET /api/public/stream` | **SSE** live signal stream |
| `GET /api/public/live/stocks` | Current tracked universe |

### Live state — empty outside market hours by nature

`/api/scanner/{stocks,positions,summary,signals/:type}` and
`/api/swing/{positions,trades,candidates,analyze/:symbol}`.

### Admin — requires `x-api-key`

`POST /api/scanner/admin/{start,stop}`, `POST /api/swing/admin/{scan,start,stop}`,
`POST /api/swing/positions/:symbol/close`.

That last one exists because you'll sometimes exit in your broker for a reason
the scanner has no visibility into. Without it, the scanner keeps managing a
position you no longer hold.

Telegram: `/stocks`, `/positions`, `/strong`, `/pullback`, `/momentum`,
`/volume`, `/vwap`, `/runner`, `/afternoon` for intraday; `/swing` and
`/swingstats` for swing; `/help` for the full list.

### Why the journal exists

Live scanner state is deliberately ephemeral — the intraday `alerted` sets are
wiped every morning, so by design nothing recorded that a signal had ever
fired. That's fine for an alert bot and useless for anything else: no history
to chart, no dataset to measure signal quality against, and an API returning
empty objects for the ~82% of the week that NSE is closed.

Every fired signal is now appended to a JSONL journal with its computed levels.
The public endpoints read from that, so the API has content regardless of
session hours — and there's finally a real dataset to build a swing backtest on.

### Security

Admin endpoints **fail closed**: with no `API_KEY` set they return 503 rather
than running unauthenticated. Set one before deploying.

`PUBLIC_MODE=true` converts rupee figures to R-multiples and percentages on
public reads, and strips position sizes and capital deployed. Real performance
stays visible; account size doesn't. Supply the key to see full figures.

Rate limiting is per-IP with standard `X-RateLimit-*` headers. `trust proxy` is
enabled so the limiter sees real client IPs behind a reverse proxy rather than
bucketing the entire internet under one address.

---

## Deployment

Two shapes, covered in **[DEPLOY.md](DEPLOY.md)**:

- **Single process** — scanner and API together. Fine locally.
- **Split** — scanner at home, read-only API in the cloud, signals pushed over
  an authenticated POST.

The split exists for a concrete reason: the market data sources are
undocumented internal TradingView endpoints, and requests to them from
datacenter IPs are commonly blocked. A cloud-hosted scanner tends to get 403s
while the same code works from a residential connection — and it fails
*quietly*, so the page just sits empty. Running the scanner where the data
works and the API where it's reachable sidesteps that entirely, and the hosted
half ends up with no outbound market-data dependency at all.

`INGEST_MODE=true` switches an instance to the read-only half. Same codebase.

```bash
docker compose --profile api up -d    # cloud: read-only API
docker compose --profile full up -d   # home: scanner + API
```

## Setup

```bash
npm install
cp .env.example .env   # fill in Telegram bot token and chat ID
npm start
```

Server comes up on `http://localhost:4000` (or `$PORT`). Both loops start
alongside it; either can be disabled independently:

```bash
ENABLE_INTRADAY=false npm start   # swing only — much lighter
ENABLE_SWING=false npm start      # intraday only
```

Run the tests — no network access needed:

```bash
npm test              # 193 assertions
npm run test:swing    # 65 — swing indicators and position lifecycle
npm run test:api      # 79 — auth, redaction, SSE, journal, errors
npm run test:ingest   # 49 — push architecture, batching, failure handling
```

Run the intraday backtest:

```bash
npm run backtest
```

Edit `SYMBOLS` in `src/backtest/backtest.js` first — the screener endpoint only
returns a live snapshot, so there's no historical record of which stocks matched
the filter on a past date. The backtest validates entry and exit *logic*, not
stock selection.

---

## Data source

Market data comes from TradingView's screener endpoint and chart websocket.
**Neither is a documented public API** — both are internal endpoints, reached
the same way the Python `tvDatafeed` library reaches them. Workable for a
personal tool, not a supported integration, and it can break without notice.
Swapping in a licensed data vendor would be the first change required to run
this as anything other than a personal project.

## Configuration

Strategy parameters live in `src/config/constants.js` (intraday) and
`src/config/swingConstants.js` (swing). The risk numbers in both are
placeholders — set them to your own before running. Note that
`LEVERAGE_MULTIPLIER` on the intraday side defaults to 1 (cash only), which
makes quantities look small if your broker gives you intraday leverage. The
swing side has no leverage multiplier at all, deliberately — those are
delivery positions.

Secrets go in `.env`, never in source. `.gitignore` covers `.env` and `data/`.

## Known gaps

- **The swing side has no backtest.** The intraday backtest replays 5-minute
  bars; there's no daily-timeframe equivalent yet. `test-swing.js` verifies
  the signal maths and position lifecycle against synthetic data, which is not
  the same as measuring whether the signals are profitable.
- **Swing exits are evaluated on daily closes only.** If a stock gaps through
  your stop intraday, this won't know until the next scan. Real protection is
  a stop-loss order resting with your broker, not this.

## Disclaimer

Built for personal use. Nothing here is financial advice, and no signal carries
any guarantee of profitability. Trading carries substantial risk of loss.
