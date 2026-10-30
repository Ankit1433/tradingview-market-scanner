const workerStatus=require('../operations/workerStatus');
const journal=require('../state/signalJournal');
const store=require('../state/outcomeStore');
const {evaluate,eligible}=require('../evidence/outcomes');
const {getHist,INTERVAL}=require('../services/tvHistory');
let timer=null,active=null,stopped=true;
async function run({now=new Date(),signals=journal.iterateAll(),fetchHistory=getHist,push=require('../services/pushClient').pushOutcomes}={}){
 const cache=new Map();let evaluated=0,skipped=0;
 for await(const signal of signals){if(!eligible(signal))continue;const old=store.get(signal.eventKey);
 if(old?.status==='complete'){await push([old]);skipped++;continue;}
 const key=`${signal.symbol}:${signal.mode}`;
 if(!cache.has(key)){if(cache.size>=50)cache.clear();try{cache.set(key,await fetchHistory(signal.symbol,'NSE',signal.mode==='swing'?INTERVAL.IN_DAILY:INTERVAL.IN_5_MINUTE,5000)||[]);}catch(_){workerStatus.failure('outcomes',now);cache.set(key,[]);}}
 const result=evaluate(signal,cache.get(key),now);store.save(result);await push([result]);evaluated++;
 }
 workerStatus.activity('outcomes','evaluated',evaluated,now);
 return {evaluated,skipped};
}
function start({clock=()=>new Date()}={}){if(!stopped)return;stopped=false;workerStatus.start('outcomes');const tick=async()=>{active=workerStatus.run('outcomes',()=>run({now:clock()}),clock);try{await active;}catch(_){console.warn('[outcomes] evaluation failed; retrying next pass');}finally{active=null;if(!stopped){workerStatus.scheduled('outcomes',15*60*1000,clock());timer=setTimeout(tick,15*60*1000);timer.unref?.();}}};tick();}
async function stop(){stopped=true;workerStatus.stop('outcomes');clearTimeout(timer);if(active)await active;}
module.exports={run,start,stop};
