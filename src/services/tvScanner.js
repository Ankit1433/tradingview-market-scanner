/**
 * Hits TradingView's screener endpoint directly (scanner.tradingview.com),
 * same as the Python version's get_stocks()/get_early_stocks(). This is
 * TradingView's internal endpoint, not a documented public API - same
 * caveat applies here as it did in the Python scanner: fine for personal
 * use, a grey area if you lean on it for anything commercial/public-facing.
 */

const axios = require('axios');

const URL = 'https://scanner.tradingview.com/india/scan?label-product=screener-stock';

const HEADERS = {
  accept: 'application/json',
  'content-type': 'text/plain;charset=UTF-8',
  origin: 'https://in.tradingview.com',
  referer: 'https://in.tradingview.com/',
  'user-agent': 'Mozilla/5.0',
};

const BASE_COLUMNS = [
  'ticker-view', 'close', 'type', 'typespecs', 'pricescale', 'minmov',
  'fractional', 'minmove2', 'currency', 'change', 'volume',
  'relative_volume_10d_calc', 'market_cap_basic', 'fundamental_currency_code',
  'price_earnings_ttm', 'earnings_per_share_diluted_ttm',
  'earnings_per_share_diluted_yoy_growth_ttm', 'dividends_yield_current',
  'sector.tr', 'market', 'sector', 'AnalystRating', 'AnalystRating.tr',
];

const TYPE_FILTER = {
  operator: 'and',
  operands: [
    {
      operation: {
        operator: 'or',
        operands: [
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'dr' } },
          ] } },
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'fund' } },
            { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual'] } },
          ] } },
        ],
      },
    },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
  ],
};

function buildPayload({ changeFilter, relVolume, atrp, avgVolume }) {
  return {
    columns: BASE_COLUMNS,
    filter: [
      { left: 'close', operation: 'in_range', right: [100, 3000] },
      changeFilter,
      { left: 'ATRP', operation: 'greater', right: atrp },
      { left: 'average_volume_10d_calc', operation: 'greater', right: avgVolume },
      { left: 'is_blacklisted', operation: 'equal', right: false },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: relVolume },
      { left: 'is_primary', operation: 'equal', right: true },
    ],
    ignore_unknown_fields: false,
    options: { lang: 'en' },
    range: [0, 100],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    markets: ['india'],
    filter2: TYPE_FILTER,
  };
}

// Main scan: change > 2%, rel vol > 2, ATRP > 2
const PAYLOAD = buildPayload({
  changeFilter: { left: 'change', operation: 'greater', right: 2 },
  relVolume: 2,
  atrp: 2,
  avgVolume: 500000,
});

// Early scan: catches names still building (0.5% - 3% change, lower thresholds)
const EARLY_PAYLOAD = buildPayload({
  changeFilter: { left: 'change', operation: 'in_range', right: [0.5, 3] },
  relVolume: 1.2,
  atrp: 1.5,
  avgVolume: 500000,
});

function mapResults(data) {
  const stocks = {};
  for (const item of data) {
    const symbol = item.s.replace('NSE:', '');
    const d = item.d;
    stocks[symbol] = {
      price: d[1],
      change: d[9],
      relVolume: d[11],
      sector: d[20],
    };
  }
  return stocks;
}

async function fetchScan(payload) {
  const res = await axios.post(URL, payload, { headers: HEADERS, timeout: 15000 });
  return mapResults(res.data.data);
}

/** Main scan universe - mirrors get_stocks(). Throws on HTTP/parse failure, same as the Python version. */
async function getStocks() {
  return fetchScan(PAYLOAD);
}

/** Early/building-momentum scan - mirrors get_early_stocks(). */
async function getEarlyStocks() {
  return fetchScan(EARLY_PAYLOAD);
}

module.exports = { getStocks, getEarlyStocks, PAYLOAD, EARLY_PAYLOAD };
