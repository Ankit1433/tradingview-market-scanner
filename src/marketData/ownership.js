const crypto=require('crypto');
const db=require('../services/supabaseStore');
async function acquire({key='ankquant-market-workers',owner=crypto.randomUUID(),request=db.request,onLost,period=30000}={}) {
 const renew=async()=>Boolean((await request('post','rpc/acquire_worker_lease',{data:{p_key:key,p_owner:owner},retries:0})).data);
 if(!await renew())throw new Error('MARKET_WORKER_ALREADY_OWNED');
 let busy=false,stopped=false;
 const timer=setInterval(async()=>{if(busy||stopped)return;busy=true;try{if(!await renew())throw Error();}catch(_){stopped=true;clearInterval(timer);onLost?.();}finally{busy=false;}},period);timer.unref?.();
 return {async stop(){stopped=true;clearInterval(timer);await request('delete','worker_leases',{params:{lease_key:`eq.${key}`,owner_id:`eq.${owner}`},retries:0}).catch(()=>{});}};
}
module.exports={acquire};
