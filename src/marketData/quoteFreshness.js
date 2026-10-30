const {nowIST,toMinutes}=require('../config/timeUtils');
const {sessionForDate}=require('../services/tradingCalendar');
const {expectedLast}=require('./freshness');
function quoteIsFresh(quote,now=new Date()){
 const stamp=Date.parse(quote?.timestamp);if(!Number.isFinite(stamp)||stamp>now.getTime()+60000)return false;
 const current=nowIST(now),session=sessionForDate(current.dateKey),minute=toMinutes(current.time);
 if(session&&minute>=toMinutes(session.open)&&minute<=toMinutes(session.close))return now.getTime()-stamp<=60000;
 // Outside the live session, only the last session's final five-minute window
 // is accepted. This is a closed-session snapshot, not a live quote.
 return stamp>=expectedLast('5',now)*1000;
}
module.exports={quoteIsFresh};
