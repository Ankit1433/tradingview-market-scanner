const {matches,dedupe,format,quiet}=require('../services/alertPolicy');
const {validate}=require('../config/alertPreferences');
const {nowIST}=require('../config/timeUtils');
const {getMarketStatus}=require('../services/marketStatus');
function createAlerts({accounts,db,deliver,clock=()=>new Date()}){
 async function discover(){const now=clock();const users=await accounts.alertUsers();const signals=await accounts.signalsSince(new Date(now.getTime()-15*60000).toISOString());for(const signal of signals)for(const user of users){if(!matches(user,signal,now))continue;const p=validate(user.alert_preferences||{});await accounts.enqueueAlert({user_id:user.id,key:'signal:'+dedupe(signal),kind:'signal',day:nowIST(now).dateKey,payload:{signal},expires:new Date(Date.parse(signal.ts)+15*60000).toISOString(),limit:p.maxAlertsPerDay});}}
 async function drain(){const now=clock();const rows=await accounts.dueAlerts(now);const groups=new Map();for(const row of rows){if(Date.parse(row.expires_at)<=now.getTime()){await accounts.updateAlert(row.id,{skipped_at:now.toISOString()});continue;}if(!groups.has(row.user_id))groups.set(row.user_id,[]);groups.get(row.user_id).push(row);}
  for(const [id,queue]of groups){const user=await accounts.user(id);if(!user?.telegram_chat_id)continue;let p;try{p=validate(user.alert_preferences||{});}catch(_){continue;}
   const allowed=[];for(const row of queue){if(row.kind==='admin'){const incident=(await db.loadState('scanner-alert-incident'))?.payload;if(!getMarketStatus(now).isOpen||!incident?.active||incident.key!==row.key){await accounts.updateAlert(row.id,{skipped_at:now.toISOString()});continue;}}if(row.kind==='signal'&&process.env.SIGNAL_ALERTS_ENABLED==='false')continue;if(row.kind==='signal'&&!matches(user,row.payload.signal,now)){await accounts.updateAlert(row.id,{skipped_at:now.toISOString()});continue;}allowed.push(row);}
   if(!allowed.length)continue;
   // Digest only signal rows; never bundle a private control/admin reply with signal content.
   const first=allowed[0];let batch=first.kind==='signal'&&p.digest?allowed.filter(r=>r.kind==='signal').slice(0,8):[first];
   while(batch.length>1 && batch.map(r=>format(r.payload.signal)).join('\n\n').length>3700)batch.pop();
   const text=batch.length>1?'PAPER SIGNAL DIGEST · '+batch.length+' setups\n\n'+batch.map(r=>format(r.payload.signal)).join('\n\n'):first.kind==='signal'?format(first.payload.signal):String(first.payload.message);
   const result=await deliver(user,text.slice(0,4000));for(const row of batch){if(result.sent)await accounts.updateAlert(row.id,{delivered_at:now.toISOString()});else if(result.retryAt)await accounts.updateAlert(row.id,{available_at:result.retryAt,attempts:(row.attempts||0)+1});}
  }
 }
 async function command(message,updateId){if(message?.chat?.type!=='private')return false;const match=/^\/(pause|resume|mute)(?:@[A-Za-z0-9_]+)?(?:\s+(\d+))?$/i.exec((message.text||'').trim());if(!match)return false;const user=await accounts.userByChat(String(message.chat.id));if(!user)return false;const now=clock(),cmd=match[1].toLowerCase();let text;
  if(cmd==='pause'){await accounts.controls(user.id,{alerts_paused:true});text='Signal alerts paused. Use /resume to resume.';}
  else if(cmd==='resume'){await accounts.controls(user.id,{alerts_paused:false,alerts_muted_until:null});text='Signal alerts resumed. Saved preferences still apply.';}
  else{const minutes=Number(match[2]||60);if(!Number.isInteger(minutes)||minutes<1||minutes>10080)text='Use /mute MINUTES, from 1 to 10080. Default: 60.';else{await accounts.controls(user.id,{alerts_muted_until:new Date(now.getTime()+minutes*60000).toISOString()});text=`Signal alerts muted for ${minutes} minutes.`;}}
  await accounts.enqueueAlert({user_id:user.id,key:'command:'+updateId,kind:'control',payload:{message:'PAPER ALERT SETTINGS\n'+text+'\nPersonal paper reminders are unchanged.'},expires:new Date(now.getTime()+86400000).toISOString()});return true;
 }
 async function monitor(){if(process.env.INGEST_MODE!=='true')return;const now=clock();const status=getMarketStatus(now);if(!status.isOpen)return;
  const {ingestState}=require('../routes/ingest');const times=[ingestState.lastHeartbeatAt,ingestState.lastPushAt].map(Date.parse).filter(Number.isFinite);const contact=times.length?new Date(Math.max(...times)).toISOString():null;
  const configured=Number(process.env.KEEPALIVE_INTERVAL_MS||480000);const staleMs=Math.max(10*60000,2*configured+30000);const stale=!contact||now.getTime()-Date.parse(contact)>staleMs;
  const stored=await db.loadState('scanner-alert-incident');const incident=stored?.payload||{};
  if(!stale){if(incident.active)await db.saveState('scanner-alert-incident',{active:false});return;}
  const key=incident.active?incident.key:'outage:'+now.toISOString();if(!incident.active)await db.saveState('scanner-alert-incident',{active:true,key});
  for(const user of await accounts.alertUsers())if(user.role==='admin')await accounts.enqueueAlert({user_id:user.id,key,kind:'admin',payload:{message:'ANKQUANT · SCANNER HEARTBEAT STALE\nMarket hours are active, but scanner contact is missing or stale. Check the scanner before relying on paper alerts.'},expires:new Date(now.getTime()+8*3600000).toISOString()});
 }
 return{discover,drain,command,monitor};
}
module.exports={createAlerts};
