process.env.PRIVATE_MODE='false';process.env.TEST_MODE='false';
process.env.SWING_DATA_DIR=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'ankquant-workers-'));
const assert=require('node:assert/strict');
const status=require('./src/operations/workerStatus');
const at=()=>new Date('2026-10-30T10:30:00Z');
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Worker did not complete fixture cycle');}
(async()=>{
 const telegram=require('./src/services/telegram');telegram.safeSend=async()=>{};telegram.processTelegramCommands=async()=>{};
 const scanner=require('./src/services/tvScanner');let discoveries=0;scanner.getStocks=async()=>{discoveries++;return{};};scanner.getEarlyStocks=async()=>({});
 require('./src/services/nifty').getNiftyChange=async()=>0;
 const swingScanner=require('./src/services/swingScanner');let swingFetches=0;swingScanner.getSwingCandidates=async()=>{swingFetches++;return{};};require('./src/indicators/swingSignals').getIndexReturn=async()=>0;
 require('./src/services/pushClient').pushPositions=async()=>{};
 let outcomeSaved=0,outcomePushed=0;
 require('./src/state/signalJournal').iterateAll=()=>[{eventKey:'a'.repeat(64),mode:'intraday',symbol:'TEST',ts:'2026-10-30T04:00:00Z',levels:{entry:100,stop:95,target:110}}];
 const outcomeStore=require('./src/state/outcomeStore');outcomeStore.get=()=>null;outcomeStore.save=()=>{outcomeSaved++;};
 require('./src/services/tvHistory').getHist=async()=>[{time:Date.parse('2026-10-30T04:05:00Z')/1000,open:100,high:111,low:99,close:110,volume:1000}];
 require('./src/services/pushClient').pushOutcomes=async()=>{outcomePushed++;};
 const intraday=require('./src/jobs/scanLoop'),swing=require('./src/jobs/swingLoop'),outcomes=require('./src/jobs/outcomeLoop');
 try{
  // Market-hours clock drives a real intraday discovery cycle, without network.
  const during=()=>new Date('2026-10-30T06:00:00Z');
  await intraday.start({clock:during});await until(()=>status.snapshot().workers.intraday.ticks===1);
  assert(discoveries>=2);assert(status.snapshot().workers.intraday.activity.discoveryFetch);assert(status.snapshot().workers.intraday.nextRunAt);await intraday.start({clock:during});assert.equal(status.snapshot().workers.intraday.ticks,1);intraday.stop();
  swing.start({clock:at});await until(()=>status.snapshot().workers.swing.ticks===1);assert.equal(swingFetches,1);assert(status.snapshot().workers.swing.activity.scanPass);assert(status.snapshot().workers.swing.nextRunAt);swing.stop();
  // Starting again on the same IST date must not scan a second time.
  swing.start({clock:at});await until(()=>status.snapshot().workers.swing.ticks===2);assert.equal(swingFetches,1);swing.stop();
  outcomes.start({clock:at});await until(()=>status.snapshot().workers.outcomes.ticks===1);assert.equal(status.snapshot().workers.outcomes.activity.evaluated.count,1);assert.equal(outcomeSaved,1);assert.equal(outcomePushed,1);assert(status.snapshot().workers.outcomes.nextRunAt);await outcomes.stop();
  await assert.rejects(status.run('intraday',async()=>{throw Error('private fixture error');},at));
  const result=status.snapshot();assert.equal(result.workers.intraday.failures,1);assert(!JSON.stringify(result).includes('private fixture error'));
  for(const row of Object.values(result.workers)){assert.equal(row.running,false);assert.equal(row.active,false);assert.equal(row.nextRunAt,null);}
  const clone=status.snapshot();clone.workers.intraday.ticks=999;assert.notEqual(status.snapshot().workers.intraday.ticks,999);
  console.log('Worker verification passed: actual intraday scheduled discovery, post-close swing pass and daily dedupe, outcome scheduler tick, next-run evidence, duplicate-start guard, safe failure counters and shutdown. Fixture data only; production execution unverified.');
 }finally{intraday.stop();swing.stop();await outcomes.stop();await require('./src/services/tvHistory').closeClient();require('node:fs').rmSync(process.env.SWING_DATA_DIR,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
