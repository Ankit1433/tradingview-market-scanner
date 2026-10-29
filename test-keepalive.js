process.env.PRIVATE_MODE='false';process.env.SWING_DATA_DIR='/tmp/ankquant-keepalive-restart';
const assert=require('node:assert/strict'),fs=require('fs');
const {inWindow,parseWindow,createHeartbeat,intervalMs}=require('./src/config/keepalive');
const at=(date,time)=>new Date(`${date}T${time}+05:30`);
async function main(){
 for(const [date,time,expected] of [['2026-10-28','08:54:59',false],['2026-10-28','08:55:00',true],['2026-10-28','12:00:00',true],['2026-10-28','15:45:00',true],['2026-10-28','15:45:01',false],['2026-10-28','15:46:00',false],['2026-10-24','12:00:00',false],['2026-10-25','12:00:00',false],['2026-10-02','12:00:00',false]])assert.equal(inWindow(at(date,time)),expected,`${date} ${time}`);
 assert(inWindow(at('2026-10-28','10:00:00'),parseWindow('10:00-11:00')));assert(!inWindow(at('2026-10-28','09:00:00'),parseWindow('10:00-11:00')));assert.throws(()=>parseWindow('15:45-08:55'));assert.throws(()=>parseWindow('25:00-26:00'));assert.equal(intervalMs,480000);
 let now=at('2026-10-28','08:54:00'),sent=0;const beat=createHeartbeat({clock:()=>now,send:async()=>sent++});assert.equal(await beat(),false);now=at('2026-10-28','08:55:00');assert(await beat());now=at('2026-10-28','09:02:59');assert.equal(await beat(),false);now=at('2026-10-28','09:03:00');assert(await beat());now=at('2026-10-28','16:00:00');assert.equal(await beat(),false);assert.equal(sent,2);
 // Real journal -> real database adapter -> local HTTP stand-in for Supabase REST.
 const http=require('http');const rows=[];
 const server=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{res.setHeader('content-type','application/json');if(req.method==='POST'){for(const row of JSON.parse(raw))if(!rows.some(r=>r.event_key===row.event_key))rows.push(row);res.end('[]');}else if(req.method==='HEAD'){res.setHeader('content-range',`0-0/${rows.length}`);res.end();}else res.end(JSON.stringify(req.url.startsWith('/rest/v1/signal_events')?rows:[]));});}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 process.env.SUPABASE_URL=`http://127.0.0.1:${server.address().port}`;process.env.SUPABASE_SECRET_KEY='fake-test-secret';
 try{fs.rmSync(process.env.SWING_DATA_DIR,{recursive:true,force:true});const db=require('./src/services/supabaseStore');assert(await db.connect());let journal=require('./src/state/signalJournal');const original=journal.record({mode:'intraday',symbol:'TEST',signals:['PULLBACK'],price:100,levels:{entry:100,stop:95}});await db.flush();assert.equal(rows.length,1);
 fs.rmSync(process.env.SWING_DATA_DIR,{recursive:true,force:true});delete require.cache[require.resolve('./src/state/signalJournal')];journal=require('./src/state/signalJournal');journal.load();assert.equal(journal.query().length,0);assert(await journal.hydrateFromSupabase());const restored=journal.query()[0];assert.equal(restored.eventKey,original.eventKey);assert.equal(restored.ts,original.ts);assert.deepEqual(restored.levels,original.levels);
 }finally{await new Promise(r=>server.close(r));}
 console.log('Keepalive passed: IST window/boundaries, overrides, interval gate, weekends/holiday, and Supabase-adapter journal restart recovery (local HTTP fake).');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
