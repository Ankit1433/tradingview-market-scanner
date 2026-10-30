const db=require('./supabaseStore');
const KEY='upstox-paper-scanning-policy';
async function read({store=db}={}){
 if(!store.status().connected)return {enabled:false};
 return (await store.loadState(KEY))?.payload||{enabled:false};
}
async function save(enabled,admin,{store=db,provider=require('../marketData/upstox').getProvider(),clock=()=>new Date()}={}){
 if(typeof enabled!=='boolean')throw Error('Choose whether to skip comparison');
 if(!store.status().connected)throw Error('Paper scanning preference requires the database');
 let universeKey=null;
 if(enabled){const universe=require('../marketData/universe');const manifest=await universe.loadManifest(provider);universe.validateManifest(manifest,provider.clock());universeKey=manifest.universeKey;if(manifest.version!==2||!universeKey)throw Error('Prepare sourced universe metadata before enabling this option');}
 const policy={enabled,universeKey,changedBy:admin,changedAt:clock().toISOString(),label:'Unverified paper scanning; comparison not approved'};
 await store.saveState(KEY,policy);return policy;
}
async function allows(manifest,options){const policy=await read(options);return policy.enabled===true&&manifest.version===2&&policy.universeKey===manifest.universeKey;}
module.exports={read,save,allows};
