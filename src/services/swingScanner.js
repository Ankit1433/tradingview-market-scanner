/**
 * Swing candidate universe, from the same TradingView screener endpoint the
 * intraday scanner uses but with a very different filter set.
 *
 * The intraday scan looks for what is moving RIGHT NOW (change > 2% today,
 * relative volume > 2x). That's exactly wrong for swing entries - a stock
 * already up 6% on the day is a bad swing entry, since you're buying after
 * the move with your stop far below.
 *
 * This scan instead looks for structural setup quality: liquid, sufficiently
 * volatile, in an uptrend on the weekly/daily, and NOT extended today. The
 * per-symbol daily-candle signal checks in indicators/swingSignals.js do the
 * real work; this just narrows the universe to something worth fetching
 * candles for.
 */

const axios = require('axios');
const S = require('../config/swingConstants');

const URL = 'https://scanner.tradingview.com/india/scan?label-product=screener-stock';

const HEADERS = {
  accept: 'application/json',
  'content-type': 'text/plain;charset=UTF-8',
  origin: 'https://in.tradingview.com',
  referer: 'https://in.tradingview.com/',
  'user-agent': 'Mozilla/5.0',
};

const COLUMNS = [
  'ticker-view',        // 0
  'close',              // 1
  'change',             // 2
  'volume',             // 3
  'relative_volume_10d_calc', // 4
  'market_cap_basic',   // 5
  'sector',             // 6
  'ATRP',               // 7
  'average_volume_10d_calc', // 8
  'Perf.W',             // 9  - 1 week performance
  'Perf.1M',            // 10 - 1 month performance
  'Perf.3M',            // 11 - 3 month performance
  'price_52_week_high', // 12
  'price_52_week_low',  // 13
  'SMA50',              // 14
  'SMA200',             // 15
];

const TYPE_FILTER = {
  operator: 'and',
  operands: [
    {
      operation: {
        operator: 'or',
        operands: [
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
              ],
            },
          },
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
              ],
            },
          },
        ],
      },
    },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
  ],
};

const SWING_PAYLOAD = {
  columns: COLUMNS,
  filter: [
    { left: 'close', operation: 'in_range', right: [S.SWING_MIN_PRICE, S.SWING_MAX_PRICE] },
    { left: 'average_volume_10d_calc', operation: 'greater', right: S.SWING_MIN_AVG_VOLUME },
    { left: 'market_cap_basic', operation: 'greater', right: S.SWING_MIN_MARKET_CAP },
    { left: 'ATRP', operation: 'greater', right: S.SWING_MIN_ATRP },
    { left: 'is_blacklisted', operation: 'equal', right: false },
    { left: 'is_primary', operation: 'equal', right: true },
    // Structural uptrend: price above its own 200-day average. This is the
    // single cheapest filter for "don't swing-long a downtrend".
    { left: 'close', operation: 'greater', right: 'SMA200' },
    { left: 'SMA50', operation: 'greater', right: 'SMA200' },
    // NOT extended today - a stock already up big is a poor swing entry.
    { left: 'change', operation: 'less', right: 5 },
  ],
  ignore_unknown_fields: false,
  options: { lang: 'en' },
  range: [0, S.SWING_SCAN_LIMIT],
  sort: { sortBy: 'Perf.3M', sortOrder: 'desc' }, // strongest 3-month performers first
  markets: ['india'],
  filter2: TYPE_FILTER,
};

function mapResults(data) {
  const stocks = {};
  for (const item of data) {
    const symbol = item.s.replace('NSE:', '');
    const d = item.d;
    stocks[symbol] = {
      price: d[1],
      change: d[2],
      volume: d[3],
      relVolume: d[4],
      marketCap: d[5],
      sector: d[6],
      atrp: d[7],
      avgVolume10d: d[8],
      perfWeek: d[9],
      perfMonth: d[10],
      perf3Month: d[11],
      high52w: d[12],
      low52w: d[13],
      sma50: d[14],
      sma200: d[15],
    };
  }
  return stocks;
}

/**
 * Fetch the swing candidate universe. Throws on HTTP/parse failure - the
 * caller decides how to handle it (the swing loop logs and skips the day
 * rather than retrying aggressively, since this only runs once daily).
 */
async function getSwingCandidates() {
  const res = await axios.post(URL, SWING_PAYLOAD, { headers: HEADERS, timeout: 20000 });
  return mapResults(res.data.data);
}

module.exports = { getSwingCandidates, SWING_PAYLOAD };
