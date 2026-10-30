const assert=require('node:assert/strict');
const policy=require('./src/services/paperScanningPolicy');
const db=require('./src/services/supabaseStore');
const U=require('./src/marketData/universe');
(async()=>{
 const now=new Date('2026-10-30T10:00:00Z'),saved=new Map();const store={status:()=>({connected:true}),loadState:async key=>saved.has(key)?{payload:saved.get(key)}:null,saveState:async(key,value)=>saved.set(key,structuredClone(value))};
 const manifest={version:2,source:'fixture',asOf:now.toISOString(),adjustmentPolicy:'provider-native-audited',stocks:[{symbol:'TEST',marketCap:10000000,sector:'Tech',eligible:true}],report:{sourceDate:'2026-10-30',sha256:'a'.repeat(64)},universeKey:'b'.repeat(64),coverage:{expected:1,included:1,excluded:[],complete:true},scope:'NSE_EQ_EQ_COMPANY',corporateActionPolicy:'block-structural-actions'};
 const provider={clock:()=>now,health:{},read:async key=>key==='universe-v2'?{manifest}:null};
 const oldFile=process.env.UPSTOX_UNIVERSE_FILE;process.env.UPSTOX_UNIVERSE_FILE='/tmp/ankquant-missing-policy-universe-fixture.json';
 const original={status:db.status,loadState:db.loadState};
 try{
  assert.equal(await policy.allows(manifest,{store}),false);await assert.rejects(policy.save('true','admin',{store,provider}),/Choose/);
  await policy.save(true,'admin',{store,provider,clock:()=>now});assert(await policy.allows(manifest,{store}));assert.equal((await policy.read({store})).changedBy,'admin');
  delete require.cache[require.resolve('./src/services/paperScanningPolicy')];assert((await require('./src/services/paperScanningPolicy').read({store})).enabled);
  assert.equal(await policy.allows({...manifest,universeKey:'c'.repeat(64)},{store}),false);
  db.status=store.status;db.loadState=store.loadState;
  await U.assertPrepared(provider,manifest);assert.equal(provider.health.screeningVerification,'unverified-paper');
  await assert.rejects(U.assertPrepared(provider,{...manifest,asOf:'2020-01-01T00:00:00Z'}),/STALE/);
  await assert.rejects(U.assertPrepared(provider,{...manifest,coverage:{...manifest.coverage,expected:2}}),/COVERAGE_INCOMPLETE/);
  await policy.save(false,'admin',{store,provider});await assert.rejects(U.assertPrepared(provider,manifest),/COMPARISON_REQUIRED/);
  db.loadState=async()=>{throw Error('offline');};await assert.rejects(U.assertPrepared(provider,manifest),/offline/);
  const format=require('./src/services/alertPolicy').format;assert(format({symbol:'TEST',mode:'intraday',signals:['PULLBACK'],price:100,context:{screeningVerification:'unverified-paper'}}).includes('UNVERIFIED PAPER'));
  console.log('Paper scanning checks passed: default off, strict boolean, durable preference, universe scope, explicit skip and revocation, metadata/freshness retained, database failure closed and unverified alert label.');
 }finally{Object.assign(db,original);if(oldFile===undefined)delete process.env.UPSTOX_UNIVERSE_FILE;else process.env.UPSTOX_UNIVERSE_FILE=oldFile;}
})().catch(error=>{console.error(error);process.exitCode=1;});
