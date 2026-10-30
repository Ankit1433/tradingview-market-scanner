const db=require('./supabaseStore');
let lease=null,pending=null,onLost=null;
async function ensure(options={}){
 if(options.onLost)onLost=options.onLost;
 if(process.env.INGEST_MODE==='true')throw Error('INGEST_INSTANCE_CANNOT_RUN_SCANNERS');
 if(lease)return lease;if(pending)return pending;
 if(!db.status().connected){if(process.env.NODE_ENV==='production')throw Error('PRODUCTION_SCANNERS_REQUIRE_DATABASE_COORDINATION');return null;}
 pending=(async()=>{const obtained=await require('../marketData/ownership').acquire({waitMs:150000,onWaiting:()=>console.log('[scanner] waiting for previous worker lease to release'),onLost:()=>{lease=null;require('../jobs/scanLoop').stop();require('../jobs/swingLoop').stop();onLost?.();}});lease={async stop(){lease=null;await obtained.stop();}};return lease;})();
 try{return await pending;}finally{pending=null;}
}
async function guard(req,res,next){try{await ensure();next();}catch(_){res.status(503).json({error:'Scanner ownership unavailable or this is an ingest-only instance'});}}
module.exports={ensure,guard};
