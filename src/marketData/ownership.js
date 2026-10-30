const crypto=require('crypto');
const db=require('../services/supabaseStore');
function failure(code){return Object.assign(new Error(code),{code});}
function pause(ms,signal){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(failure('WORKER_ACQUISITION_CANCELLED'));return;}
 const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
 const timer=setTimeout(done,ms);
 const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(failure('WORKER_ACQUISITION_CANCELLED'));};
 signal?.addEventListener('abort',abort,{once:true});
});}
async function acquire({key='ankquant-market-workers',owner=crypto.randomUUID(),request=db.request,onLost,period=30000,waitMs=0,retryMs=5000,clock=Date.now,sleep=pause,signal,onWaiting}={}) {
 const renew=async()=>Boolean((await request('post','rpc/acquire_worker_lease',{data:{p_key:key,p_owner:owner},retries:0})).data);
 const release=()=>request('delete','worker_leases',{params:{lease_key:`eq.${key}`,owner_id:`eq.${owner}`},retries:0}).catch(()=>{});
 const deadline=clock()+waitMs;let waiting=false;
 for(;;){
  if(signal?.aborted)throw failure('WORKER_ACQUISITION_CANCELLED');
  const obtained=await renew();
  if(signal?.aborted){if(obtained)await release();throw failure('WORKER_ACQUISITION_CANCELLED');}
  if(obtained)break;
  const remaining=deadline-clock();if(remaining<=0)throw failure('MARKET_WORKER_ALREADY_OWNED');
  if(!waiting){waiting=true;onWaiting?.();}
  await sleep(Math.min(retryMs,remaining),signal);
 }
 let busy=false,stopped=false;
 const timer=setInterval(async()=>{if(busy||stopped)return;busy=true;try{if(!await renew())throw Error();}catch(_){stopped=true;clearInterval(timer);onLost?.();}finally{busy=false;}},period);timer.unref?.();
 return {async stop(){stopped=true;clearInterval(timer);await release();}};
}
module.exports={acquire};
