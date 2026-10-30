const {nowIST}=require('../config/timeUtils');
const {dateKey}=require('./universe');
const {expectedLast}=require('./freshness');
const {sessionForDate}=require('../services/tradingCalendar');
const DAY=86400000;
function actionDate(value){if(typeof value!=='string')throw Error('UPSTOX_CORPORATE_ACTION_DATA_INVALID');if(/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value)return value;try{return dateKey(value.replace(/^(\d) /,'0$1 '));}catch(_){throw Error('UPSTOX_CORPORATE_ACTION_DATA_INVALID');}}
function classify(events,from,to){
 if(!Array.isArray(events))throw Error('UPSTOX_CORPORATE_ACTION_DATA_INVALID');
 const affected=[];let dividends=0;
 for(const event of events){
  if(typeof event?.name!=='string'||!event.name.trim())throw Error('UPSTOX_CORPORATE_ACTION_DATA_INVALID');
  const date=actionDate(event.expiry_date);if(date<from||date>to)continue;
  if(/^(?:(?:interim|final|special)\s+)?dividend$/i.test(event.name.trim())){dividends++;continue;}
  const type=/bonus/i.test(event.name)?'bonus':/split/i.test(event.name)?'split':/rights/i.test(event.name)?'rights':'other-structural-or-unknown';
  affected.push({date,type});
 }
 return {policy:'block-structural-actions',from,to,status:affected.length?'excluded':'clear',affected,dividends,priceBasis:'provider-native; cash-dividend returns are not total returns; no guessed split/bonus factors'};
}
function strategyStart(provider,now){
 const anchor=expectedLast('D',now);if(provider.corporateWindow?.anchor===anchor)return provider.corporateWindow.from;
 let from=anchor;for(let n=1;n<250;n++){do{from=new Date(Date.parse(from+'T00:00:00Z')-DAY).toISOString().slice(0,10);}while(!sessionForDate(from));}
 provider.corporateWindow={anchor,from};return from;
}
async function auditHistory(provider,instrument,bars){
 if(instrument.segment!=='NSE_EQ')return {status:'index',policy:'not-applicable'};
 const isin=instrument.isin||instrument.instrument_key.split('|')[1];if(!/^IN[A-Z0-9]{10}$/.test(isin))throw Error('UPSTOX_CORPORATE_ACTION_ISIN_INVALID');
 const now=provider.clock(),key='corporate-actions:'+isin;let cached=await provider.read(key);
 if(!cached||!Number.isFinite(cached.fetchedAt)||now.getTime()-cached.fetchedAt<0||now.getTime()-cached.fetchedAt>=3600000||nowIST(new Date(cached.fetchedAt)).dateKey!==nowIST(now).dateKey){
  const events=await provider.request('/v2/fundamentals/'+encodeURIComponent(isin)+'/corporate-actions');
  // Validate the entire payload before caching, including dates outside lookback.
  classify(events,'1900-01-01','9999-12-31');cached={fetchedAt:now.getTime(),events};await provider.persist(key,cached);
 }
 const historyFrom=nowIST(new Date(bars[0].time*1000)).dateKey,minimumFrom=strategyStart(provider,now);
 const from=historyFrom<minimumFrom?historyFrom:minimumFrom,to=nowIST(now).dateKey,result={...classify(cached.events,from,to),historyFrom,minimumLookbackSessions:250};
 if(result.status==='excluded'){
  const symbol=instrument.trading_symbol;provider.health.corporateExclusions||={};provider.health.corporateExclusions[symbol]=result;
  throw Object.assign(Error('UPSTOX_CORPORATE_ACTION_REVIEW_REQUIRED'),{symbol,audit:result});
 }
 if(provider.health.corporateExclusions)delete provider.health.corporateExclusions[instrument.trading_symbol];return result;
}
module.exports={actionDate,classify,auditHistory};
