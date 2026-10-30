const {details}=require('../operations/failureDetails');
const db=require('./supabaseStore');
let job=null,controller=null,publicState={state:'idle',phase:null},restored=false;
function errorCode(error){const code=error?.message;const known=new Set(['UPSTOX_UNIVERSE_METADATA_STALE_OR_UNVERIFIED','UPSTOX_UNIVERSE_METADATA_INVALID','UPSTOX_METADATA_DATE_INVALID','UPSTOX_PREPARATION_CANCELLED','UPSTOX_METADATA_SOURCE_ATTESTATION_REQUIRED','UPSTOX_METADATA_REPORT_NOT_PUBLISHED','UPSTOX_METADATA_SOURCE_FORBIDDEN','UPSTOX_METADATA_SOURCE_UNAVAILABLE','UPSTOX_METADATA_SCHEMA_CHANGED','UPSTOX_METADATA_ARCHIVE_INVALID','UPSTOX_METADATA_CSV_INVALID','UPSTOX_METADATA_DATE_INVALID','UPSTOX_METADATA_DATE_MISMATCH','UPSTOX_METADATA_REPORT_MISSING','UPSTOX_METADATA_DUPLICATE_OR_INVALID_SYMBOL','UPSTOX_METADATA_VALUE_OR_UNIT_INVALID','UPSTOX_METADATA_EMPTY','UPSTOX_SECTOR_METADATA_MISSING','UPSTOX_UNIVERSE_COVERAGE_INCOMPLETE','UPSTOX_COMPARISON_BASELINE_INVALID','UPSTOX_COMPARISON_BASELINE_UNAVAILABLE','UPSTOX_COMPARISON_CAPTURE_EXPIRED','UPSTOX_CORPORATE_ACTION_REVIEW_REQUIRED','UPSTOX_CORPORATE_ACTION_DATA_INVALID','UPSTOX_CORPORATE_ACTION_ISIN_INVALID']);return known.has(code)?code:details(error,'configuration').code;}
async function status(){
 if(!job&&!restored&&db.status().connected){restored=true;try{const saved=await db.loadState('upstox-preparation-report');if(saved?.payload){publicState=saved.payload;if(publicState.state==='running')publicState={...publicState,state:'interrupted',note:'Previous process stopped; retry resumes cached metadata'};}}catch(_){restored=false;}}
 return publicState;
}
function start({provider,prepare,compare,acquire,env=process.env,store=db,clock=()=>new Date()}={}){
 if(job)return {started:false,state:publicState};
 if(env.INGEST_MODE!=='true')throw Error('Run preparation on the ingest API with scanning disabled');
 if(!env.UPSTOX_ACCESS_TOKEN)throw Error('Configure the backend Upstox token first');
 if(!store.status().connected)throw Error('Preparation requires the configured database');
 if(env.UPSTOX_CHECK_ON_START==='true')throw Error('Remove UPSTOX_CHECK_ON_START and redeploy before preparation to avoid concurrent diagnostic traffic');
 const currentController=new AbortController();controller=currentController;const signal=currentController.signal;const startedAt=clock().toISOString();
 publicState={state:'running',phase:'ownership',startedAt,note:'Read-only preparation. Does not enable scanning or approve data use.'};
 const save=async()=>{await store.saveState('upstox-preparation-report',publicState);};
 job=(async()=>{
  let lease;
  try{
   lease=await (acquire||require('../marketData/ownership').acquire)({key:'ankquant-market-workers',signal,onLost:()=>currentController.abort()});
   const p=provider||require('../marketData/upstox').getProvider();
   publicState={...publicState,phase:'metadata'};await save();
   const manifest=await (prepare||require('../marketData/universe').prepareUniverse)(p,{env,signal,onProgress:progress=>{publicState={...publicState,progress};}});
   if(signal.aborted)throw Error('UPSTOX_PREPARATION_CANCELLED');
   await store.flush();await store.saveState('upstox:universe-v2',{manifest});
   publicState={...publicState,phase:'comparison',metadata:{asOf:manifest.asOf,source:manifest.source,report:manifest.report,coverage:manifest.coverage,scope:manifest.scope},progress:null};await save();
   const comparison=await (compare||require('../marketData/shadowComparison').shadowCompare)(p,manifest,{signal,onProgress:progress=>{publicState={...publicState,progress};}});
   if(signal.aborted)throw Error('UPSTOX_PREPARATION_CANCELLED');
   const artifact={universeKey:manifest.universeKey,comparison};
   await p.persist('launch-comparison',artifact);await store.flush();await store.saveState('upstox:launch-comparison',artifact);
   publicState={...publicState,state:'review-required',phase:'complete',comparison,finishedAt:clock().toISOString(),progress:null};await save();await store.flush();
  }catch(error){
   publicState={...publicState,state:'failed',phase:publicState.phase,code:errorCode(error),finishedAt:clock().toISOString()};
   try{const p=provider||require('../marketData/upstox').getProvider();const partial=await p.read('universe-preparation');if(partial?.manifest?.coverage){publicState.coverage=partial.manifest.coverage;publicState.coverageAsOf=partial.manifest.asOf;}}catch(_){}
   await save().catch(()=>{});
  }finally{await lease?.stop();job=null;controller=null;}
 })();
 return {started:true,state:publicState};
}
async function stop(){controller?.abort();if(job)await job;}
async function importReport(buffer,date,attested){
 if(job)throw Error('Wait for the current preparation to finish before importing a report');
 if(process.env.INGEST_MODE!=='true'||!db.status().connected)throw Error('Report import requires the database-backed ingest API');
 try{const provider=require('../marketData/upstox').getProvider();const result=await require('../marketData/universe').importReport(provider,buffer,date,{attested});await db.flush();await db.saveState('upstox:nse-mcap:'+date,await provider.read('nse-mcap:'+date));return result;}catch(error){throw Error(errorCode(error));}
}
module.exports={start,status,stop,errorCode,importReport};
