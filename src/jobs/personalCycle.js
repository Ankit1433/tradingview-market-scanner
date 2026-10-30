// An unavailable bot poll must not prevent attempts to deliver already queued
// private reminders or signal alerts. Each step retains its existing retry rules.
async function runSteps(steps,onFailure=()=>{},canRun=()=>true) {
  let failed=false;
  for(const [stage,run]of steps){
    if(!canRun())break;
    try{await run();}catch(error){failed=true;onFailure(error,stage);}
  }
  return !failed;
}
module.exports={runSteps};
