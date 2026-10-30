const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,setupEnv}=require('./tests/support/appFixture');
const dir=setupEnv('ankquant-upstox-admin-');
const preparation=require('./src/services/upstoxPreparation');
const policy=require('./src/services/paperScanningPolicy'),originalPolicy={...policy};let paperPolicy={enabled:false};policy.read=async()=>paperPolicy;policy.save=async(enabled,admin)=>paperPolicy={enabled,changedBy:admin};
const original={...preparation};let started=0,imported=0;
preparation.status=async()=>({state:'review-required',phase:'complete',comparison:{approved:false,excluded:[{symbol:'TEST',reason:'split'}]}});
preparation.start=()=>{started++;return{started:true,state:{state:'running'}};};
preparation.importReport=async(buffer,date,attested)=>{assert(Buffer.isBuffer(buffer));assert.equal(date,'2026-10-29');assert.equal(attested,true);imported++;return{rows:1};};
(async()=>{let app;try{
 app=await fixture();app.users.get('alice').role='admin';
 async function login(email){const response=await fetch(app.base+'/api/account/login',{method:'POST',headers:{origin:app.base,'content-type':'application/json'},body:JSON.stringify({email,password:'Fixture-password-123'})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
 const admin=await login('alice@example.test'),friend=await login('bob@example.test');
 const workers=app.base+'/api/account/admin/workers';assert.equal((await fetch(workers)).status,401);assert.equal((await fetch(workers,{headers:{cookie:friend}})).status,403);const workerResponse=await fetch(workers,{headers:{cookie:admin}});assert.equal(workerResponse.status,200);assert.deepEqual(Object.keys((await workerResponse.json()).workers),['intraday','swing','outcomes']);
 const paperUrl=app.base+'/api/account/admin/upstox/paper-mode';assert.equal((await fetch(paperUrl)).status,401);assert.equal((await fetch(paperUrl,{headers:{cookie:friend}})).status,403);
 async function changePaper(cookie,origin,body){return fetch(paperUrl,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});}
 assert.equal((await changePaper(friend,app.base,{enabled:true})).status,403);assert.equal((await changePaper(admin,'https://other.example',{enabled:true})).status,403);assert.equal((await changePaper(admin,app.base,{enabled:'true'})).status,400);assert.equal((await changePaper(admin,app.base,{enabled:true})).status,200);assert((await (await fetch(paperUrl,{headers:{cookie:admin}})).json()).enabled);assert.equal((await changePaper(admin,app.base,{enabled:false})).status,200);assert.equal(paperPolicy.enabled,false);
 const url=app.base+'/api/account/admin/upstox';
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{cookie:friend}})).status,403);assert.equal((await fetch(url,{headers:{cookie:admin}})).status,200);
 assert.equal((await fetch(url+'/prepare',{method:'POST',headers:{cookie:admin,origin:'https://other.example','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url+'/prepare',{method:'POST',headers:{cookie:friend,origin:app.base,'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(url+'/prepare',{method:'POST',headers:{cookie:admin,origin:app.base,'content-type':'application/json'},body:'{}'})).status,202);assert.equal(started,1);
 const headers={cookie:admin,origin:app.base,'content-type':'application/zip','x-report-date':'2026-10-29','x-nse-source-attested':'true'};
 assert.equal((await fetch(url+'/report',{method:'POST',headers,body:Buffer.from('fixture archive bytes')})).status,200);assert.equal(imported,1);
 assert.equal((await fetch(url+'/report',{method:'POST',headers:{...headers,cookie:friend},body:Buffer.from('fixture')})).status,403);
 assert.equal((await fetch(url+'/report',{method:'POST',headers:{...headers,'x-report-date':'bad'},body:Buffer.from('fixture')})).status,400);
 assert.equal(imported,1);
 console.log('Upstox admin API tests passed: anonymous/friend denial, admin access, same-origin writes, background acceptance and binary import validation.');
 }finally{Object.assign(preparation,original);Object.assign(policy,originalPolicy);await app?.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
