// NSE equity calendar. Source to verify annually:
// https://www.nseindia.com/resources/exchange-communication-holidays
// Existing repository dates retained pending official verification; not a bank calendar.
module.exports = {
  2026: {
    verified: false,
    source: 'https://www.nseindia.com/resources/exchange-communication-holidays',
    holidays: [
  '2026-01-26', // Republic Day
  '2026-03-04', // Holi
  '2026-03-21', // Id-ul-Fitr
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
],
    // Explicit special sessions: 'YYYY-MM-DD': { open: {h,m}, close: {h,m}, complete: {h,m} }
    sessions: {},
  },
};
