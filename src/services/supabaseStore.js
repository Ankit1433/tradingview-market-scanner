/**
 * Small server-only Supabase Data API adapter.
 *
 * Uses the existing Axios dependency so the local app still runs without a
 * Supabase project. New Supabase secret keys are sent only in `apikey`;
 * legacy service_role JWTs also need the Authorization header.
 */

const axios = require('axios');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
const incomplete = Boolean(SUPABASE_URL || SUPABASE_KEY) && !configured;
const isNewSecretKey = SUPABASE_KEY.startsWith('sb_secret_');

let connected = false;
let lastError = null;
let writeChain = Promise.resolve();

function requestHeaders(extra = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    'Content-Type': 'application/json',
    ...extra,
  };
  if (!isNewSecretKey) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return headers;
}

function safeError(error) {
  const status = error.response?.status;
  const code = error.code;
  return status ? `HTTP ${status}` : (code || error.message || 'unknown error');
}

async function request(method, table, options = {}) {
  if (!configured) throw new Error('Supabase is not configured');

  let lastFailure;
  const maxAttempts = Number.isInteger(options.retries) ? options.retries + 1 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await axios({
        method,
        url: `${SUPABASE_URL}/rest/v1/${table}`,
        params: options.params,
        data: options.data,
        headers: requestHeaders(options.headers),
        timeout: options.timeout || 12000,
      });
      lastError = null;
      return response;
    } catch (error) {
      lastFailure = error;
      const status = error.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === maxAttempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }

  lastError = safeError(lastFailure);
  throw new Error(`Supabase ${table} request failed (${lastError})`);
}

function enqueue(label, operation) {
  if (!connected) return;

  writeChain = writeChain
    .then(operation)
    .catch((error) => {
      lastError = safeError(error);
      console.error(`[supabase] ${label} failed: ${lastError}`);
    });
}

async function connect() {
  if (!configured) {
    connected = false;
    console.log(incomplete
      ? '[supabase] incomplete configuration; set both SUPABASE_URL and SUPABASE_SECRET_KEY'
      : '[supabase] not configured; using local file storage');
    return false;
  }

  try {
    await Promise.all([
      request('get', 'signal_events', {
        params: { select: 'id', limit: 1 },
        timeout: 5000,
        retries: 0,
      }),
      request('get', 'scanner_state', {
        params: { select: 'state_key', limit: 1 },
        timeout: 5000,
        retries: 0,
      }),
      request('get', 'paper_trades', {
        params: { select: 'trade_key', limit: 1 },
        timeout: 5000,
        retries: 0,
      }),
    ]);
    connected = true;
    console.log('[supabase] connected; durable storage enabled');
    return true;
  } catch (error) {
    connected = false;
    lastError = safeError(error);
    console.error(`[supabase] connection check failed (${lastError}); using local files`);
    return false;
  }
}

async function countSignalEvents() {
  const response = await request('head', 'signal_events', {
    params: { select: 'id' },
    headers: { Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
  });
  const range = response.headers['content-range'] || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function loadSignalEvents(maxRows) {
  const pageSize = 1000;
  const newestFirst = [];

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const limit = Math.min(pageSize, maxRows - offset);
    const response = await request('get', 'signal_events', {
      params: {
        select: 'id,event_key,occurred_at,mode,symbol,signal_types,confluence,price,levels,context',
        order: 'occurred_at.desc,id.desc',
        limit,
        offset,
      },
    });
    newestFirst.push(...response.data);
    if (response.data.length < limit) break;
  }

  let total = newestFirst.length;
  try {
    total = await countSignalEvents();
  } catch (error) {
    console.warn(`[supabase] signal count unavailable: ${safeError(error)}`);
  }

  return { rows: newestFirst, total };
}

async function upsertSignalEvents(rows) {
  if (!rows.length) return;
  const batchSize = 250;
  for (let i = 0; i < rows.length; i += batchSize) {
    await request('post', 'signal_events', {
      params: { on_conflict: 'event_key' },
      data: rows.slice(i, i + batchSize),
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    });
  }
}

async function loadState(stateKey) {
  const response = await request('get', 'scanner_state', {
    params: {
      select: 'state_key,payload,updated_at',
      state_key: `eq.${stateKey}`,
      limit: 1,
    },
  });
  return response.data[0] || null;
}

async function saveState(stateKey, payload) {
  await request('post', 'scanner_state', {
    params: { on_conflict: 'state_key' },
    data: { state_key: stateKey, payload, updated_at: new Date().toISOString() },
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

function enqueueState(stateKey, payload) {
  enqueue(`${stateKey} state write`, () => saveState(stateKey, payload));
}

async function upsertPaperTrades(rows) {
  if (!rows.length) return;
  await request('post', 'paper_trades', {
    params: { on_conflict: 'trade_key' },
    data: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

async function loadOpenPaperTrades(mode) {
  const response = await request('get', 'paper_trades', {
    params: {
      select: '*',
      mode: `eq.${mode}`,
      status: 'eq.open',
      order: 'opened_on.asc',
    },
  });
  return response.data;
}

async function loadPaperTradesForDay(mode, dateKey) {
  const response = await request('get', 'paper_trades', {
    params: {
      select: '*',
      mode: `eq.${mode}`,
      opened_on: `eq.${dateKey}`,
    },
  });
  return response.data;
}

function enqueuePaperTrades(rows) {
  if (!rows.length) return;
  enqueue('paper trade write', () => upsertPaperTrades(rows));
}

async function flush() {
  await writeChain;
}

function status() {
  return {
    configured,
    incomplete,
    connected,
    healthy: connected && !lastError,
    lastError: configured ? lastError : null,
  };
}

module.exports = {
  connect,
  countSignalEvents,
  loadSignalEvents,
  upsertSignalEvents,
  loadState,
  saveState,
  enqueue,
  enqueueState,
  upsertPaperTrades,
  enqueuePaperTrades,
  loadOpenPaperTrades,
  loadPaperTradesForDay,
  flush,
  status,
};
