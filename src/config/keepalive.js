const {nowIST,toMinutes}=require('./timeUtils');
const {isHoliday}=require('../services/tradingCalendar');
function parseWindow(value='08:55-15:45') {
 const match=/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
 if(!match)throw new Error('KEEPALIVE_WINDOW must be HH:MM-HH:MM in IST');
 const start=Number(match[1])*60+Number(match[2]),end=Number(match[3])*60+Number(match[4]);
 if(start>=end)throw new Error('KEEPALIVE_WINDOW must end after it starts on the same day');
 return {start,end};
}
const window=parseWindow(process.env.KEEPALIVE_WINDOW);
const intervalMs=Number(process.env.KEEPALIVE_INTERVAL_MS||480000);
if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('KEEPALIVE_INTERVAL_MS must be an integer >= 1000');
function inWindow(now=new Date(),hours=window) {
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))return false;
 const t=nowIST(now);
 // Weekends stay excluded even if the calendar has a special weekend session.
 return t.weekday!==0&&t.weekday!==6&&!isHoliday(t.dateKey)&&toMinutes(t.time)*60+t.time.s>=hours.start*60&&toMinutes(t.time)*60+t.time.s<=hours.end*60;
}
function createHeartbeat({clock=()=>new Date(),send,enabled=()=>true,interval=intervalMs,hours=window}) {
 let last=null,inflight=false;
 return async function heartbeat(){const now=clock();if(!enabled()||!inWindow(now,hours)||inflight||(last!==null&&now.getTime()-last<interval))return false;
 last=now.getTime();inflight=true;try{await send();return true;}catch(_){return false;}finally{inflight=false;}};
}
module.exports={parseWindow,inWindow,intervalMs,createHeartbeat};
