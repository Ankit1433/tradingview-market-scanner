function parseTime(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name} must be HH:MM in IST`);
  const [h, m] = value.split(':').map(Number);
  if (h * 60 + m < 15 * 60 + 30) throw new Error(`${name} must be at or after 15:30 IST`);
  return { h, m };
}
const complete = parseTime('SWING_BAR_COMPLETE_TIME', '15:45');
const scan = parseTime('SWING_SCAN_TIME', process.env.SWING_BAR_COMPLETE_TIME || '15:45');
if (scan.h * 60 + scan.m < complete.h * 60 + complete.m) throw new Error('SWING_SCAN_TIME must not precede SWING_BAR_COMPLETE_TIME');
module.exports = { complete, scan };
