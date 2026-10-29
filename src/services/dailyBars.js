const { nowIST, toMinutes } = require('../config/timeUtils');
const { sessionForDate } = require('./tradingCalendar');
const { complete } = require('../config/swingTiming');
function barDateKey(bar) {
  if (typeof bar?.time !== 'number' || !Number.isFinite(bar.time) || bar.time <= 0) return null;
  const date = new Date(bar.time * 1000);
  return Number.isFinite(date.getTime()) ? nowIST(date).dateKey : null;
}
function isBarComplete(bar, now = new Date()) {
  const dateKey = barDateKey(bar);
  if (!dateKey || !Number.isFinite(now.getTime())) return false;
  const session = sessionForDate(dateKey);
  if (!session) return false;
  const current = nowIST(now);
  if (dateKey !== current.dateKey) return dateKey < current.dateKey;
  return toMinutes(current.time) >= Math.max(toMinutes(session.close), toMinutes(session.complete || complete));
}
function completedBars(bars, now = new Date()) { return bars.filter(bar => isBarComplete(bar, now)); }
module.exports = { barDateKey, isBarComplete, completedBars };
