/**
 * Telegram alert sending + on-demand /commands via getUpdates polling.
 * Mirrors send_message()/safe_send()/the cmd_*()/process_telegram_commands()
 * block. BOT_TOKEN and CHAT_ID come from .env - never hardcode them here.
 */

const axios = require("axios");
const { state } = require("../state/dailyState");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn(
      "[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set - skipping send:",
      message.split("\n")[0],
    );
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await axios.post(url, {
    chat_id: CHAT_ID,
    text: message,
    disable_web_page_preview: true,
  });
  if (res.status !== 200) console.log(res.data);
}

/**
 * Outbound alert queue.
 *
 * Telegram enforces roughly 1 message/second to a given chat. A scan cycle
 * that finds a lot of setups at once - a busy swing scan, a volatile
 * intraday session - can produce dozens of alerts within the same second.
 * Firing them all immediately (the original behaviour) means most come back
 * 429, and the old safeSend() just logged and discarded them: alerts were
 * silently lost, not delayed.
 *
 * This queues instead of dropping. One send in flight at a time, spaced by
 * MIN_INTERVAL_MS, with the send that got 429'd retried (Telegram's
 * response includes a retry_after in seconds; honoured when present, with a
 * fallback delay otherwise) rather than discarded.
 *
 * Bounded, same reasoning as pushClient's queue: if something is badly wrong
 * upstream, this drops the OLDEST backlog rather than growing without limit
 * and holding increasingly stale alerts.
 */
const MIN_INTERVAL_MS = 1100; // just over Telegram's ~1/s ceiling, as margin
const MAX_QUEUE = 200;
const MAX_RETRIES = 3;

const queue = [];
let draining = false;
let lastSendAt = 0;

function enqueue(msg) {
  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.shift();
    console.warn(
      `[telegram] queue full (${MAX_QUEUE}) - dropped oldest alert: ${dropped.msg.split("\n")[0]}`,
    );
  }
  queue.push({ msg, attempts: 0 });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastSendAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const item = queue.shift();
    lastSendAt = Date.now();

    try {
      await sendMessage(item.msg);
    } catch (e) {
      const status = e.response?.status;

      if (status === 429) {
        item.attempts += 1;
        // Telegram tells you exactly how long to back off; trust it over a guess.
        const retryAfterSec = e.response?.data?.parameters?.retry_after;
        const backoffMs = retryAfterSec
          ? retryAfterSec * 1000 + 200
          : MIN_INTERVAL_MS * 3;

        if (item.attempts <= MAX_RETRIES) {
          console.warn(
            `[telegram] 429, retry ${item.attempts}/${MAX_RETRIES} in ${backoffMs}ms: ${item.msg.split("\n")[0]}`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          queue.unshift(item); // requeue at the front - preserve order
        } else {
          console.error(
            `[telegram] giving up after ${MAX_RETRIES} retries: ${item.msg.split("\n")[0]}`,
          );
        }
      } else {
        // Non-rate-limit failure (bad token, network blip) - matches the
        // original safeSend contract: log it, move on, never throw into the
        // scan loop.
        console.error(`[send_message failed] ${e.message}`);
      }
    }
  }

  draining = false;
}

/**
 * Never let a messaging failure kill the scan loop. Now queues + throttles
 * rather than firing immediately, so a burst of alerts is delivered in
 * order over the next several seconds instead of mostly being dropped to
 * 429s.
 */
async function safeSend(msg) {
  enqueue(msg);
}

/** Current backlog size - exposed for /api/public/health if useful later. */
function queueDepth() {
  return queue.length;
}

/** Shared price/change/volume/sector block, used on every alert type. Mirrors fmt_info(). */
function fmtInfo(info) {
  const price = info.price || 0;
  const change = info.change || 0;
  const relVol = info.relVolume || 0;
  const sector = info.sector || "-";
  return `💰 ₹${price.toFixed(2)}  |  📈 ${change >= 0 ? "+" : ""}${change.toFixed(2)}%  |  📊 ${relVol.toFixed(1)}x vol\n🏷 ${sector}`;
}

