require('dotenv').config();
const fs=require('fs');
const db=require('../src/services/supabaseStore');
const store=require('../src/state/outcomeStore');
const {run}=require('../src/jobs/outcomeLoop');
const {closeClient}=require('../src/services/tvHistory');
(async()=>{const filename=process.argv.find(a=>a.startsWith('--fixture='))?.slice(10);let options={};
 if(filename){const fixture=JSON.parse(fs.readFileSync(filename,'utf8'));options={now:new Date(fixture.now),signals:fixture.signals,fetchHistory:async(symbol)=>fixture.candles[symbol]||[],push:async()=>true};}
 else{await db.connect();await store.hydrate();}
 console.log(JSON.stringify(await run(options),null,2));await db.flush();})().catch(()=>{console.error('Outcome evaluation failed; check data/configuration');process.exitCode=1;}).finally(closeClient);
