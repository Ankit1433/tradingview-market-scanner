const {setupEnv,fixture}=require('./support/appFixture');
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const dir=setupEnv('ankquant-sse-load-');
const events=require('../src/services/eventStream');
const size=50,perMode=20,deadlineMs=15000;
function connect(base,cookie,mode){return new Promise((resolve,reject)=>{let buffer='';const received=new Map();const req=http.get(base+'/api/public/stream?mode='+mode,{agent:false,headers:{Cookie:cookie}},res=>{if(res.statusCode!==200){res.resume();reject(Error('SSE HTTP '+res.statusCode));return;}
 res.setEncoding('utf8');res.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=/^event: ([^\n]+)/.exec(frame)?.[1],raw=/\ndata: ([^\n]+)/.exec(frame)?.[1];if(type==='connected')resolve({req,res,mode,received});if(type==='signal'&&raw){const payload=JSON.parse(raw);if(payload.loadSequence!==undefined){assert.equal(payload.mode,mode);assert(!received.has(payload.loadSequence),'Duplicate SSE event');received.set(payload.loadSequence,{payload,at:performance.now()});}}}});
 res.on('error',reject);});req.on('error',reject);});}
async function until(fn){const end=Date.now()+deadlineMs;while(!fn()){if(Date.now()>end)throw Error('SSE load timeout');await new Promise(r=>setTimeout(r,10));}}
async function main(){const app=await fixture(),clients=[];const timeout=setTimeout(()=>{for(const c of clients)c.req.destroy();app.server.closeAllConnections();},30000);try{
 const auth=await fetch(app.base+'/api/account/login',{method:'POST',headers:{'content-type':'application/json',Origin:app.base},body:JSON.stringify({email:'alice@example.test',password:'Fixture-password-123'})});assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie').split(';')[0];
 clients.push(...await Promise.all(Array.from({length:size},(_,i)=>connect(app.base,cookie,i%2?'swing':'intraday'))));assert.equal(events.clientCount(),50);
 const rssBefore=process.memoryUsage().rss,sent=new Map();for(let sequence=0;sequence<perMode;sequence++)for(const mode of ['intraday','swing']){sent.set(mode+':'+sequence,performance.now());assert.equal(events.broadcast('signal',{...app.event,mode,loadSequence:sequence}),25);}
 await until(()=>clients.every(c=>c.received.size===perMode));const latencies=[];for(const c of clients)for(const [seq,row]of c.received)latencies.push(row.at-sent.get(c.mode+':'+seq));latencies.sort((a,b)=>a-b);const p95=latencies[Math.floor(latencies.length*.95)];assert(p95<5000,'Local SSE p95 must be below 5 seconds');
 for(const c of clients.splice(0,10))c.req.destroy();await until(()=>events.clientCount()===40);
 const replacement=await connect(app.base,cookie,'intraday');clients.push(replacement);assert.equal(events.broadcast('signal',{...app.event,mode:'intraday',loadSequence:99}),21);await until(()=>replacement.received.has(99));
 for(const c of clients)c.req.destroy();await until(()=>events.clientCount()===0);
 const report={clients:size,eventsBroadcast:perMode*2,deliveries:size*perMode,p95LatencyMs:Math.round(p95*100)/100,rssDeltaBytes:process.memoryUsage().rss-rssBefore,reconnect:true,cleanup:true,scope:'Local loopback fixture accounts; not Render/Supabase/network capacity qualification'};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync(path.join('test-results','sse-load.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{clearTimeout(timeout);for(const c of clients)c.req.destroy();await app.close();fs.rmSync(dir,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
