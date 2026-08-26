# Deploying

Read this before pushing to a host. Two things break naively-deployed
copies of this project, and both are avoidable.

---

## The two problems

### 1. Market data sources block datacenter IPs

The scanner reads from `scanner.tradingview.com` and TradingView's chart
websocket. Neither is a documented public API — they're internal endpoints
reached with a browser-shaped user-agent. That request pattern originating
from AWS/GCP/Render/Railway address space is exactly what gets filtered.

The failure is quiet. You get 403s or empty arrays, the scan loop keeps
running, no signals ever fire, and the demo page sits empty with no obvious
cause. It looks like your code is broken when it isn't.

### 2. PaaS filesystems are usually ephemeral

Swing positions and the signal journal are files on disk. On Render, Railway,
Fly, and Heroku, the filesystem resets on every deploy and on most restarts.
That means the scanner forgets swing positions **you are still holding**, and
stops managing their stops. The journal — the thing that gives your API
content outside market hours — resets to empty each time you push a commit.

---

## The fix: split the two halves

Run the scanner where the data works, and the API where it's reachable.

```
  YOUR MACHINE (residential IP)          CLOUD HOST
  ┌────────────────────────────┐         ┌──────────────────────────┐
  │  scanner + local API       │  HTTPS  │  API in INGEST_MODE      │
  │  ENABLE_INTRADAY=true      │ ──────► │  INGEST_MODE=true        │
  │  ENABLE_SWING=true         │  POST   │  no outbound data deps   │
  │  PUSH_URL=https://api...   │         │  serves /demo + /api/... │
  └────────────────────────────┘         └──────────────────────────┘
                                                    ▲
                                                    │ fetch / SSE
                                            your portfolio site
```

The hosted half has no market-data dependency at all, so the IP-blocking
problem disappears. It still wants a volume for the journal, but losing it is
now cosmetic rather than "forgot a position I'm holding."

The same codebase runs both sides. `INGEST_MODE=true` only stops the local
scan loops from starting.

### Cloud side

```bash
API_KEY=<openssl rand -hex 32>
INGEST_MODE=true
PUBLIC_MODE=true
CORS_ORIGIN=https://your-portfolio.com
SWING_DATA_DIR=/app/data          # mount a volume here
```

```bash
docker compose --profile api up -d
```

### Home side

```bash
API_KEY=<any local value>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
PUSH_URL=https://your-api.onrender.com
PUSH_API_KEY=<the SAME key as the cloud API_KEY>
```

```bash
npm start
```

Signals queue locally and flush every 5s in batches. If the remote is down the
queue holds up to 500 and retries; nothing is lost from the local journal
either way. A 401 disables pushing rather than retrying forever — that
mismatch won't fix itself, so it says so and stops.

### Confirming it works

```bash
curl https://your-api.example.com/api/ingest/status
# { "stale": false, "secondsSinceContact": 42, "totalPushed": 137 }
```

`stale: true` during market hours means the scanner stopped reporting. The
demo page surfaces this too — it distinguishes "no signals yet" from "scanner
is not reporting", because both produce an empty feed and only one is a fault.

---

## Alternative: run everything on one host

Viable if you have a VPS with a residential-ish or unfiltered IP, or you're
willing to find out whether your provider's range is blocked.

```bash
docker compose --profile full up -d
```

Test the data path **before** relying on it:

```bash
curl -s -X POST 'https://scanner.tradingview.com/india/scan' \
  -H 'content-type: text/plain;charset=UTF-8' \
  -H 'user-agent: Mozilla/5.0' \
  -d '{"columns":["close"],"range":[0,1],"markets":["india"]}' | head -c 200
```

JSON with a `data` array means you're fine. A 403, an HTML challenge page, or
an empty body means that host is blocked — use the split setup.

---

## Persistent storage

Whatever the shape, mount a volume at `SWING_DATA_DIR`:

| Host | What to do |
|---|---|
| Render | Add a Disk, mount at `/app/data` (paid tier only) |
| Railway | Add a Volume, mount at `/app/data` |
| Fly.io | `fly volumes create scanner_data`, mount in `fly.toml` |
| VPS / Docker | The provided `docker-compose.yml` already uses a named volume |

Without it: on the hosted API you lose journal history on each deploy. On a
full-stack host you lose **open swing positions**, which is a real problem
rather than a cosmetic one.

---

## Free-tier sleep

Render and similar free tiers idle a service after ~15 minutes without
traffic. Two consequences:

- **The scan loop stops.** Anything time-based (the 15:15 square-off, the
  15:45 swing scan) silently doesn't happen.
- **The first visitor waits** ~30s for a cold start.

Don't run the scanner half on a sleeping tier. The ingest-mode API is fine —
an incoming push wakes it. If you want the demo page snappy, an uptime pinger
against `/api/public/health` every 10 minutes keeps it warm.

---

## Before you go live

- [ ] `API_KEY` set. Without it, admin and ingest endpoints return 503 — they
      fail closed, so an unset key disables them rather than exposing them.
- [ ] `PUBLIC_MODE=true` if the URL is on your portfolio. Rupee P&L becomes
      R-multiples; position sizes and capital deployed are stripped.
- [ ] `CORS_ORIGIN` set to your site's origin, not `*`.
- [ ] Volume mounted at `SWING_DATA_DIR`.
- [ ] Real risk numbers in `src/config/*Constants.js` reviewed — the committed
      values are placeholders, and they're public once you push.
- [ ] HTTPS. The API key travels in a header; over plain HTTP it's readable.
- [ ] `npm test` passes (193 assertions).

---

## Calling it from your site

```js
// Recent signals
const res = await fetch('https://your-api.example.com/api/public/signals/recent?limit=20');
const { signals } = await res.json();

// Live stream
const es = new EventSource('https://your-api.example.com/api/public/stream');
es.addEventListener('signal', (e) => {
  const sig = JSON.parse(e.data);
  if (sig.replay) return;        // history sent on connect
  renderSignal(sig);
});
```

Handle the market-closed case explicitly. `/api/public/market/status` returns
`phase` and `scanner.reporting` precisely so the UI can say *why* a feed is
empty rather than showing a blank panel — NSE is open roughly 31 of the 168
hours in a week, so "closed" is the common case, not the edge case.

Never put the API key in front-end code. Everything under `/api/public` is
unauthenticated by design; anything needing a key is server-side only.

---

## Operating notes

- **Update the NSE holiday list every year.** It's hardcoded in
  `src/services/marketStatus.js` and can't be derived from a rule. The API
  exposes `holidayDataStale` so a consumer can detect when it's out of date.
- **Rate limiting is in-memory.** Fine for one instance; move to Redis if you
  ever run more than one.
- **The journal rotates at 50k records**, keeping the newest 25k and archiving
  the rest next to it.
- **Watch `/api/ingest/status`** if you're running split. It's the difference
  between a quiet market and a dead scanner.
