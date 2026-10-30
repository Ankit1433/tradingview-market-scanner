const crypto=require('crypto');
const {validate}=require('../config/alertPreferences');
const {nowIST,toMinutes}=require('../config/timeUtils');
function quiet(p,now){if(!p.quietEnabled)return false;const minutes=text=>{const [h,m]=text.split(':').map(Number);return h*60+m;};const start=minutes(p.quietStart),end=minutes(p.quietEnd),current=toMinutes(nowIST(now).time);return start===end|| (start<end?current>=start&&current<end:current>=start||current<end);}
function matches(user,signal,now=new Date()){
 let p;try{p=validate(user.alert_preferences||{});}catch(_){return false;}
 if(!user.telegram_chat_id||user.alerts_paused||Date.parse(user.alerts_muted_until)>now.getTime()||quiet(p,now)||p.maxAlertsPerDay===0)return false;
 const ts=Date.parse(signal.ts);if(!Number.isFinite(ts)||ts>now.getTime()||now.getTime()-ts>15*60000)return false;
 if(!p.modes.includes(signal.mode)||!Number.isFinite(signal.price)||signal.price<p.minPrice||signal.price>p.maxPrice)return false;
 if(!Array.isArray(signal.signals)||new Set(signal.signals).size<p.minConfluence)return false;
 if(p.signalTypes.length&&!signal.signals.some(type=>p.signalTypes.includes(type)))return false;
 if(p.sectors.length&&!p.sectors.includes(signal.context?.sector))return false;
 if(p.watchlistOnly&&!p.watchlist.includes(signal.symbol))return false;
 return true;
}
function dedupe(signal){return crypto.createHash('sha256').update(JSON.stringify([nowIST(new Date(signal.ts)).dateKey,signal.mode,signal.symbol,[...new Set(signal.signals)].sort()])).digest('hex');}
function format(signal){const levels=signal.levels||{};const lines=[`PAPER SIGNAL · ${signal.symbol}`,`${signal.mode} · ${signal.signals.join(' + ')}`,`Observed ₹${Number(signal.price).toFixed(2)}`];if(signal.context?.screeningVerification==='unverified-paper')lines.push('UNVERIFIED PAPER · Screener comparison skipped');for(const k of ['entry','stop','target'])if(Number.isFinite(levels[k]))lines.push(`${k}: ₹${levels[k].toFixed(2)}`);lines.push('Informational only. No order placed.');return lines.join('\n');}
module.exports={quiet,matches,dedupe,format};
