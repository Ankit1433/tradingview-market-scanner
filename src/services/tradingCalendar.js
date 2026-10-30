const years = require('../config/nseCalendar');
const { nowIST, toMinutes } = require('../config/timeUtils');
const C = require('../config/constants');
const warned = new Set();
function calendarInfo(dateKey) {
  const year = Number(dateKey.slice(0, 4));
  const config = years[year];
  const stale = !config || Boolean(config.verifiedThrough && dateKey > config.verifiedThrough);
  if ((stale || !config.verified) && !warned.has(year)) {
    warned.add(year);
    console.warn(`[calendar] NSE calendar ${year} ${stale ? 'missing/stale' : 'unverified'}; verify exchange holidays before relying on schedules`);
  }
  return { config, stale, year };
}
function isHoliday(dateKey) {
  return Boolean(calendarInfo(dateKey).config?.holidays.includes(dateKey));
}
function sessionForDate(dateKey) {
  const { config } = calendarInfo(dateKey);
  if (config?.sessions[dateKey]) return config.sessions[dateKey];
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  if (!Number.isFinite(day) || day === 0 || day === 6 || isHoliday(dateKey)) return null;
  return { open: C.MARKET_OPEN, close: C.MARKET_CLOSE };
}
function isTradingDay(dateKey) { return Boolean(sessionForDate(dateKey)); }
function nextTradingDay(fromDateKey) {
  const cursor = new Date(`${fromDateKey}T00:00:00Z`);
  for (let i = 0; i < 370; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const key = cursor.toISOString().slice(0, 10);
    if (isTradingDay(key)) return key;
  }
  return null;
}
function isScanDue(now, scheduledAt, lastScanDate) {
  const { dateKey, time } = nowIST(now);
  return isTradingDay(dateKey) && dateKey !== lastScanDate && toMinutes(time) >= toMinutes(scheduledAt);
}
module.exports = { calendarInfo, isHoliday, sessionForDate, isTradingDay, nextTradingDay, isScanDue };
