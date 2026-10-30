// Real app processes + real Supabase REST adapter, with a local database stand-in.
// This verifies restart behavior, not production SQL, RLS or Supabase availability.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');

if(process.argv.includes('--app-child')){
 const server=require('./src/server').createServer().listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
 process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}else main().catch(error=>{console.error(error);process.exitCode=1;});

async function main(){
 const {passwordHash}=require('./src/middleware/accounts');
 const password='Restart-fixture-password-123';
 const users=[{id:crypto.randomUUID(),email:'owner@example.test',password_hash:await passwordHash(password),role:'friend',settings:{capital:10000,riskPct:1},alert_preferences:{}},{id:crypto.randomUUID(),email:'other@example.test',password_hash:await passwordHash(password),role:'friend',settings:{capital:20000,riskPct:1},alert_preferences:{}}];
 const tables={app_users:users,app_sessions:[],personal_trades:[],signal_events:[{event_key:'a'.repeat(64),symbol:'TEST',mode:'swing'}]};
 let unavailable=false,child,base;const pids=[];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ankquant-account-restart-'));
 const database=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(unavailable){res.statusCode=503;res.end('{}');return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):null,url=new URL(req.url,'http://fixture'),table=url.pathname.replace('/rest/v1/','');
  const matches=row=>[...url.searchParams].every(([key,value])=>['limit','order','select'].includes(key)||value.startsWith('eq.')&&String(row[key])===value.slice(3)||value.startsWith('gt.')&&row[key]>value.slice(3)||value==='is.null'&&row[key]==null);
  let result;
  if(table==='rpc/app_take_trade'){
   const trade={...body.p_trade,id:crypto.randomUUID(),opened_at:new Date().toISOString(),closed_at:null};tables.personal_trades.push(trade);result=[trade];
  }else if(!tables[table]){res.statusCode=404;result={};}
  else if(req.method==='GET')result=tables[table].filter(matches);
  else if(req.method==='POST'){tables[table].push(body);result=[body];}
  else if(req.method==='PATCH'){result=tables[table].filter(matches);result.forEach(row=>Object.assign(row,body));}
  else if(req.method==='DELETE'){result=tables[table].filter(matches);tables[table]=tables[table].filter(row=>!matches(row));}
  else {res.statusCode=405;result={};}
  res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>database.listen(0,'127.0.0.1',resolve));
 async function start(){
  child=spawn(process.execPath,[__filename,'--app-child'],{cwd:__dirname,env:{...process.env,NODE_ENV:'test',PRIVATE_MODE:'true',APP_ORIGIN:'',API_KEY:'',SUPABASE_URL:`http://127.0.0.1:${database.address().port}`,SUPABASE_SECRET_KEY:'sb_secret_local_restart_fixture',SUPABASE_SERVICE_ROLE_KEY:'',SWING_DATA_DIR:dir,RATE_LIMIT_PER_MIN:'10000'},stdio:['ignore','ignore','ignore','ipc']});
  pids.push(child.pid);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{const message=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw Error('Restart fixture exited before ready');})]);base=`http://127.0.0.1:${message.port}`;}finally{clearTimeout(timeout);}
 }
 async function stop(){if(child&&child.exitCode===null){const ended=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');try{await ended;}finally{clearTimeout(timer);}}}
 async function request(route,{cookie,body,status=200}={}){const response=await fetch(base+'/api/account'+route,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,status,route);return {data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 try{
  await start();
  const owner=(await request('/login',{body:{email:users[0].email,password}})).cookie;
  const other=(await request('/login',{body:{email:users[1].email,password}})).cookie;
  const settings={capital:12345,riskPct:1.5};const preferences={maxAlertsPerDay:7,watchlistOnly:true,watchlist:['TEST']};
  await request('/settings',{cookie:owner,body:settings});
  const saved=(await request('/preferences',{cookie:owner,body:preferences})).data.preferences;
  assert.equal(saved.maxAlertsPerDay,7);
  const trade=(await request('/journal',{cookie:owner,body:{eventKey:'a'.repeat(64),entry:100,stop:95,quantity:10},status:201})).data.trade;
  await stop();fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir);await start();
  assert.deepEqual((await request('/me',{cookie:owner})).data.settings,settings);
  assert.deepEqual((await request('/preferences',{cookie:owner})).data.preferences,saved);
  let journal=(await request('/journal',{cookie:owner})).data;assert.equal(journal.trades.length,1);assert.deepEqual(journal.trades[0],trade);assert.equal(journal.stats.open,1);
  assert.equal((await request('/journal',{cookie:other})).data.trades.length,0);
  assert.deepEqual((await request('/me',{cookie:other})).data.settings,{capital:20000,riskPct:1});
  await request('/journal/'+trade.id+'/close',{cookie:other,body:{exit:110},status:404});
  await request('/journal/'+trade.id+'/close',{cookie:owner,body:{exit:110}});
  await stop();await start();
  journal=(await request('/journal',{cookie:owner})).data;assert.equal(journal.stats.closed,1);assert.equal(journal.stats.totalR,2);assert.equal(journal.trades[0].exit,110);
  unavailable=true;await request('/me',{cookie:owner,status:503});unavailable=false;
  assert.deepEqual((await request('/me',{cookie:owner})).data.settings,settings);
  assert.equal(new Set(pids).size,3);
  console.log('Account restart passed: 3 real app processes; real Supabase REST adapter; sessions, preferences, sizing, open/closed paper trades and R results survive restart without local files; owner isolation and database-outage failure verified. Local HTTP database stand-in only; production SQL/RLS and Render persistence unverified.');
 }finally{unavailable=false;await stop();await new Promise(resolve=>database.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
