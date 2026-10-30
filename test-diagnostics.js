const assert=require('node:assert/strict');
const {details}=require('./src/operations/failureDetails');
const {check}=require('./scripts/check-upstox');
const {runCheck}=require('./src/services/upstoxStartupCheck');
(async()=>{
 const secret='fixture-secret-not-for-output';
 assert.deepEqual(details({response:{status:409},message:secret},'telegram_poll'),{stage:'telegram_poll',code:'OPERATION_FAILED',httpStatus:409});
 assert.deepEqual(details(Error('Supabase alert_queue request failed (HTTP 404)'),'alert_delivery'),{stage:'alert_delivery',code:'DATABASE_REQUEST_FAILED',resource:'alert_queue',httpStatus:404});
 assert(!JSON.stringify(details({message:secret,code:secret,response:{status:secret}},secret)).includes(secret));
 const env={UPSTOX_ACCESS_TOKEN:secret,UPSTOX_CHECK_ON_START:'true'};
 const failure=await check({env,provider:{instrument:async()=>({instrument_key:'fixture'}),quotes:async()=>{throw Error('UPSTOX_HTTP_400');}}});
 assert.deepEqual(failure,{authenticated:false,stage:'quote_RELIANCE',code:'UPSTOX_HTTP_400'});
 const unknown=await check({env,provider:{instrument:async()=>{throw Error(secret);}}});assert(!JSON.stringify(unknown).includes(secret));
 const logs=[];assert.equal(await runCheck({env,execute:(f,a,o,cb)=>cb(Error('exit'),'','[calendar] warning\n'+JSON.stringify(failure)+'\n'),log:x=>logs.push(x)}),'failed');assert(logs[0].includes('quote_RELIANCE'));assert(logs[0].includes('UPSTOX_HTTP_400'));
 assert.equal(await runCheck({env,execute:(f,a,o,cb)=>cb(Error('exit'),'','[calendar] warning\nUPSTOX_DAILY_CANDLE_GAP\n'),log:x=>logs.push(x)}),'failed');assert(logs[1].includes('UPSTOX_DAILY_CANDLE_GAP'));
 console.log('Diagnostic tests passed: stage attribution, HTTP codes, database resource/status, warning-prefixed stderr, and secret suppression.');
})().catch(e=>{console.error(e);process.exitCode=1;});