function fmtStockLine(stock, info) {
  const price = info.price || 0;
  const change = info.change || 0;
  return `${stock}: ₹${price.toFixed(2)} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`;
}

function stocksFor(alertedSet, label, emoji) {
  const stocks = [...alertedSet].filter((s) => state.current[s]).sort();
  if (stocks.length === 0) return `${emoji} No ${label} signals yet today.`;
  const lines = stocks.map((s) => fmtStockLine(s, state.current[s]));
  return `${emoji} ${label} today (${stocks.length}):\n${lines.slice(0, 50).join("\n")}`;
}

function cmdStocks() {
  const symbols = Object.keys(state.current).sort();
  if (symbols.length === 0) return "📋 No stocks currently tracked.";
  const lines = symbols.map((s) => fmtStockLine(s, state.current[s]));
  let body = lines.slice(0, 50).join("\n");
  if (lines.length > 50) body += `\n... and ${lines.length - 50} more`;
  return `📋 Tracking ${symbols.length} stocks:\n${body}`;
}

const cmdMomentum = () => stocksFor(state.momentumAlerted, "Momentum", "⚡");
const cmdPullback = () => stocksFor(state.pullbackAlerted, "Pullback", "🎯");
const cmdVolume = () => stocksFor(state.volumeAlerted, "Volume spike", "📊");
const cmdVwap = () => stocksFor(state.vwapAlerted, "VWAP reclaim", "📈");
const cmdRunner = () =>
  stocksFor(state.noPullbackAlerted, "No-pullback runner", "🏃");
const cmdAfternoon = () =>
  stocksFor(state.afternoonBreakoutAlerted, "Afternoon breakout", "🌇");
const cmdStrong = () =>
  stocksFor(state.confluenceAlertedStocks, "Strong setup (confluence)", "💎");

function cmdPositions() {
  const openOnes = Object.entries(state.openPositions).filter(
    ([, p]) => !p.closed,
  );
  if (openOnes.length === 0) return "📌 No open positions right now.";
  const lines = openOnes.map(([s, p]) => {
    const curPrice = state.current[s] ? state.current[s].price : p.entry;
    const qty = p.partialBooked ? p.runnerQty : p.qty;
    const unrealized = qty * (curPrice - p.entry);
    const stage = p.partialBooked ? "runner (partial booked)" : "full position";
    return (
      `${s} [${stage}]: entry ₹${p.entry.toFixed(2)}  qty ${qty}  ` +
      `stop ₹${p.stop.toFixed(2)}  unrealized ₹${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(0)}`
    );
  });
  return `📌 Open positions:\n${lines.join("\n")}`;
}

// ---------- Swing commands ----------
// Required lazily inside each handler rather than at module top-level: the
// swing state module and this one would otherwise form a require cycle via
// swingPositionManager -> telegram -> swingState.

function cmdSwingPositions() {
  const swingState = require("../state/swingState");
  const S = require("../config/swingConstants");
  const open = swingState.openPositionsList();
  if (open.length === 0) return "📊 No open swing positions.";

  const lines = open.map((p) => {
    const stage = p.partialBooked ? "runner" : "full";
    const qty = p.partialBooked ? p.runnerQty : p.qty;
    const rNow =
      p.riskPerShare > 0
        ? ((p.highest - p.entry) / p.riskPerShare).toFixed(2)
        : "-";
    return (
      `${p.symbol} [${stage}] ${qty} qty\n` +
      `  entry ₹${p.entry.toFixed(2)} | stop ₹${p.stop.toFixed(2)} | target ₹${p.target.toFixed(2)}\n` +
      `  ${p.barsHeld}d held | peak ${rNow}R | ${(p.signals || []).join(", ")}`
    );
  });
  return `📊 Swing positions (${open.length}/${S.SWING_MAX_OPEN_POSITIONS}):\n${lines.join("\n")}`;
}

