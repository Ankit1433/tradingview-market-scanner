const assert=require('node:assert/strict');
const {runCheck}=require('./src/services/upstoxStartupCheck');
(async()=>{
 const env={UPSTOX_CHECK_ON_START:'true',UPSTOX_ACCESS_TOKEN:'fixture-private-token'},logs=[];
 let calls=0;
 assert.equal(await runCheck({env:{},execute:()=>{throw Error();}}),'disabled');
 assert.equal(await runCheck({env:{UPSTOX_CHECK_ON_START:'true'},log:x=>logs.push(x)}),'failed');
 const samples=['RELIANCE','NIFTY'].map(symbol=>({symbol,price:100,dailyBars:250,fiveMinuteBars:100,lastDaily:'2026-10-29T03:45:00Z',lastFiveMinute:'2026-10-30T05:00:00Z',token:env.UPSTOX_ACCESS_TOKEN}));
 const execute=(file,args,options,callback)=>{calls++;assert.equal(file,process.execPath);assert(args[0].endsWith('/scripts/check-upstox.js'));assert(options.timeout>0&&options.timeout<=180000);assert.equal(options.env,env);callback(null,JSON.stringify({authenticated:true,samples}),'');};
 assert.equal(await runCheck({env,execute,log:x=>logs.push(x)}),'passed');assert.equal(calls,1);
 for(const stderr of ['UPSTOX_AUTH_REJECTED','Bearer '+env.UPSTOX_ACCESS_TOKEN])assert.equal(await runCheck({env,execute:(f,a,o,cb)=>cb(Error('secret'),'',stderr),log:x=>logs.push(x)}),'failed');
 for(const stdout of ['raw '+env.UPSTOX_ACCESS_TOKEN,JSON.stringify({authenticated:true,samples:[samples[0],samples[0]]})])assert.equal(await runCheck({env,execute:(f,a,o,cb)=>cb(null,stdout,''),log:x=>logs.push(x)}),'failed');
 assert(!logs.join(' ').includes(env.UPSTOX_ACCESS_TOKEN));assert(logs.join(' ').includes('UPSTOX_AUTH_REJECTED'));
 console.log('Upstox startup check tests passed: opt-in, bounded read-only CLI, structured output, auth errors, invalid output and secret redaction.');
})().catch(e=>{console.error(e);process.exitCode=1;});
