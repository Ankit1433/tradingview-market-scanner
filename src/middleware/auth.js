/**
 * API key auth + rate limiting.
 *
 * Split into three tiers because a public portfolio deployment has three
 * genuinely different kinds of endpoint:
 *
 *   requireKey   - mutations and anything that controls the running process.
 *                  Without this, anyone who reads the repo can stop your
 *                  scanner or write fabricated entries into your trade journal.
 *   requirePrivate - read endpoints that expose real money (rupee P&L,
 *                  capital deployed, position sizes). Fine for you, not
 *                  something to publish to recruiters.
 *   (unguarded)  - the read endpoints your portfolio front-end actually calls.
 *
 * PUBLIC_MODE is the important flag. When it's on, private endpoints return
 * R-multiples and percentages instead of rupees, so the site can show real
 * performance without publishing your account size.
 */

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MIN || 60);

const API_KEY = process.env.API_KEY || null;
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';

/**
 * Constant-time string compare. Overkill for a personal project, but a
 * naive `===` on a secret is the kind of thing worth not writing out of habit.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractKey(req) {
  const header = req.get('x-api-key');
  if (header) return header;
  const auth = req.get('authorization');
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function hasValidKey(req) {
  if (!API_KEY) return false;
  return safeEqual(extractKey(req) || '', API_KEY);
}

/**
 * Hard gate. Fails CLOSED when no API_KEY is configured - an unset key must
 * not mean "allow everyone", which is the classic way this middleware ends
 * up doing nothing in production.
 */
function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: 'Admin endpoints are disabled because API_KEY is not set.',
      hint: 'Set API_KEY in your .env to enable them.',
    });
  }
  if (!hasValidKey(req)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  return next();
}

/**
 * Soft gate for money-revealing reads. Outside PUBLIC_MODE it's open (local
 * use); in PUBLIC_MODE it needs the key, and routes that opt in can instead
 * redact via `res.locals.redactMoney`.
 */
function requirePrivate(req, res, next) {
  if (!PUBLIC_MODE || hasValidKey(req)) {
    res.locals.redactMoney = false;
    return next();
  }
  res.locals.redactMoney = true;
  return next();
}

const buckets = new Map();

/** Fixed-window rate limiter, in-memory. Swap for Redis if this ever runs multi-instance. */
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;

  const remaining = Math.max(0, RATE_MAX_REQUESTS - bucket.count);
  res.set('X-RateLimit-Limit', String(RATE_MAX_REQUESTS));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil((bucket.start + RATE_WINDOW_MS) / 1000)));

  if (bucket.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Rate limit exceeded.', retryAfterSeconds: retryAfter });
  }

  // Opportunistic cleanup so the Map doesn't grow without bound
  if (buckets.size > 5000) {
    for (const [key, b] of buckets) {
      if (now - b.start > RATE_WINDOW_MS) buckets.delete(key);
    }
  }

  return next();
}

/**
 * Converts rupee figures to R-multiples / percentages. Lets the portfolio
 * site show genuine performance without publishing account size.
 */
function redactMoney(value, riskPerTrade) {
  if (value === null || value === undefined) return null;
  if (!riskPerTrade || riskPerTrade <= 0) return null;
  return Number((value / riskPerTrade).toFixed(2));
}

module.exports = {
  requireKey,
  requirePrivate,
  rateLimit,
  redactMoney,
  hasValidKey,
  PUBLIC_MODE,
  API_KEY_CONFIGURED: Boolean(API_KEY),
};
