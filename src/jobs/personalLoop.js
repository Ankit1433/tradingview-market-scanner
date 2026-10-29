const axios=require('axios');
const store=require('../services/accountStore');
const {hash}=require('../middleware/accounts');
const {reminders}=require('../trading/personalJournal');
const {getHist,INTERVAL}=require('../services/tvHistory');
const {isBarComplete}=require('../services/dailyBars');
const {nowIST}=require('../config/timeUtils');
const db=require('../services/supabaseStore');
const {createDelivery}=require('../services/chatDelivery');
let alerts, sharedDelivery, botLease;
const {isTradingDay}=require('../services/tradingCalendar');
let offset=0,timer,running=false,active;
let deliveryAfter=0;
const bot=process.env.TELEGRAM_BOT_TOKEN;
async function telegram(method,data){if(!bot)return null;return (await axios.post(`https://api.telegram.org/bot${bot}/${method}`,data,{timeout:10000})).data;}
async function linkMessage(message,accounts=store){
 if(message?.chat?.type!=='private')return false;
 const match=/^\/start(?:@[A-Za-z0-9_]+)? ([a-f0-9]{64})$/.exec((message.text||'').trim());
 if(!match)return false;
 return accounts.consumeLink(hash(match[1]),String(message.chat.id));
}
async function poll(){if(!bot)return;const response=await telegram('getUpdates',{offset,timeout:0});for(const update of response?.result||[]){
 // A private chat is mandatory. Replayed updates cannot consume a used link.
 if(!await linkMessage(update.message)) await alerts?.command(update.message,update.update_id);
 offset=update.update_id+1;await db.saveState('telegram-update-offset',{offset});
}}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function deliver(accounts=store,send=telegram){if(Date.now()<deliveryAfter)return;for(const row of await accounts.pending()){
 const trades=await accounts.trades(row.user_id);if(!trades.some(t=>t.id===row.trade_id&&!t.closed_at)){await accounts.delivered(row.id);continue;}
 const owner=await accounts.user(row.user_id);if(!owner?.telegram_chat_id)continue;
 try{const result=sharedDelivery&&accounts===store?await sharedDelivery(owner,row.message):{sent:(await send('sendMessage',{chat_id:owner.telegram_chat_id,text:row.message}))?.ok};if(result.sent)await accounts.delivered(row.id);}
 catch(error){const seconds=Number(error.response?.data?.parameters?.retry_after);if(error.response?.status===429){deliveryAfter=Date.now()+Math.max(seconds||1,1)*1000;return;}console.warn('[personal] reminder delivery deferred');}
 await wait(1100);
}}
async function evaluateOpen({accounts=store,history=getHist,now=new Date()}={}){
 if(!isTradingDay(nowIST(now).dateKey))return;
 for(const trade of await accounts.openTrades()){
  try{const bars=await history(trade.symbol,'NSE',trade.mode==='swing'?INTERVAL.IN_DAILY:INTERVAL.IN_5_MINUTE,2);const eligible=(bars||[]).filter(b=>b.time*1000>Date.parse(trade.opened_at)&&(trade.mode==='swing'?isBarComplete(b,now):b.time*1000+300000<=now.getTime()));const last=eligible.at(-1);if(!last)continue;
   // Only current-session observations generate reminders; stale feed data must not trigger them.
   if(nowIST(new Date(last.time*1000)).dateKey!==nowIST(now).dateKey)continue;
   for(const item of reminders(trade,last.close,now))await accounts.reminder(item);
   await accounts.highest(trade.id,Math.max(Number(trade.highest),last.close));
  }catch(_){console.warn('[personal] paper reminder evaluation deferred');}
 }
}
async function start(){if(running)return;if(!db.status().connected)throw new Error('PERSONAL_ALERT_WORKER_REQUIRES_DATABASE');
 botLease=await require('../marketData/ownership').acquire({key:'ankquant-telegram-worker',onLost:()=>{running=false;clearTimeout(timer);console.error('[alerts] Telegram ownership lost; worker stopped');}});
 try{offset=(await db.loadState('telegram-update-offset'))?.payload?.offset||0;}catch(error){await botLease.stop();throw error;}
 running=true;sharedDelivery=createDelivery({accounts:store,send:telegram,canSend:()=>running});alerts=require('./alertLoop').createAlerts({accounts:store,db,deliver:sharedDelivery});
 let lastEvaluation=0;
 async function tick(){active=(async()=>{
  await poll();
  if(process.env.SIGNAL_ALERTS_ENABLED!=='false'){await alerts.discover();await alerts.monitor();}
  if(Date.now()-lastEvaluation>60000){await evaluateOpen();lastEvaluation=Date.now();}
  await deliver();
  await alerts.drain();
 })();try{await active;}catch(_){console.warn('[alerts] database/feed unavailable; retrying');}finally{active=null;if(running){timer=setTimeout(tick,5000);timer.unref?.();}}}tick();}
async function stop(){running=false;clearTimeout(timer);if(active)await active.catch(()=>{});await botLease?.stop();}

module.exports={start,stop,linkMessage,evaluateOpen,deliver};
