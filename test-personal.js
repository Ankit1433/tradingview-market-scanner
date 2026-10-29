process.env.PRIVATE_MODE='true';process.env.API_KEY='personal-test-machine';process.env.APP_ORIGIN='http://localhost';process.env.RATE_LIMIT_PER_MIN='5000';process.env.TELEGRAM_BOT_USERNAME='TestPaperBot';
const assert=require('node:assert/strict'),crypto=require('crypto');
const {passwordHash,verify,hash}=require('./src/middleware/accounts');
const personal=require('./src/trading/personalJournal');
const {linkMessage,evaluateOpen,deliver}=require('./src/jobs/personalLoop');
const {createServer}=require('./src/server');
const {closeClient}=require('./src/services/tvHistory');
const users=new Map(),sessions=new Map(),invites=new Map(),links=new Map(),trades=[],notifications=[];
const signalKey='a'.repeat(64);let fail=false;
const store={
 async bootstrap(email,password_hash){if(users.size)throw Error('already initialized');users.set('admin',{id:'admin',email,password_hash,role:'admin',settings:{capital:100000,riskPct:1}});},
 async register(email,password_hash,code){const invite=invites.get(code);if(!invite||invite.used||Date.parse(invite.expires_at)<=Date.now()||[...users.values()].some(u=>u.email===email))throw Error('invalid');invite.used=true;const id=crypto.randomUUID();users.set(id,{id,email,password_hash,role:'friend',settings:{capital:100000,riskPct:1}});},
 async userByEmail(email){return [...users.values()].find(u=>u.email===email);},async user(id){return users.get(id);},async invite(row){invites.set(row.code_hash,row);},
 async session(key){if(fail)throw Error('offline');const s=sessions.get(key);return s&&Date.parse(s.expires_at)>Date.now()?s:null;},async addSession(row){sessions.set(row.token_hash,row);},async removeSession(key){sessions.delete(key);},
 async preferences(id,value){users.get(id).alert_preferences=value;},async settings(id,value){users.get(id).settings=value;},async link(id,key){links.set(key,{id,expires:Date.now()+600000});},async consumeLink(key,chat){const link=links.get(key);if(!link||link.expires<Date.now())return false;links.delete(key);users.get(link.id).telegram_chat_id=chat;return true;},async unlink(id){users.get(id).telegram_chat_id=null;},
 async signal(key){return key===signalKey?{symbol:'TEST',mode:'swing'}:null;},async trades(id){return trades.filter(t=>t.user_id===id);},async addTrade(row){if(trades.some(t=>t.user_id===row.user_id&&t.event_key===row.event_key))throw Error('duplicate');const t={...row,id:crypto.randomUUID(),opened_at:'2026-10-21T10:15:00Z',closed_at:null};trades.push(t);return[t];},async closeTrade(user,id,exit){const t=trades.find(t=>t.id===id&&t.user_id===user&&!t.closed_at);if(!t)return[];t.exit=exit;t.closed_at=new Date().toISOString();return[t];},
 async openTrades(){return trades.filter(t=>!t.closed_at);},async highest(id,price){const t=trades.find(t=>t.id===id);t.highest=Math.max(t.highest,price);},async reminder(row){if(!notifications.some(r=>r.trade_id===row.trade_id&&r.kind===row.kind))notifications.push({...row,id:crypto.randomUUID()});},async pending(){return notifications.filter(r=>!r.delivered_at);},async delivered(id){notifications.find(r=>r.id===id).delivered_at='done';},
};
let n=0;function check(name,fn){fn();n++;console.log('  ✓ '+name);}
async function main(){const password='Long-private-password-123';const hashed=await passwordHash(password);check('passwords use distinct salted hashes',()=>assert(!hashed.includes(password)));assert(await verify(password,hashed));assert(!await verify('wrong',hashed));assert.notEqual(await passwordHash(password),hashed);
 const previousNodeEnv=process.env.NODE_ENV;process.env.NODE_ENV='production';let options;require('./src/middleware/accounts').setCookie({cookie:(name,value,opts)=>{options=opts;}},'test');if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;
 check('production session cookie is secure and seven-day bounded',()=>{assert(options.secure);assert.equal(options.maxAge,7*86400000);});
 check('personal sizing respects risk and total capital',()=>{const p=personal.plan({entry:100,stop:95},{capital:10000,riskPct:1});assert.equal(p.quantity,20);assert.throws(()=>personal.plan({entry:100,stop:95,quantity:30},{capital:10000,riskPct:1}));assert.throws(()=>personal.plan({entry:100,stop:100},{capital:10000,riskPct:1}));});
 const server=createServer({accountStore:store}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,{body,cookie,key,origin=process.env.APP_ORIGIN}={}){const r=await fetch(base+path,{redirect:'manual',method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json','origin':origin}:{}),...(cookie?{cookie}:{}),...(key?{'x-api-key':key}:{})},body:body?JSON.stringify(body):undefined});let data;try{data=await r.json();}catch(_){data=null;}return{status:r.status,data,cookie:r.headers.get('set-cookie'),headers:r.headers};}
 try{
 check('unauthenticated scanner is private',()=>{});assert.equal((await request('/api/public/signals/recent')).status,401);assert.equal((await request('/app')).status,302);assert.equal((await request('/login')).status,200);
 assert.equal((await request('/api/account/bootstrap',{body:{email:'admin@example.com',password},key:process.env.API_KEY})).status,201);
 assert.equal((await request('/api/account/bootstrap',{body:{email:'extra@example.com',password},key:process.env.API_KEY})).status,503);
 const adminLogin=await request('/api/account/login',{body:{email:'admin@example.com',password}});assert.equal(adminLogin.status,200);const admin=adminLogin.cookie.split(';')[0];
 check('httpOnly strict cookie; token only hashed in storage',()=>{assert(adminLogin.cookie.includes('HttpOnly'));assert(adminLogin.cookie.includes('SameSite=Strict'));assert(sessions.has(hash(admin.split('=')[1])));assert(!sessions.has(admin.split('=')[1]));});
 const invitation=await request('/api/account/invites',{body:{},cookie:admin});assert.equal(invitation.status,201);assert(!JSON.stringify([...invites.keys()]).includes(invitation.data.code));
 const join={email:'friend@example.com',password,code:invitation.data.code};assert.equal((await request('/api/account/register',{body:join})).status,201);assert.equal((await request('/api/account/register',{body:{...join,email:'reuse@example.com'}})).status,400);
 const friend=(await request('/api/account/login',{body:{email:join.email,password}})).cookie.split(';')[0];
 check('friend cannot create invites or read shared account amounts',()=>{});assert.equal((await request('/api/account/invites',{body:{},cookie:friend})).status,403);assert.equal((await request('/api/scanner/positions',{cookie:friend})).status,403);
 assert.equal((await request('/api/account/settings',{body:{capital:100,riskPct:1},cookie:friend,origin:'https://attacker.example'})).status,403);
 check('machine key does not impersonate personal user',()=>{});assert.equal((await request('/api/account/journal',{key:process.env.API_KEY})).status,401);assert.equal((await request('/api/public/signals/recent',{key:process.env.API_KEY})).status,200);
 const session=sessions.get(hash(friend.split('=')[1]));const expiry=session.expires_at;session.expires_at='2000-01-01T00:00:00Z';assert.equal((await request('/api/account/me',{cookie:friend})).status,401);session.expires_at=expiry;
 check('expired sessions are rejected',()=>assert(session));
 const expired=crypto.randomBytes(32).toString('hex');links.set(hash(expired),{id:'admin',expires:0});assert.equal(await linkMessage({chat:{type:'private',id:50},text:'/start '+expired},store),false);
 check('expired Telegram links cannot bind a chat',()=>assert(!users.get('admin').telegram_chat_id));
 const me=(await request('/api/account/me',{cookie:friend})).data;assert(!('password_hash'in me));
 const pref=require('./src/config/alertPreferences').defaults;
 assert.equal((await request('/api/account/preferences',{cookie:friend,body:{...pref,maxAlertsPerDay:9,user_id:'admin'}})).status,200);
 const ownPrefs=await request('/api/account/preferences',{cookie:friend});assert.equal(ownPrefs.data.preferences.maxAlertsPerDay,9);assert.equal(ownPrefs.data.deliveryActive,true);
 assert.equal((await request('/api/account/preferences',{cookie:admin})).data.preferences.maxAlertsPerDay,20);
 assert.equal((await request('/api/account/preferences',{cookie:friend,body:{...pref,minPrice:500,maxPrice:100}})).status,400);
 check('alert preferences are validated and isolated from other users and risk settings',()=>{assert.equal(users.get(me.id).settings.capital,100000);assert.equal(users.get(me.id).alert_preferences.user_id,undefined);});
 const taken=await request('/api/account/journal',{cookie:friend,body:{eventKey:signalKey,entry:100,stop:95,user_id:'admin'}});assert.equal(taken.status,201);const trade=taken.data.trade;
 check('server session owns journal rows, ignoring supplied user ID',()=>assert.equal(trade.user_id,me.id));
 assert.equal((await request('/api/account/journal',{cookie:admin})).data.trades.length,0);
 assert.equal((await request('/api/account/journal/'+trade.id+'/close',{cookie:admin,body:{exit:120}})).status,404);
 assert.equal((await request('/api/account/journal',{cookie:friend,body:{eventKey:signalKey,entry:100,stop:95}})).status,409);
 const linked=await request('/api/account/telegram/link',{cookie:friend,body:{}});const code=new URL(linked.data.url).searchParams.get('start');
 check('group cannot claim personal Telegram link',()=>{});assert.equal(await linkMessage({chat:{type:'group',id:9},text:'/start '+code},store),false);assert.equal(await linkMessage({chat:{type:'private',id:10},text:'/start '+code},store),true);assert.equal(await linkMessage({chat:{type:'private',id:11},text:'/start '+code},store),false);
 const now=new Date('2026-10-22T12:00:00Z');await evaluateOpen({accounts:store,now,history:async()=>[{time:Date.parse('2026-10-22T09:15:00+05:30')/1000,close:90}]});await evaluateOpen({accounts:store,now,history:async()=>[{time:Date.parse('2026-10-22T09:15:00+05:30')/1000,close:90}]});
 check('personal reminders dedupe and do not close trades',()=>{assert.equal(notifications.length,1);assert.equal(trade.closed_at,null);});let recipients=[];await deliver(store,async(method,payload)=>{recipients.push(payload.chat_id);return{ok:true};});check('reminder goes only to verified owner chat',()=>assert.deepEqual(recipients,['10']));
 assert.equal((await request('/api/account/journal/'+trade.id+'/close',{cookie:friend,body:{exit:110}})).status,200);const stats=(await request('/api/account/journal',{cookie:friend})).data.stats;check('personal results use initial-risk R',()=>{assert.equal(stats.totalR,2);assert.equal(stats.closed,1);});
 await store.reminder({user_id:me.id,trade_id:trade.id,kind:'time_stop',message:'PAPER'});recipients=[];await deliver(store,async(method,payload)=>{recipients.push(payload.chat_id);return{ok:true};});
 check('closed trades suppress undelivered reminders',()=>assert.equal(recipients.length,0));
 let historyCalls=0;await evaluateOpen({accounts:store,now:new Date('2026-10-25T12:00:00Z'),history:async()=>{historyCalls++;return[];}});
 check('reminder scheduler skips non-trading days',()=>assert.equal(historyCalls,0));
 const kinds=personal.reminders({...trade,closed_at:null,highest:120,target:130,time_stop_sessions:1},110,now).map(r=>r.kind);check('trailing and session time reminders',()=>{assert(kinds.includes('trail'));assert(kinds.includes('time_stop'));});
 const storedTrade=trades.find(t=>t.id===trade.id);const closedAt=storedTrade.closed_at;storedTrade.closed_at=null;await store.reminder({user_id:me.id,trade_id:trade.id,kind:'retry_test',message:'PAPER'});
 let attempts=0;await deliver(store,async()=>{attempts++;const error=new Error('rate limit');error.response={status:429,data:{parameters:{retry_after:120}}};throw error;});
 await deliver(store,async()=>{attempts++;return{ok:true};});
 check('Telegram retry_after blocks immediate redelivery and keeps pending row',()=>{assert.equal(attempts,1);assert(notifications.some(r=>r.kind==='retry_test'&&!r.delivered_at));});storedTrade.closed_at=closedAt;
 fail=true;assert.equal((await request('/api/public/stats',{cookie:friend})).status,503);fail=false;
 await request('/api/account/logout',{cookie:friend,body:{}});assert.equal((await request('/api/account/me',{cookie:friend})).status,401);
 let limited;for(let i=0;i<12;i++)limited=await request('/api/account/login',{body:{email:'missing@example.com',password:'bad'}});check('login attempts are rate limited',()=>{assert.equal(limited.status,429);assert(limited.headers.get('retry-after'));});
 }finally{await new Promise(r=>server.close(r));}
 console.log(`Personal accounts/journal: ${n} checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(closeClient);
