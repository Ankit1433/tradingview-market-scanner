/**
 * IST time helpers. Python compared datetime.time objects directly
 * (e.g. MARKET_OPEN <= now.time() <= MARKET_CLOSE); here we work with
 * {h, m} objects and plain Date, converted to IST wall-clock time.
 */

const IST_TZ = 'Asia/Kolkata';

/** Current moment, plus its IST wall-clock time and weekday. */
function nowIST() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TZ,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const h = parseInt(get('hour'), 10) % 24;
  const m = parseInt(get('minute'), 10);
  const s = parseInt(get('second'), 10);
  const weekdayStr = get('weekday'); // 'Mon', 'Tue', ...
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    date: now,
    time: { h, m, s },
    weekday: weekdayMap[weekdayStr], // 0 = Sunday, 6 = Saturday (matches Python's .weekday() being 0=Mon is DIFFERENT - see isWeekend below)
    dateKey: `${get('year')}-${get('month')}-${get('day')}`, // stable per-IST-day key, replaces Python's now.date()
    label: `${get('day')}-${get('month')}-${get('year')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  };
}

/** Python's now.weekday() >= 5 means Sat(5)/Sun(6). Our weekday map above is 0=Sun..6=Sat. */
function isWeekend(weekdaySun0) {
  return weekdaySun0 === 0 || weekdaySun0 === 6;
}

const toMinutes = (t) => t.h * 60 + t.m;

const timeLte = (a, b) => toMinutes(a) <= toMinutes(b);
const timeGte = (a, b) => toMinutes(a) >= toMinutes(b);
const timeBetween = (t, start, end) => timeGte(t, start) && timeLte(t, end);

function formatTime(t) {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

module.exports = { nowIST, isWeekend, timeLte, timeGte, timeBetween, toMinutes, formatTime, IST_TZ };
