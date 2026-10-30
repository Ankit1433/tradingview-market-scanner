const axios = require('axios');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { nowIST, toMinutes } = require('../config/timeUtils');
const { sessionForDate, nextTradingDay } = require('../services/tradingCalendar');
const { isBarComplete } = require('../services/dailyBars');
const { atr } = require('../indicators/swingTa');
const S = require('../config/swingConstants');
const db = require('../services/supabaseStore');
const {assertFresh}=require('./freshness');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dayBefore = key => new Date(Date.parse(`${key}T00:00:00Z`) - 86400000).toISOString().slice(0,10);
class RequestBudget {
  constructor({ clock = Date.now, sleep = delay, limits = [[1000,40],[60000,450],[1800000,1800]] } = {}) { this.clock=clock;this.sleep=sleep;this.limits=limits;this.times=[];this.chain=Promise.resolve(); }
  take() { const operation=this.chain.then(async()=>{for(;;){const now=this.clock();this.times=this.times.filter(t=>now-t<1800000);let wait=0;for(const [window,max] of this.limits){const xs=this.times.filter(t=>now-t<window);if(xs.length>=max)wait=Math.max(wait,xs[xs.length-max]+window-now);}if(!wait){this.times.push(now);return;}await this.sleep(wait+1);}});this.chain=operation.catch(()=>{});return operation; }
}
function normalize(rows) {
 if(!Array.isArray(rows))throw new Error('UPSTOX_INVALID_CANDLES');
 const result=new Map();for(const row of rows){if(!Array.isArray(row)||row.length<6)throw new Error('UPSTOX_INVALID_CANDLE');
 const [stamp,open,high,low,close,volume]=row,time=Date.parse(stamp)/1000;
 if(!Number.isFinite(time)||time<=0||![open,high,low,close].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)||high<Math.max(open,close,low)||low>Math.min(open,close)||!(volume===null||(typeof volume==='number'&&Number.isFinite(volume)&&volume>=0)))throw new Error('UPSTOX_INVALID_CANDLE');
 result.set(time,{time,open,high,low,close,volume});}return [...result.values()].sort((a,b)=>a.time-b.time);
}
function chunks(from,to,days=28){const result=[];let cursor=from;while(cursor<=to){const end=new Date(Math.min(Date.parse(`${to}T00:00:00Z`),Date.parse(`${cursor}T00:00:00Z`)+(days-1)*86400000)).toISOString().slice(0,10);result.push([cursor,end]);cursor=new Date(Date.parse(`${end}T00:00:00Z`)+86400000).toISOString().slice(0,10);}return result;}
class UpstoxProvider {
 constructor({token=process.env.UPSTOX_ACCESS_TOKEN,transport=axios,clock=()=>new Date(),sleep=delay,budget=new RequestBudget(),cacheDir=process.env.SWING_DATA_DIR||path.join(__dirname,'../../data'),instruments=null,corporateAudit=require('./corporateActions').auditHistory}={}){
  const publicationDelay=Number(process.env.UPSTOX_FINALIZATION_DELAY_MS||10000);
  if(!Number.isSafeInteger(publicationDelay)||publicationDelay<0||publicationDelay>600000)throw new Error('UPSTOX_INVALID_FINALIZATION_DELAY');
  this.publicationDelay=publicationDelay;this.corporateAudit=corporateAudit;
  this.token=token;this.transport=transport;this.clock=clock;this.sleep=sleep;this.budget=budget;this.cacheDir=path.join(cacheDir,'upstox');this.instruments=instruments;this.masterAt=instruments?clock().getTime():0;this.inflight=new Map();this.memory=new Map();this.quoteCache=null;this.masterPending=null;this.blocked=false;this.health={provider:'upstox',status:'unverified',lastSuccess:null,lastError:null};
 }
 async request(route,params={}){
  if(!this.token)throw new Error('UPSTOX_TOKEN_MISSING');if(this.blocked)throw new Error('UPSTOX_AUTH_REJECTED_ROTATE_TOKEN');
  for(let attempt=0;attempt<3;attempt++){await this.budget.take();try{const response=await this.transport({method:'GET',url:'https://api.upstox.com'+route,params,headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json'},timeout:12000});if(response.data?.status!=='success')throw new Error('UPSTOX_INVALID_RESPONSE');this.health={...this.health,provider:'upstox',status:'available',lastSuccess:this.clock().toISOString(),lastError:null};return response.data.data;
   }catch(error){const status=error.response?.status;this.health.status='unavailable';this.health.lastError=status?`HTTP_${status}`:'NETWORK_OR_INVALID_RESPONSE';if(status===401||status===403){this.blocked=true;throw new Error('UPSTOX_AUTH_REJECTED_ROTATE_TOKEN');}if(status&&status!==429&&status<500)throw new Error(`UPSTOX_HTTP_${status}`);if(attempt===2)throw new Error('UPSTOX_REQUEST_FAILED');const header=error.response?.headers?.['retry-after'];let ms=Number(header)*1000;if(!Number.isFinite(ms)&&header)ms=Date.parse(header)-Date.now();await this.sleep(Math.max(Number.isFinite(ms)?ms:0,500*2**attempt+Math.floor(Math.random()*200)));}
  }
 }
 async master(){
  if(this.instruments&&this.clock().getTime()-this.masterAt<86400000)return this.instruments;
  if(this.masterPending)return this.masterPending;
  this.masterPending=this.loadMaster();try{return await this.masterPending;}finally{this.masterPending=null;}
 }
 async loadMaster(){
  const saved=await this.read('instrument-master');
  if(saved&&Array.isArray(saved.rows)&&this.clock().getTime()-saved.fetchedAt<86400000){this.instruments=saved.rows;this.masterAt=saved.fetchedAt;return this.instruments;}
  try{const response=await this.transport({method:'GET',url:'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',responseType:'arraybuffer',timeout:20000});const raw=Buffer.from(response.data);const rows=JSON.parse((raw[0]===31&&raw[1]===139?zlib.gunzipSync(raw):raw).toString());if(!Array.isArray(rows))throw Error();this.instruments=rows.filter(r=>((r.segment==='NSE_EQ'&&r.instrument_type==='EQ')||r.segment==='NSE_INDEX')&&typeof r.instrument_key==='string');if(!this.instruments.length)throw Error();this.masterAt=this.clock().getTime();await this.persist('instrument-master',{fetchedAt:this.masterAt,rows:this.instruments});return this.instruments;}catch(_){throw new Error('UPSTOX_INSTRUMENT_MASTER_UNAVAILABLE');}
 }
 async instrument(symbol){const clean=symbol.replace(/^NSE:/,'');const rows=await this.master();const matches=rows.filter(r=>clean==='NIFTY'||clean==='Nifty 50'?r.instrument_key==='NSE_INDEX|Nifty 50':r.trading_symbol===clean&&r.segment==='NSE_EQ');if(matches.length!==1)throw new Error('UPSTOX_INSTRUMENT_MISSING_OR_AMBIGUOUS');return matches[0];}
 async read(key){if(this.memory.has(key))return this.memory.get(key);let value=null;try{value=JSON.parse(fs.readFileSync(path.join(this.cacheDir,Buffer.from(key).toString('hex')+'.json'),'utf8'));}catch(_){}
  if(db.status().connected){try{const row=await db.loadState('upstox:'+key);if(row?.payload&&(!value||row.payload.fetchedAt>value.fetchedAt))value=row.payload;}catch(_){} }
  if(value)this.memory.set(key,value);return value;
 }
 async persist(key,value){this.memory.set(key,value);fs.mkdirSync(this.cacheDir,{recursive:true});const file=path.join(this.cacheDir,Buffer.from(key).toString('hex')+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);db.enqueueState('upstox:'+key,value);}
 async history(symbol,interval,nBars){if(!['5','D'].includes(interval)||!Number.isInteger(nBars)||nBars<1||nBars>10000)throw new Error('UPSTOX_UNSUPPORTED_HISTORY_REQUEST');const item=await this.instrument(symbol),key=`${item.instrument_key}:${interval}`;
  // Coalesce by instrument/timeframe; grow a smaller in-flight request if needed.
  if(this.inflight.has(key)){await this.inflight.get(key);return this.history(symbol,interval,nBars);}
  const operation=(async()=>{const bars=await this.loadHistory(item,interval,nBars,key);await this.corporateAudit(this,item,bars);return bars;})();this.inflight.set(key,operation);try{return await operation;}finally{this.inflight.delete(key);}
 }
 async loadHistory(item,interval,nBars,key){const now=this.clock(),today=nowIST(now).dateKey,previous=dayBefore(today),daily=interval==='D',unit=daily?'days':'minutes',count=daily?1:5;
  const old=await this.read(key);if(old&&(old.bars.length>=nBars||old.requestedBars>=nBars)&&now.getTime()-old.fetchedAt<(daily?6*3600000:15000)){try{assertFresh(old.bars,interval,now,this.publicationDelay);return old.bars.slice(-nBars).map(b=>({...b}));}catch(_){/* A new bar can close inside the TTL: refresh instead of returning stale data. */}}
  const days=daily?Math.ceil(nBars*1.7+30):Math.ceil(nBars/75*1.7+7);const wanted=new Date(now.getTime()-days*86400000).toISOString().slice(0,10);
  let from=old?.bars.length>=nBars?nowIST(new Date(old.bars.at(-1).time*1000)).dateKey:wanted;
  from=from<(daily?'2000-01-01':'2022-01-01')?(daily?'2000-01-01':'2022-01-01'):from;
  let bars=old?.bars||[];for(const [start,end]of chunks(from,previous,daily?3600:28)){const data=await this.request(`/v3/historical-candle/${encodeURIComponent(item.instrument_key)}/${unit}/${count}/${end}/${start}`);bars=bars.concat(normalize(data.candles));}
  // Current-day endpoint is authoritative for forming/current-session data; filter before returning.
  if(sessionForDate(today)){const current=await this.request(`/v3/historical-candle/intraday/${encodeURIComponent(item.instrument_key)}/${unit}/${count}`);bars=bars.concat(normalize(current.candles));}
  bars=[...new Map(bars.map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time).filter(b=>{const date=nowIST(new Date(b.time*1000)).dateKey;if(!sessionForDate(date))return false;if(daily)return isBarComplete(b,now);const s=sessionForDate(date),minute=toMinutes(nowIST(new Date(b.time*1000)).time);return minute>=toMinutes(s.open)&&minute<toMinutes(s.close)&&b.time*1000+300000+this.publicationDelay<=now.getTime();});
  if(!daily&&bars.length){for(let i=1;i<bars.length;i++){const a=nowIST(new Date(bars[i-1].time*1000)).dateKey,b=nowIST(new Date(bars[i].time*1000)).dateKey;if(a===b&&bars[i].time-bars[i-1].time!==300){this.health.lastError='CANDLE_GAP';throw new Error('UPSTOX_CANDLE_GAP');}}}
  if(!bars.length)throw new Error('UPSTOX_NO_COMPLETED_CANDLES');
  if(item.segment==='NSE_EQ' && bars.some(b=>!Number.isFinite(b.volume)))throw new Error('UPSTOX_EQUITY_VOLUME_MISSING');
  if(daily){for(let i=1;i<bars.length;i++){const a=nowIST(new Date(bars[i-1].time*1000)).dateKey,b=nowIST(new Date(bars[i].time*1000)).dateKey;const expected=nextTradingDay(a);if(expected!==b)throw Object.assign(new Error('UPSTOX_DAILY_CANDLE_GAP'),{previousSession:a,expectedSession:expected,actualSession:b});}}

  assertFresh(bars,interval,now,this.publicationDelay);
  await this.persist(key,{provider:'upstox',adjustmentPolicy:'unverified-provider-native',fetchedAt:now.getTime(),requestedBars:nBars,bars:bars.slice(-10000)});return bars.slice(-nBars).map(b=>({...b}));
 }
 async quotes(symbols,{allowUnavailable=false,force=false}={}){
  const now=this.clock().getTime(),cacheKey=(allowUnavailable?'discovery:':'')+[...symbols].sort().join(',');
  if(!force&&this.quoteCache?.key===cacheKey&&now-this.quoteCache.at<10000&&Object.values(this.quoteCache.value).every(q=>require('./quoteFreshness').quoteIsFresh(q,this.clock())))return this.quoteCache.value;
  const records=await Promise.all(symbols.map(s=>this.instrument(s))),result={},unavailable={};
  for(let offset=0;offset<records.length;offset+=500){
   const batch=records.slice(offset,offset+500),data=await this.request('/v3/market-quote/quotes',{instrument_key:batch.map(r=>r.instrument_key).join(',')});
   for(const row of batch){const name=row.trading_symbol||'NIFTY',quote=Object.values(data).find(q=>q.instrument_token===row.instrument_key);
    if(!quote||!Number.isFinite(quote.last_price)||quote.last_price<=0||!Number.isFinite(Date.parse(quote.timestamp))||!require('./quoteFreshness').quoteIsFresh(quote,this.clock())){
     if(!allowUnavailable)throw new Error('UPSTOX_STALE_OR_MISSING_QUOTE');unavailable[name]={reason:quote?'invalid-or-stale-quote':'quote-missing'};continue;
    }
    if(allowUnavailable&&(!Number.isFinite(quote.prev_close_price)||quote.prev_close_price<=0||!Number.isFinite(quote.volume)||quote.volume<0)){unavailable[name]={reason:'missing-discovery-fields'};continue;}
    result[name]=quote;
   }
  }
  if(!Object.keys(result).length)throw new Error('UPSTOX_STALE_OR_MISSING_QUOTE');
  if(allowUnavailable)this.health.quoteExclusions=unavailable;
  this.quoteCache={key:cacheKey,at:now,value:result};return result;
 }

 async niftyChange(){const q=Object.values(await this.quotes(['NIFTY']))[0];if(!(q.prev_close_price>0))throw new Error('UPSTOX_INDEX_PREVIOUS_CLOSE_MISSING');return (q.last_price/q.prev_close_price-1)*100;}
 async screen(mode){
  if(!['intraday','early','swing'].includes(mode))throw Error('UPSTOX_SCREEN_MODE_INVALID');
  if(process.env.UPSTOX_SCREENING_APPROVED!=='true')throw new Error('UPSTOX_SCREENING_PARITY_APPROVAL_REQUIRED');
  const manifest=await require('./universe').loadManifest(this,{refresh:true});
  await require('./universe').assertPrepared(this,manifest);
  const {priceEligible,metrics,eligible}=require('./screening');
  const rows=manifest.stocks,quotes=await this.quotes(rows.map(r=>r.symbol),{allowUnavailable:true}),prepared=[];
  for(const row of rows){
   if(!priceEligible(mode,row,quotes[row.symbol]))continue;
   try{prepared.push({row,bars:await this.history(row.symbol,'D',250)});if(this.health.historyExclusions)delete this.health.historyExclusions[row.symbol];}
   catch(error){if(error.message==='UPSTOX_CORPORATE_ACTION_REVIEW_REQUIRED')continue;const excluded=require('./historyQuality').exclusion(error);if(excluded){this.health.historyExclusions||={};this.health.historyExclusions[row.symbol]=excluded;continue;}throw error;}
  }
  // Cold preparation can take minutes. Expired quote caches are refreshed
  // before final gates; only current live or last-session snapshots qualify.
  const fresh=await this.quotes(rows.map(r=>r.symbol),{allowUnavailable:true}),candidates=[];
  for(const {row,bars}of prepared){assertFresh(bars,'D',this.clock(),this.publicationDelay);const q=fresh[row.symbol];if(!priceEligible(mode,row,q))continue;const value=metrics(row,q,bars);if(eligible(mode,value))candidates.push([row.symbol,value]);}
  for(const [symbol]of candidates)if(!require('./quoteFreshness').quoteIsFresh(fresh[symbol],this.clock()))throw new Error('UPSTOX_SCAN_QUOTES_EXPIRED_DURING_ANALYSIS');
  candidates.sort((a,b)=>(mode==='swing'?b[1].perf3Month-a[1].perf3Month:b[1].relVolume-a[1].relVolume)||a[0].localeCompare(b[0]));
  this.health.lastScreen={mode,at:this.clock().toISOString(),universe:rows.length,prepared:prepared.length,excluded:Object.keys(this.health.corporateExclusions||{}).length,historyExcluded:Object.keys(this.health.historyExclusions||{}).length,quoteExcluded:Object.keys(this.health.quoteExclusions||{}).length};
  return Object.fromEntries(candidates.slice(0,mode==='swing'?S.SWING_SCAN_LIMIT:100));
 }

}
let singleton;
function getProvider(){if(!singleton)singleton=new UpstoxProvider();return singleton;}
module.exports={UpstoxProvider,RequestBudget,normalize,chunks,getProvider};
