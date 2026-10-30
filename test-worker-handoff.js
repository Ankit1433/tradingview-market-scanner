const assert=require('node:assert/strict');
const {acquire}=require('./src/marketData/ownership');
const {details}=require('./src/operations/failureDetails');
(async()=>{
 let time=0,attempts=0,waits=0;const owners=[],deletes=[];
 const lease=await acquire({key:'telegram-fixture',waitMs:150000,clock:()=>time,sleep:async ms=>{time+=ms;},onWaiting:()=>waits++,request:async(method,table,options)=>{if(method==='delete'){deletes.push(options.params);return{};}owners.push(options.data.p_owner);return{data:++attempts===4};}});
 assert.equal(attempts,4);assert.equal(waits,1);assert.equal(time,15000);assert.equal(new Set(owners).size,1);assert.equal(deletes.length,0);await lease.stop();assert.equal(deletes[0].owner_id,'eq.'+owners[0]);
 time=0;attempts=0;await assert.rejects(acquire({waitMs:12000,clock:()=>time,sleep:async ms=>{time+=ms;},request:async()=>{attempts++;return{data:false};}}),e=>e.code==='MARKET_WORKER_ALREADY_OWNED');assert.equal(time,12000);assert.equal(attempts,4);
 let called=false;const aborted=new AbortController();aborted.abort();await assert.rejects(acquire({signal:aborted.signal,request:async()=>{called=true;}}),e=>e.code==='WORKER_ACQUISITION_CANCELLED');assert.equal(called,false);
 const cancel=new AbortController();await assert.rejects(acquire({waitMs:150000,signal:cancel.signal,onWaiting:()=>cancel.abort(),request:async()=>({data:false})}),e=>e.code==='WORKER_ACQUISITION_CANCELLED');
 const inflight=new AbortController();let released=false;await assert.rejects(acquire({signal:inflight.signal,request:async(method)=>{if(method==='delete'){released=true;return{};}inflight.abort();return{data:true};}}),e=>e.code==='WORKER_ACQUISITION_CANCELLED');assert(released);
 const diagnostic=details(Error('Supabase rpc/acquire_worker_lease request failed (HTTP 404)'),'telegram_worker');assert.equal(diagnostic.resource,'rpc/acquire_worker_lease');assert.equal(diagnostic.httpStatus,404);assert.equal(details(Object.assign(Error('MARKET_WORKER_ALREADY_OWNED'),{code:'MARKET_WORKER_ALREADY_OWNED'}),'telegram_worker').code,'MARKET_WORKER_ALREADY_OWNED');
 // Shutdown during offset hydration must not resurrect the worker afterward.
 const db=require('./src/services/supabaseStore'),ownership=require('./src/marketData/ownership');
 const original={status:db.status,loadState:db.loadState,acquire:ownership.acquire};
 let releaseOffset,offsetStarted,stops=0;const waitingOffset=new Promise(r=>offsetStarted=r);
 db.status=()=>({connected:true});db.loadState=()=>{offsetStarted();return new Promise(r=>releaseOffset=r);};ownership.acquire=async()=>({stop:async()=>stops++});
 try{const worker=require('./src/jobs/personalLoop');const pending=worker.start();await waitingOffset;await worker.stop();releaseOffset(null);await assert.rejects(pending,e=>e.code==='WORKER_ACQUISITION_CANCELLED');assert(stops>=1);}finally{db.status=original.status;db.loadState=original.loadState;ownership.acquire=original.acquire;await require('./src/services/tvHistory').closeClient();}
 console.log('Worker handoff tests passed: standby acquisition, no stealing, stable owner, bounded timeout, cancellation before/during acquisition, owner-scoped release and safe startup diagnostics.');
})().catch(e=>{console.error(e);process.exitCode=1;});
