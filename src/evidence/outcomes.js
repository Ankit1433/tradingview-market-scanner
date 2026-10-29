const { nowIST, toMinutes } = require('../config/timeUtils');
const { nextTradingDay, sessionForDate } = require('../services/tradingCalendar');
const { isBarComplete } = require('../services/dailyBars');
const C = require('../config/constants');
const S = require('../config/swingConstants');
const VERSION = 1;
const LABEL = 'Paper — no slippage or fees';
function eligible(s) {
  return ['intraday', 'swing'].includes(s.mode) && Number.isFinite(s.levels?.entry)
    && Number.isFinite(s.levels?.stop) && s.levels.entry > s.levels.stop && s.levels.stop > 0
    && Number.isFinite(Date.parse(s.ts));
}
function validBar(b) {
  return ['time','open','high','low','close'].every(k=>Number.isFinite(b[k]))
    && b.time > 0 && b.low > 0 && b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close);
}
function evaluate(s, history, now = new Date()) {
  if (!eligible(s)) return null;
  const entry = s.levels.entry, stop = s.levels.stop, risk = entry-stop;
  const recorded = Number.isFinite(s.levels.target) && s.levels.target > entry;
  const target = recorded ? s.levels.target : entry + (s.mode==='swing' ? S.SWING_TARGET_R_MULTIPLE*risk : C.TARGET_POINTS_LOW);
  const date = nowIST(new Date(s.ts)).dateKey;
  const dates = []; let day=date;
  for(let i=0;i<5;i++){day=nextTradingDay(day);dates.push(day);}
  const horizons = s.mode==='intraday' ? {eod:date} : {'1':dates[0],'3':dates[2],'5':dates[4]};
  const signalSec=Date.parse(s.ts)/1000;
  const endDate=Object.values(horizons).at(-1);
  const bars=[...new Map(history.filter(validBar).map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time).filter(b=>{
    const t=nowIST(new Date(b.time*1000)), session=sessionForDate(t.dateKey);
    if(!session || t.dateKey>endDate) return false;
    if(s.mode==='swing') return t.dateKey>date && isBarComplete(b,now);
    return t.dateKey===date && b.time>=Math.ceil(signalSec/300)*300 && b.time>signalSec
      && b.time*1000+300000<=now.getTime() && toMinutes(t.time)>=toMinutes(session.open)
      && toMinutes(t.time)<toMinutes(session.close);
  });
  // Require continuous coverage from the first eligible bar; never infer a first hit across gaps.
  const expected=[];
  if(s.mode==='swing') expected.push(...dates);
  else {
    const session=sessionForDate(date);
    if(session){const base=Date.parse(`${date}T00:00:00+05:30`)/1000;
      const start=Math.max(base+toMinutes(session.open)*60,(Math.floor(signalSec/300)+1)*300);
      for(let t=start;t<base+toMinutes(session.close)*60;t+=300)expected.push(t);}
  }
  const lookup=new Map(bars.map(b=>[s.mode==='swing'?nowIST(new Date(b.time*1000)).dateKey:b.time,b]));
  const continuous=[];for(const key of expected){if(!lookup.has(key))break;continuous.push(lookup.get(key));}
  let firstHit=null;
  for(const b of continuous){if(b.low<=stop){firstHit={kind:'stop',time:b.time,resultR:-1};break;}if(b.high>=target){firstHit={kind:'target',time:b.time,resultR:(target-entry)/risk};break;}}
  const metrics={};
  for(const [name,d] of Object.entries(horizons)){
    const needed=s.mode==='swing'?dates.indexOf(d)+1:expected.length;
    const full=needed>0 && continuous.length>=needed;
    const slice=continuous.slice(0,needed);
    const latest=slice.at(-1);
    metrics[name]={date:d,status:full?'complete':(isBarComplete({time:Date.parse(`${d}T09:15:00+05:30`)/1000},now)?'unavailable':'pending'),
      returnPct:full?(latest.close-entry)/entry*100:null,returnR:full?(latest.close-entry)/risk:null,
      mfeR:full?Math.max(0,...slice.map(b=>(b.high-entry)/risk)):null,
      maeR:full?Math.max(0,...slice.map(b=>(entry-b.low)/risk)):null};
  }
  const final=Object.values(metrics).at(-1);
  return {eventKey:s.eventKey,version:VERSION,label:LABEL,mode:s.mode,symbol:s.symbol,signals:s.signals,
    confluence:Boolean(s.confluence),sector:s.context?.sector||'Unknown',signalTs:s.ts,
    entry,stop,target,targetSource:recorded?'recorded':'derived',risk,
    firstHit,resultR:firstHit?.resultR ?? (final.status==='complete'?final.returnR:null),
    status:final.status,horizons:metrics,evaluatedAt:now.toISOString()};
}
function metric(values){const xs=values.filter(Number.isFinite);return {n:xs.length,mean:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,warning:xs.length<30?'Small sample: n < 30':null};}
function summarize(rows){return {eligible:rows.length,completed:rows.filter(r=>r.status==='complete').length,pending:rows.filter(r=>r.status==='pending').length,unavailable:rows.filter(r=>r.status==='unavailable').length,
 resultR:metric(rows.map(r=>r.resultR)),horizons:Object.fromEntries(['eod','1','3','5'].map(h=>[h,Object.fromEntries(['returnR','returnPct','mfeR','maeR'].map(k=>[k,metric(rows.map(r=>r.horizons[h]?.[k]))]))]))};}
function aggregate(rows){const group=fn=>{const m=new Map();for(const r of rows)for(const k of new Set(fn(r))){if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return Object.fromEntries([...m].map(([k,v])=>[k,summarize(v)]));};
 return {label:LABEL,version:VERSION,scope:'Persisted evaluated eligible signals; pending/unavailable rows are counted, not treated as zero returns',overall:summarize(rows),byLabel:group(r=>r.signals),byConfluence:group(r=>[String(r.confluence)]),byMode:group(r=>[r.mode]),bySector:group(r=>[r.sector])};}
module.exports={VERSION,LABEL,eligible,evaluate,aggregate,validBar};
