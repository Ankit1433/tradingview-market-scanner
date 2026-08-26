/**
 * Market session state.
 *
 * The point of this endpoint is turning "the API returned nothing" into a
 * deliberate, explainable UI state. NSE trades roughly 31 of the 168 hours in
 * a week - a portfolio visitor on a Sunday evening will see empty arrays from
 * every live endpoint, and without this they have no way to tell a closed
 * market from a broken service.
 *
 * NSE trading holidays are not derivable from a rule (they follow multiple
 * lunar calendars and get amended), so they're a hardcoded list that needs
 * updating each year. Flagging that explicitly rather than silently reporting
 * a holiday as an open session.
 */

const { nowIST, toMinutes } = require('../config/timeUtils');
const C = require('../config/constants');
const S = require('../config/swingConstants');

// NSE trading holidays. UPDATE ANNUALLY - the exchange publishes these each
// December for the following year.
const HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-03-04', // Holi
  '2026-03-21', // Id-ul-Fitr
  '2026-04-01', // Annual bank closing
  '2026-04-03', // Good Friday
  '2026-04-14', // Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id
  '2026-08-15', // Independence Day
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-09', // Diwali Laxmi Pujan
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
];

const HOLIDAYS = new Set(HOLIDAYS_2026);
const HOLIDAY_DATA_YEAR = 2026;

const min = (t) => toMinutes(t);
const fmt = (t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;

function isHoliday(dateKey) {
  return HOLIDAYS.has(dateKey);
}

/**
 * Which phase of the session are we in? Named phases rather than a bare
 * boolean, because "closed" covers several states a UI wants to distinguish.
 */
function sessionPhase(time, weekday, dateKey) {
  if (weekday === 0 || weekday === 6) return 'weekend';
  if (isHoliday(dateKey)) return 'holiday';

  const m = min(time);
  if (m < min(C.MARKET_OPEN)) return 'pre_market';
  if (m > min(C.MARKET_CLOSE)) return 'post_market';
  if (m <= min(C.ORB_WINDOW_END)) return 'opening_range';
  if (m >= min(C.SQUARE_OFF_TIME)) return 'square_off';
  if (m > min(C.TRADING_WINDOW_END) && m < min(C.AFTERNOON_WINDOW_START)) return 'lunch_lull';
  return 'open';
}

/** Next date the market is open, as an IST date key. Looks ahead up to 14 days. */
function nextTradingDay(fromDateKey) {
  const [y, m, d] = fromDateKey.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));

  for (let i = 1; i <= 14; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const key = cursor.toISOString().slice(0, 10);
    const dow = cursor.getUTCDay(); // 0 = Sunday
    if (dow === 0 || dow === 6) continue;
    if (isHoliday(key)) continue;
    return key;
  }
  return null;
}

function getMarketStatus() {
  const { time, weekday, dateKey } = nowIST();
  const phase = sessionPhase(time, weekday, dateKey);
  const isOpen = phase === 'open' || phase === 'opening_range' || phase === 'lunch_lull' || phase === 'square_off';

  const currentYear = Number(dateKey.slice(0, 4));

  let nextOpen = null;
  if (!isOpen) {
    if (phase === 'pre_market') {
      nextOpen = { date: dateKey, time: fmt(C.MARKET_OPEN) };
    } else {
      const next = nextTradingDay(dateKey);
      nextOpen = next ? { date: next, time: fmt(C.MARKET_OPEN) } : null;
    }
  }

  return {
    isOpen,
    phase,
    nowIST: `${dateKey} ${fmt(time)}`,
    session: {
      open: fmt(C.MARKET_OPEN),
      close: fmt(C.MARKET_CLOSE),
      squareOff: fmt(C.SQUARE_OFF_TIME),
      intradayEntryWindow: `${fmt(C.TRADING_WINDOW_START)}–${fmt(C.TRADING_WINDOW_END)}`,
      afternoonWindow: `${fmt(C.AFTERNOON_WINDOW_START)}–${fmt(C.AFTERNOON_WINDOW_END)}`,
      swingScan: fmt(S.SWING_SCAN_TIME),
    },
    nextOpen,
    isHoliday: isHoliday(dateKey),
    // Surfaced rather than hidden: if the holiday list is stale, every
    // consumer should be able to tell.
    holidayDataYear: HOLIDAY_DATA_YEAR,
    holidayDataStale: currentYear !== HOLIDAY_DATA_YEAR,
  };
}

module.exports = { getMarketStatus, isHoliday, nextTradingDay, sessionPhase };