function cmdSwingStats() {
  const swingState = require("../state/swingState");
  const state = swingState.getState();
  const trades = state.closedTrades;
  if (trades.length === 0) return "📈 No closed swing trades yet.";

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const pnl = state.totalRealizedPnl;
  const c = state.counters;

  return (
    `📈 Swing stats\n` +
    `Trades: ${trades.length}  |  Wins: ${wins.length} (${((wins.length / trades.length) * 100).toFixed(0)}%)\n` +
    `Realized P&L: ₹${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}\n` +
    (wins.length
      ? `Avg win: ₹${(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0)}\n`
      : "") +
    (losses.length
      ? `Avg loss: ₹${(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0)}\n`
      : "") +
    `Exits — 🛑 ${c.stopHits} stop | 🎯 ${c.targetHits} target | 🏁 ${c.trailExits} trail | ⏳ ${c.timeStops} time`
  );
}

function cmdHelp() {
  return [
    "INTRADAY:",
    "/stocks - all currently tracked stocks",
    "/momentum - momentum signals today",
    "/pullback - pullback signals today",
    "/volume - volume spike signals today",
    "/vwap - VWAP reclaim signals today",
    "/runner - no-pullback runner signals today",
    "/afternoon - afternoon coiled-base breakout signals today (1pm-3:10pm)",
    "/strong - confluence (STRONG SETUP) stocks today",
    "/positions - currently open intraday positions",
    "",
    "SWING:",
    "/swing - open swing positions",
    "/swingstats - swing win rate and P&L",
    "",
    "/help - this list",
  ].join("\n");
}

const COMMAND_HANDLERS = {
  "/stocks": cmdStocks,
  "/momentum": cmdMomentum,
  "/pullback": cmdPullback,
  "/volume": cmdVolume,
  "/vwap": cmdVwap,
  "/runner": cmdRunner,
  "/afternoon": cmdAfternoon,
  "/strong": cmdStrong,
  "/positions": cmdPositions,
  "/swing": cmdSwingPositions,
  "/swingstats": cmdSwingStats,
  "/help": cmdHelp,
  "/start": cmdHelp,
};

async function getTelegramUpdates(offset) {
  if (!BOT_TOKEN) return [];
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
  const params = { timeout: 0 };
  if (offset !== null && offset !== undefined) params.offset = offset;
  try {
    const res = await axios.get(url, { params, timeout: 10000 });
    return res.data.result || [];
  } catch (e) {
    console.error(`getTelegramUpdates error: ${e.message}`);
    return [];
  }
}

/**
 * Checks for new /commands since the last check and replies to each.
 * Handles both 'message' (groups/DMs) and 'channel_post' (channels) - only
 * checking 'message' silently misses everything if CHAT_ID is a channel.
 */
async function processTelegramCommands() {
  const updates = await getTelegramUpdates(state.telegramLastUpdateId);
  for (const update of updates) {
    state.telegramLastUpdateId = update.update_id + 1;
    const msg = update.message || update.channel_post || {};
    const text = (msg.text || "").trim();
    if (!text.startsWith("/")) continue;

    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase(); // strips args + @BotName suffix
    const handler = COMMAND_HANDLERS[command];
    let reply;
    try {
      reply = handler
        ? handler()
        : `Unknown command: ${command}\nSend /help for the list.`;
    } catch (e) {
      reply = `Error handling ${command}: ${e.message}`;
    }
    await safeSend(reply);
  }
}

module.exports = {
  sendMessage,
  safeSend,
  queueDepth,
  fmtInfo,
  fmtStockLine,
  processTelegramCommands,
  cmdStocks,
  cmdPositions,
  cmdSwingPositions,
  cmdSwingStats,
  cmdHelp,
};
