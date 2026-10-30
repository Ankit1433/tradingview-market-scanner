process.env.PRIVATE_MODE='false';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sessionForDate,nextTradingDay,calendarInfo}=require('./src/services/tradingCalendar');
const {UpstoxProvider}=require('./src/marketData/upstox');
const {runSteps}=require('./src/jobs/personalCycle');
const {details}=require('./src/operations/failureDetails');
(async()=>{
 assert.equal(sessionForDate('2026-03-03'),null);assert(sessionForDate('2026-03-04'));
 assert.equal(sessionForDate('2026-05-28'),null);assert(sessionForDate('2026-05-27'));
 for(const date of ['2026-01-15','2026-03-26','2026-03-31','2026-06-26','2026-11-10','2025-11-05','2025-12-25'])assert.equal(sessionForDate(date),null,date);
 assert(sessionForDate('2026-11-09'));assert.equal(nextTradingDay('2025-12-24'),'2025-12-26');assert.equal(nextTradingDay('2026-05-27'),'2026-05-29');
 assert.equal(sessionForDate('2025-02-01').open.h,9);assert.equal(sessionForDate('2025-10-21').open.h,13);assert.equal(sessionForDate('2026-02-01').close.m,30);assert.equal(nextTradingDay('2026-01-30'),'2026-02-01');assert(!calendarInfo('2026-10-30').stale);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ankquant-calendar-gap-'));
 try{
  let dates=['2026-05-27','2026-05-29'];
  const p=new UpstoxProvider({token:'fixture',clock:()=>new Date('2026-05-29T11:00:00Z'),instruments:[{segment:'NSE_EQ',instrument_type:'EQ',trading_symbol:'TEST',instrument_key:'NSE_EQ|TEST'}],cacheDir:directory,budget:{take:async()=>{}},transport:async()=>({data:{status:'success',data:{candles:dates.map(d=>[d+'T09:15:00+05:30',100,102,99,101,1000])}}})});
  assert.equal((await p.history('TEST','D',2)).length,2);
  dates=['2026-05-26','2026-05-29'];p.memory.clear();fs.rmSync(p.cacheDir,{recursive:true,force:true});
  await assert.rejects(p.history('TEST','D',2),error=>{assert.equal(error.message,'UPSTOX_DAILY_CANDLE_GAP');assert.equal(error.expectedSession,'2026-05-27');assert.equal(details(error,'daily_RELIANCE').actualSession,'2026-05-29');return true;});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 const calls=[],errors=[];
 assert.equal(await runSteps([['telegram_poll',async()=>{throw Object.assign(Error('private-token'),{code:'ETIMEDOUT'});}],['signal_discovery',async()=>calls.push('discover')],['paper_delivery',async()=>calls.push('reminder')],['alert_delivery',async()=>calls.push('alerts')]],(e,s)=>errors.push(details(e,s))),false);
 assert.deepEqual(calls,['discover','reminder','alerts']);assert.equal(errors[0].code,'ETIMEDOUT');assert(!JSON.stringify(errors).includes('private-token'));
 assert.equal(await runSteps([['telegram_poll',async()=>{throw Error();}]],()=>{},()=>false),true);
 console.log('Market recovery tests passed: corrected 2025/2026 sessions, cross-year holidays, special sessions, holiday gap acceptance, genuine missing-bar rejection and polling failure isolation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
