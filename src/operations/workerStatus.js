// Process-local activity evidence; a successful scheduler tick is not proof of
// signal correctness or a completed provider scan. No prices or user data.
const workers=new Map();
function row(name){if(!workers.has(name))workers.set(name,{running:false,active:false,ticks:0,failures:0,lastStartedAt:null,lastFinishedAt:null,lastFailedAt:null,nextRunAt:null,activity:{}});return workers.get(name);}
function start(name){row(name).running=true;}
function stop(name){const value=row(name);value.running=false;value.nextRunAt=null;}
function activity(name,kind,count=1,now=new Date()){row(name).activity[kind]={at:now.toISOString(),count};}
function failure(name,now=new Date()){const value=row(name);value.failures++;value.lastFailedAt=now.toISOString();}
async function run(name,fn,clock=()=>new Date()){
 const value=row(name);value.active=true;value.lastStartedAt=clock().toISOString();value.nextRunAt=null;
 try{const result=await fn();value.ticks++;value.lastFinishedAt=clock().toISOString();return result;}
 catch(error){failure(name,clock());throw error;}
 finally{value.active=false;}
}
function scheduled(name,ms,now=new Date()){if(row(name).running)row(name).nextRunAt=new Date(now.getTime()+ms).toISOString();}
function snapshot(){return {scope:'Current process only; ticks include waiting for market/session schedules. Activity is not proof of live provider parity.',workers:Object.fromEntries(['intraday','swing','outcomes'].map(name=>[name,structuredClone(row(name))]))};}
module.exports={start,stop,run,scheduled,activity,failure,snapshot};
