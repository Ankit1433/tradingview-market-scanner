process.env.PRIVATE_MODE = 'false';
process.env.SWING_DATA_DIR='/tmp/ankquant-evidence-tests';process.env.API_KEY='test-evidence-key';process.env.ENABLE_INTRADAY='false';process.env.ENABLE_SWING='false';
const assert=require('node:assert/strict'),fs=require('fs');fs.rmSync(process.env.SWING_DATA_DIR,{recursive:true,force:true});
const {evaluate,aggregate,eligible}=require('./src/evidence/outcomes');
const {nextTradingDay,isTradingDay}=require('./src/services/tradingCalendar');
const {replay}=require('./src/backtest/swingBacktest');
const {closeClient}=require('./src/services/tvHistory');
const store=require('./src/state/outcomeStore');
const bar=(date,price=100)=>({time:Date.parse(`${date}T09:15:00+05:30`)/1000,open:price,high:price+1,low:price-1,close:price,volume:1000});
const signal={eventKey:'a'.repeat(64),ts:'2026-10-21T10:15:00Z',symbol:'TEST',mode:'swing',signals:['BASE BREAKOUT','MA STACK'],confluence:true,levels:{entry:100,stop:90},context:{sector:'IT'}};
let n=0;function check(name,fn){fn();console.log(`  ✓ ${name}`);n++;}
async function main(){let date='2026-10-21';const days=Array.from({length:5},()=>{date=nextTradingDay(date);return date;});const bars=days.map(d=>bar(d));const now=new Date('2026-11-01T12:00:00Z');
 check('eligible requires positive long risk',()=>{assert(eligible(signal));assert(!eligible({...signal,levels:{entry:90,stop:100}}));});
 const collision=[{...bars[0],low:89,high:130},...bars.slice(1)];const result=evaluate(signal,collision,now);
 check('same-bar collision uses stop first',()=>{assert.equal(result.firstHit.kind,'stop');assert.equal(result.resultR,-1);});
 check('derived target and session horizons are explicit',()=>{assert.equal(result.target,125);assert.equal(result.targetSource,'derived');assert.equal(result.horizons['3'].date,days[2]);assert.equal(result.status,'complete');});
 check('excursions and horizon returns continue after exit',()=>{assert.equal(result.horizons['5'].mfeR,3);assert.equal(result.horizons['5'].maeR,1.1);assert.equal(result.horizons['5'].returnR,0);});
 check('recorded target overrides derivation',()=>assert.equal(evaluate({...signal,levels:{...signal.levels,target:110}},bars,now).target,110));
 check('missing early bar cannot invent later first hit',()=>{const r=evaluate(signal,collision.slice(1),now);assert.equal(r.status,'unavailable');assert.equal(r.resultR,null);assert.equal(r.firstHit,null);});
 check('future sessions are pending',()=>assert.equal(evaluate(signal,[],new Date(signal.ts)).status,'pending'));
 const intra={...signal,mode:'intraday',ts:'2026-10-21T09:45:00+05:30'};const intrabars=[];for(let minute=45;minute<390;minute+=5){const t=Date.parse('2026-10-21T09:00:00+05:30')/1000+minute*60;intrabars.push({...bar('2026-10-21'),time:t});}
 const ir=evaluate(intra,intrabars,now);check('intraday excludes signal bar and covers EOD',()=>{assert.equal(ir.status,'complete');assert.equal(ir.target,110);assert.equal(ir.horizons.eod.returnR,0);});
 check('intraday signal-bar extremes do not contaminate outcome',()=>{const r=evaluate(intra,[{...intrabars[0],high:500,low:1},...intrabars.slice(1)],now);assert.equal(r.firstHit,null);});
 check('missing last intraday candle remains unavailable',()=>assert.equal(evaluate(intra,intrabars.slice(0,-1),now).status,'unavailable'));
 check('aggregation shows denominators and small samples',()=>{const a=aggregate([result,evaluate({...signal,eventKey:'b'.repeat(64)},[],now)]);assert.equal(a.overall.eligible,2);assert.equal(a.overall.resultR.n,1);assert(a.bySector.IT.resultR.warning);assert.equal(a.byLabel['BASE BREAKOUT'].eligible,2);assert.equal(a.overall.horizons['5'].returnR.n,1);});
 check('warning clears at 30 finite observations',()=>assert.equal(aggregate(Array(30).fill(result)).overall.resultR.warning,null));
 store.save(result);store.save(result);check('idempotent local upsert',()=>assert.equal(store.all().length,1));
 delete require.cache[require.resolve('./src/state/outcomeStore')];check('restart restores evidence',()=>assert.equal(require('./src/state/outcomeStore').get(signal.eventKey).resultR,-1));
 store.save({...result,evaluatedAt:'2020-01-01T00:00:00Z',resultR:99});check('older replay cannot overwrite newer result',()=>assert.equal(store.get(signal.eventKey).resultR,-1));
 const {run}=require('./src/jobs/outcomeLoop');let fetched=0,pushed=0;await run({signals:[signal],now,fetchHistory:async()=>{fetched++;return bars;},push:async()=>{pushed++;return true;}});
 check('completed checkpoints skip fetching and retry forwarding',()=>{assert.equal(fetched,0);assert.equal(pushed,1);});
 const journal=require('./src/state/signalJournal');journal.record({...signal,eventKey:'c'.repeat(64)});fs.copyFileSync(journal.JOURNAL_FILE,journal.JOURNAL_FILE+'.1.archive');let count=0;for await(const r of journal.iterateAll())count++;check('historical iterator deduplicates active and archived records',()=>assert.equal(count,1));
 const history=[];date='2026-01-01';while(history.length<70){if(isTradingDay(date))history.push(bar(date));const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);date=d.toISOString().slice(0,10);}
 const evaluator=async(symbol,index,{candles})=>({atr:2,signals:[{label:'BASE BREAKOUT',entry:candles.at(-1).close,structuralStop:95},{label:'MA STACK',entry:null,structuralStop:null},{label:'52W HIGH',entry:null,structuralStop:null}]});
 const options={symbols:{TEST:history},index:history,now,evaluate:evaluator};const bt=await replay(options);const changed=history.map((b,i)=>i>=65?{...b,high:1001,low:999,open:1000,close:1000}:b);const bt2=await replay({...options,symbols:{TEST:changed}});
 check('future mutations preserve earlier decisions',()=>assert.deepEqual(bt.decisions.filter(d=>d.decisionDate<days[0]&&d.decisionDate<require('./src/services/dailyBars').barDateKey(history[65])),bt2.decisions.filter(d=>d.decisionDate<require('./src/services/dailyBars').barDateKey(history[65]))));
 check('replay enters only after decision session',()=>assert(bt.openPositions.every(p=>p.openedOn>bt.decisions[0].decisionDate)));
 const singleSetup=async(symbol,index,opts)=>opts.candles.length===60?evaluator(symbol,index,opts):null;
 const withCollision=history.map((b,i)=>i===60?{...b,low:90,high:120}:b);
 const collisionReplay=await replay({...options,symbols:{TEST:withCollision},evaluate:singleSetup});
 check('replay stop wins collision on entry bar',()=>{assert.equal(collisionReplay.trades.length,1);assert.equal(collisionReplay.trades[0].reason,'stop');assert.equal(collisionReplay.trades[0].resultR,-1);});
 const withTarget=history.map((b,i)=>i===60?{...b,low:99,high:115,close:110}:i===61?{...b,low:99,high:101}:b);
 const targetReplay=await replay({...options,symbols:{TEST:withTarget},evaluate:singleSetup});
 check('replay books partial then exits remainder with positive R',()=>{assert.equal(targetReplay.trades.length,1);assert(targetReplay.trades[0].partial);assert(targetReplay.trades[0].resultR>0);});
 const missingOpen=history.filter((b,i)=>i!==60);const missingReplay=await replay({...options,symbols:{TEST:missingOpen},evaluate:singleSetup});
 check('missing next-session open does not create delayed fill',()=>{assert.equal(missingReplay.trades.length,0);assert.equal(missingReplay.openPositions.length,0);});
 const multi=Object.fromEntries(Array.from({length:7},(_,i)=>['TEST'+i,history]));const capReplay=await replay({...options,symbols:multi,evaluate:singleSetup});
 check('portfolio replay respects capital ceiling',()=>assert(capReplay.openPositions.reduce((sum,p)=>sum+p.remaining*p.entry,0)<=require('./src/config/swingConstants').SWING_TOTAL_CAPITAL));
 const db=require('./src/services/supabaseStore');const oldStatus=db.status,oldIter=db.iterateSignalEvents;
 db.status=()=>({connected:true});db.iterateSignalEvents=async function*(){yield {event_key:'d'.repeat(64),occurred_at:signal.ts,mode:'swing',symbol:'DBTEST',signal_types:signal.signals,levels:signal.levels};};
 const retained=[];try{for await(const r of journal.iterateAll())retained.push(r);}finally{db.status=oldStatus;db.iterateSignalEvents=oldIter;}
 check('journal iteration merges database and local retained records',()=>{assert.equal(retained.length,2);assert(retained.some(r=>r.symbol==='DBTEST'));});
 const {createServer}=require('./src/server');const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const post=(body,key)=>fetch(base+'/api/ingest/outcomes',{method:'POST',headers:{'content-type':'application/json',...(key?{'x-api-key':key}:{})},body:JSON.stringify(body)});
 check('outcome ingest requires key',()=>{});assert.equal((await post({outcomes:[result]})).status,401);
 assert.equal((await post({outcomes:[result]},process.env.API_KEY)).status,200);assert.equal((await post({outcomes:[result]},process.env.API_KEY)).status,200);
 const stats=await (await fetch(base+'/api/public/outcomes/stats')).json();check('HTTP evidence API preserves idempotent sample size',()=>{assert.equal(stats.overall.eligible,1);assert.equal(stats.label,'Paper — no slippage or fees');});
 assert.equal((await post({outcomes:[{...result,eventKey:'bad'}]},process.env.API_KEY)).status,400);
 const detail=await(await fetch(base+'/api/public/outcomes/'+signal.eventKey)).json();check('HTTP detail reports evaluated result',()=>assert.equal(detail.resultR,-1));
 }finally{await new Promise(r=>server.close(r));}
 console.log(`Evidence: ${n} checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(closeClient);
