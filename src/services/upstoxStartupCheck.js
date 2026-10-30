const {execFile}=require('node:child_process');
const path=require('node:path');

function runCheck({env=process.env,execute=execFile,log=console.log}={}) {
  if(env.UPSTOX_CHECK_ON_START!=='true')return Promise.resolve('disabled');
  if(!env.UPSTOX_ACCESS_TOKEN){log('[upstox-check] UPSTOX_TOKEN_MISSING');return Promise.resolve('failed');}
  // Run the existing read-only diagnostic with a bounded lifetime. Never forward
  // raw child output: dependencies can write sensitive transport errors to stderr.
  return new Promise(resolve=>{
    execute(process.execPath,[path.join(__dirname,'../../scripts/check-upstox.js')],{env,timeout:180000,maxBuffer:65536},(error,stdout,stderr)=>{
      if(error){
        const line=String(stderr||'').trim().split(/\r?\n/).at(-1);
        let failure;
        try{const parsed=JSON.parse(line);failure=require('../operations/failureDetails').details({message:parsed.code},parsed.stage);}catch(_){failure=require('../operations/failureDetails').details({message:line},'configuration');}
        if(failure.code==='OPERATION_FAILED')failure.code='UPSTOX_CONNECTIVITY_CHECK_FAILED';
        log('[upstox-check] '+JSON.stringify({authenticated:false,...failure}));
        resolve('failed');return;
      }
      try{
        // The CLI can emit calendar notices; only accept its structured payload.
        const start=stdout.indexOf('{');
        const result=JSON.parse(stdout.slice(start));
        if(result.authenticated!==true||!Array.isArray(result.samples)||result.samples.length!==2)throw Error();
        const expected=new Set(['RELIANCE','NIFTY']);
        const samples=result.samples.map(row=>{
          if(!expected.delete(row.symbol)||!Number.isFinite(row.price)||row.price<=0||!Number.isInteger(row.dailyBars)||row.dailyBars<1||!Number.isInteger(row.fiveMinuteBars)||row.fiveMinuteBars<1||!Number.isFinite(Date.parse(row.lastDaily))||!Number.isFinite(Date.parse(row.lastFiveMinute)))throw Error();
          return {symbol:row.symbol,price:row.price,dailyBars:row.dailyBars,fiveMinuteBars:row.fiveMinuteBars,lastDaily:new Date(row.lastDaily).toISOString(),lastFiveMinute:new Date(row.lastFiveMinute).toISOString()};
        });
        log('[upstox-check] '+JSON.stringify({authenticated:true,samples,scope:'Quote/candle connectivity only; screening and streaming remain unverified'}));resolve('passed');
      }catch(_){log('[upstox-check] UPSTOX_CONNECTIVITY_CHECK_FAILED');resolve('failed');}
    });
  });
}
module.exports={runCheck};
