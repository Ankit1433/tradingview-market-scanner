process.env.PRIVATE_MODE='false';process.env.RATE_LIMIT_PER_MIN='10000';
const assert=require('node:assert/strict');
const history=require('./src/services/tvHistory');
let calls=0,mode='rate';
history.getHist=()=>{calls++;if(mode==='sync')throw Error('Bearer private-fixture');if(mode==='rate')return new Promise((resolve,reject)=>setTimeout(()=>reject(Error('UPSTOX_RETRY_WAIT_EXCEEDED')),20));if(mode==='offline')return Promise.reject(Error('private-fixture'));return Promise.resolve([{time:1791000000,open:100,high:102,low:99,close:101,volume:10}]);};
(async()=>{
 const server=require('./src/server').createServer().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const responses=await Promise.all([fetch(base+'/api/public/candles/TEST'),fetch(base+'/api/public/candles/TEST')]);
  assert.equal(calls,1);for(const response of responses){assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'60');assert.equal((await response.json()).code,'UPSTOX_RETRY_WAIT_EXCEEDED');}
  for(const failure of ['sync','offline']){mode=failure;const response=await fetch(base+'/api/public/candles/TEST');assert.equal(response.status,503);assert(!(await response.text()).includes('private-fixture'));}
  mode='healthy';const response=await fetch(base+'/api/public/candles/TEST');assert.equal(response.status,200);assert.equal((await response.json()).count,1);assert.equal((await fetch(base+'/api/public/candles/TEST')).status,200);assert.equal(calls,4);
  assert.equal((await fetch(base+'/healthz')).status,200);
  console.log('Candle failures passed: shared rate-limit rejection returns 503, synchronous/asynchronous failures sanitized, pending slots released, healthy retry/cache and server survival.');
 }finally{await new Promise(resolve=>server.close(resolve));await history.closeClient();}
})().catch(error=>{console.error(error);process.exitCode=1;});
