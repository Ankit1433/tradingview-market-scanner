const {nowIST,toMinutes}=require('../config/timeUtils');
const {sessionForDate}=require('../services/tradingCalendar');
const {isBarComplete}=require('../services/dailyBars');
const previous=key=>new Date(Date.parse(`${key}T00:00:00Z`)-86400000).toISOString().slice(0,10);
function expectedLast(interval,now,delay=10000){
 let date=nowIST(now).dateKey;
 for(let i=0;i<370;i++,date=previous(date)){
  const session=sessionForDate(date);if(!session)continue;
  const midnight=Date.parse(`${date}T00:00:00+05:30`);
  if(interval==='D'){if(isBarComplete({time:(midnight+toMinutes(session.open)*60000)/1000},now))return date;continue;}
  const open=midnight+toMinutes(session.open)*60000,close=midnight+toMinutes(session.close)*60000;
  const end=Math.min(now.getTime()-delay,close),count=Math.floor((end-open)/300000);
  if(count>=1)return (open+(count-1)*300000)/1000;
 }
 throw Error('UPSTOX_CALENDAR_COVERAGE_MISSING');
}
function assertFresh(bars,interval,now,delay=10000){if(!bars?.length)throw Error('UPSTOX_NO_COMPLETED_CANDLES');const last=bars.at(-1);const actual=interval==='D'?nowIST(new Date(last.time*1000)).dateKey:last.time;if(actual!==expectedLast(interval,now,delay))throw Error(interval==='D'?'UPSTOX_STALE_DAILY_CANDLES':'UPSTOX_STALE_INTRADAY_CANDLES');}
module.exports={expectedLast,assertFresh};
