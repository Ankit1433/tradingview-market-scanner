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

const { calendarInfo, isHoliday, nextTradingDay, sessionForDate } = require('./tradingCalendar');
const min = (t) => toMinutes(t);
const fmt = (t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;

/**
 * Which phase of the session are we in? Named phases rather than a bare
 * boolean, because "closed" covers several states a UI wants to distinguish.
 */
function sessionPhase(time, weekday, dateKey) {
  const session = sessionForDate(dateKey);
  if (!session) return weekday === 0 || weekday === 6 ? 'weekend' : 'holiday';

  const m = min(time);
  if (m < min(session.open)) return 'pre_market';
  if (m > min(session.close)) return 'post_market';
  if (m <= min(C.ORB_WINDOW_END)) return 'opening_range';
  if (m >= min(C.SQUARE_OFF_TIME)) return 'square_off';
  if (m > min(C.TRADING_WINDOW_END) && m < min(C.AFTERNOON_WINDOW_START)) return 'lunch_lull';
  return 'open';
}

function getMarketStatus(now = new Date()) {
  const { time, weekday, dateKey } = nowIST(now);
  const phase = sessionPhase(time, weekday, dateKey);
  const isOpen = phase === 'open' || phase === 'opening_range' || phase === 'lunch_lull' || phase === 'square_off';

  const session = sessionForDate(dateKey);

  let nextOpen = null;
  if (!isOpen) {
    if (phase === 'pre_market') {
      nextOpen = { date: dateKey, time: fmt(session?.open || C.MARKET_OPEN) };
    } else {
      const next = nextTradingDay(dateKey);
      nextOpen = next ? { date: next, time: fmt(sessionForDate(next)?.open || C.MARKET_OPEN) } : null;
    }
  }

  const calendar=calendarInfo(dateKey);
  return {
    isOpen,
    phase,
    nowIST: `${dateKey} ${fmt(time)}`,
    session: {
      open: fmt(session?.open || C.MARKET_OPEN),
      close: fmt(session?.close || C.MARKET_CLOSE),
      squareOff: fmt(C.SQUARE_OFF_TIME),
      intradayEntryWindow: `${fmt(C.TRADING_WINDOW_START)}–${fmt(C.TRADING_WINDOW_END)}`,
      afternoonWindow: `${fmt(C.AFTERNOON_WINDOW_START)}–${fmt(C.AFTERNOON_WINDOW_END)}`,
      swingScan: fmt(S.SWING_SCAN_TIME),
    },
    nextOpen,
    isHoliday: isHoliday(dateKey),
    // Surfaced rather than hidden: if the holiday list is stale, every
    // consumer should be able to tell.
    holidayDataYear: Math.max(...Object.keys(require('../config/nseCalendar')).map(Number)),
    holidayDataStale: calendar.stale,
    holidayDataVerified: calendar.verified,
    holidayCalendar: {year:calendar.year,verifiedThrough:calendar.config?.verifiedThrough||null,checkedAt:calendar.config?.checkedAt||null,source:calendar.config?.source||null,reason:calendar.reason,pendingSpecialSessions:calendar.config?.pendingSpecialSessions||[],policy:'Unknown years use weekday fallback; pending special-session times are not guessed'},
  };
}

module.exports = { getMarketStatus, isHoliday, nextTradingDay, sessionPhase };
