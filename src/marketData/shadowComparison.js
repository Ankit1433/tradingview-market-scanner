const axios=require('axios');
const {priceEligible,metrics,select,FORMULA_VERSION}=require('./screening');
const {compare}=require('../../scripts/compare-screener');
const {SWING_PAYLOAD}=require('../services/swingScanner');
const {PAYLOAD,EARLY_PAYLOAD}=require('../services/tvScanner');
const COLUMNS=['close','change','relative_volume_10d_calc','average_volume_10d_calc','ATRP','market_cap_basic','sector','SMA50','SMA200','Perf.3M','volume','Perf.W','Perf.1M','price_52_week_high','price_52_week_low'];
const KEYS=['price','change','relVolume','avgVolume10d','atrp','marketCap','sector','sma50','sma200','perf3Month','volume','perfWeek','perfMonth','high52w','low52w'];
const MODES=['intraday','early','swing'];
const DEFAULT_TOLERANCES={price:{relativePct:.5},change:{absolute:.2},relVolume:{relativePct:10},avgVolume10d:{relativePct:1},atrp:{relativePct:5},marketCap:{relativePct:3},sma50:{relativePct:1},sma200:{relativePct:1},perf3Month:{absolute:2},volume:{relativePct:10},perfWeek:{absolute:1},perfMonth:{absolute:2},high52w:{relativePct:1},low52w:{relativePct:1}};
function mapTv(data){
 if(!Array.isArray(data))throw Error('UPSTOX_COMPARISON_BASELINE_INVALID');
 const result={};for(const row of data){if(typeof row.s!=='string'||!row.s.startsWith('NSE:'))continue;const symbol=row.s.slice(4);if(!/^[A-Z0-9.&_-]{1,24}$/.test(symbol)||!Array.isArray(row.d)||row.d.length!==KEYS.length||result[symbol])throw Error('UPSTOX_COMPARISON_BASELINE_INVALID');result[symbol]=Object.fromEntries(KEYS.map((key,i)=>[key,row.d[i]]));}return result;
}
async function baseline(mode,{transport=axios}={}){
 const payload={...({intraday:PAYLOAD,early:EARLY_PAYLOAD,swing:SWING_PAYLOAD})[mode],columns:COLUMNS};
 // Scope both providers to NSE. The legacy endpoint can otherwise return BSE.
 payload.filter=[...payload.filter,{left:'exchange',operation:'equal',right:'NSE'}];
 try{const response=await transport({method:'POST',url:'https://scanner.tradingview.com/india/scan?label-product=screener-stock',data:payload,timeout:20000,headers:{accept:'application/json','content-type':'text/plain;charset=UTF-8',origin:'https://in.tradingview.com',referer:'https://in.tradingview.com/','user-agent':'Mozilla/5.0'}});return mapTv(response.data?.data);}catch(error){if(error.message==='UPSTOX_COMPARISON_BASELINE_INVALID')throw error;throw Error('UPSTOX_COMPARISON_BASELINE_UNAVAILABLE');}
}
function assess(report,tolerances=DEFAULT_TOLERANCES){
 const failures=[];for(const row of report.comparisons){if(!row.sectorMatches)failures.push({symbol:row.symbol,field:'sector',reason:'classification-difference'});for(const [field,tolerance]of Object.entries(tolerances)){const value=row.fields?.[field];if(!value||value.status||!Number.isFinite(value.absoluteDifference)){failures.push({symbol:row.symbol,field,reason:'missing-data'});continue;}const relative=value.relativeDifferencePct;const accepted=tolerance.absolute!==undefined?Math.abs(value.absoluteDifference)<=tolerance.absolute:relative===null?value.absoluteDifference===0:Math.abs(relative)<=tolerance.relativePct;if(!accepted)failures.push({symbol:row.symbol,field,reason:'outside-review-tolerance'});}}
 return {matched:report.comparisons.length,lowSampleWarning:report.comparisons.length<30?'Fewer than 30 matched candidates; collect more sessions before drawing performance/parity conclusions':null,failures,withinReviewTolerances:report.comparisons.length>0&&!failures.length&&!report.onlyBaseline.length&&!report.onlyCandidate.length,tolerances};
}
async function shadowCompare(provider,manifest,{fetchBaseline=baseline,signal,onProgress=()=>{}}={}){
 const rows=manifest.stocks,initial=await provider.quotes(rows.map(r=>r.symbol),{allowUnavailable:true}),prepared=[],excluded=[];
 // Warm the union of all three discovery filters before capturing either feed.
 // No signal evaluation, journal writes, paper-state changes or Telegram sends.
 for(const row of rows){
  if(signal?.aborted)throw Error('UPSTOX_PREPARATION_CANCELLED');
  if(!MODES.some(mode=>priceEligible(mode,row,initial[row.symbol])))continue;
  try{prepared.push({row,bars:await provider.history(row.symbol,'D',250)});}
  catch(error){if(error.message==='UPSTOX_CORPORATE_ACTION_REVIEW_REQUIRED')excluded.push({symbol:row.symbol,audit:error.audit});else{const reason=require('./historyQuality').exclusion(error);if(!reason)throw error;excluded.push({symbol:row.symbol,...reason});}}
  if((prepared.length+excluded.length)%50===0)onProgress({prepared:prepared.length,excluded:excluded.length});
 }
 const startedAt=provider.clock();
 const [quotes,...tv]=await Promise.all([provider.quotes(rows.map(r=>r.symbol),{allowUnavailable:true,force:true}),...MODES.map(mode=>fetchBaseline(mode))]);
 const values={};for(const {row,bars}of prepared){require('./freshness').assertFresh(bars,'D',provider.clock(),provider.publicationDelay);const quote=quotes[row.symbol];if(!quote)continue;if(!require('./quoteFreshness').quoteIsFresh(quote,provider.clock()))throw Error('UPSTOX_SCAN_QUOTES_EXPIRED_DURING_ANALYSIS');const value=metrics(row,quote,bars);if(value)values[row.symbol]=value;}
 const finishedAt=provider.clock();if(finishedAt-startedAt>60000)throw Error('UPSTOX_COMPARISON_CAPTURE_EXPIRED');
 const captureWindow={startedAt:startedAt.toISOString(),finishedAt:finishedAt.toISOString()},asOf=finishedAt.toISOString();
 const modes=Object.fromEntries(MODES.map((mode,i)=>{const report=compare({asOf,stocks:tv[i]},{asOf,stocks:select(mode,values)});return[mode,{...report,...assess(report)}];}));
 const corporateExcluded=excluded.filter(row=>row.audit?.status==='excluded');
 return {reviewVersion:2,checks:{metadataExclusions:manifest.coverage?.excluded||[],corporateActions:{scope:'Price-eligible candidates only; other stocks are audited by the live history path when needed',lookbackSessions:250,preparedHistories:prepared.length,structuralExclusions:corporateExcluded.length,otherHistoryExclusions:excluded.length-corporateExcluded.length},comparison:{modes:MODES,fields:Object.keys(DEFAULT_TOLERANCES),sectorRequired:true,automaticApproval:false},paper:true,slippage:false},status:'review-required',formulaVersion:FORMULA_VERSION,scope:'Current NSE candidates across intraday/early/swing; two feeds captured within a bounded window, not simultaneous ticks or historical universe parity',captureWindow,asOf,universe:rows.length,prepared:prepared.length,excluded,quoteExclusions:provider.health?.quoteExclusions||{},modes,corporateActionPolicy:'Structural and unknown non-dividend actions exclude affected histories; cash dividends remain provider-native, no total-return or adjustment-factor assumptions',approved:false};
}
module.exports={mapTv,baseline,assess,shadowCompare,DEFAULT_TOLERANCES};
