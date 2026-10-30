const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const axios=require('axios');
const {parse}=require('csv-parse/sync');
const {unzipSync}=require('fflate');
const {expectedLast}=require('./freshness');
const {sessionForDate}=require('../services/tradingCalendar');
const {nowIST}=require('../config/timeUtils');
const DAY=86400000;
function fail(code){throw new Error(code);}
function filePath(env=process.env){return env.UPSTOX_UNIVERSE_FILE||path.join(env.SWING_DATA_DIR||path.join(__dirname,'../../data'),'upstox','universe.json');}
function reportUrl(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!sessionForDate(date))fail('UPSTOX_METADATA_DATE_INVALID');return 'https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR'+date.slice(8)+date.slice(5,7)+date.slice(2,4)+'.zip';}
const header=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
function dateKey(value){const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};const m=/^(\d{2})[ -]([A-Za-z]{3})[ -](\d{4})$/.exec(String(value).trim());if(!m||!months[m[2].toLowerCase()])fail('UPSTOX_METADATA_DATE_INVALID');const key=m[3]+'-'+months[m[2].toLowerCase()]+'-'+m[1];const stamp=Date.parse(key+'T00:00:00Z');if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==key)fail('UPSTOX_METADATA_DATE_INVALID');return key;}
function number(value){const s=String(value).trim();if(!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/.test(s))return NaN;return Number(s.replaceAll(',',''));}
function parseMcap(csv,date){
 let rows;try{rows=parse(csv,{bom:true,columns:headers=>headers.map(header),skip_empty_lines:true,trim:true,max_record_size:16384});}catch(_){fail('UPSTOX_METADATA_CSV_INVALID');}
 const fields=['tradedate','symbol','series','issuesize','closepricepaidupvaluers','marketcaprs'];
 if(!rows.length||fields.some(f=>!Object.hasOwn(rows[0],f)))fail('UPSTOX_METADATA_SCHEMA_CHANGED');
 const stocks=new Map();
 for(const row of rows){
  if(row.series!=='EQ')continue;
  if(dateKey(row.tradedate)!==date)fail('UPSTOX_METADATA_DATE_MISMATCH');
  const symbol=row.symbol,marketCap=number(row.marketcaprs),issueSize=number(row.issuesize),close=number(row.closepricepaidupvaluers);
  if(!/^[A-Z0-9.&_-]{1,24}$/.test(symbol)||stocks.has(symbol))fail('UPSTOX_METADATA_DUPLICATE_OR_INVALID_SYMBOL');
  // MCAP's documented Market Cap(Rs.) is already INR, never lakh/crore.
  if(![marketCap,issueSize,close].every(x=>Number.isFinite(x)&&x>0)){stocks.set(symbol,{symbol,unavailable:'NSE_MCAP_VALUES_UNAVAILABLE'});continue;}
  const impliedClose=marketCap/issueSize,relativeGap=Math.abs(marketCap-issueSize*close)/marketCap;
  // The supplied NSE report displays 0.05-grid closes while some market caps
  // imply paisa prices (e.g. 0.15 vs 0.17). Preserve reported cap, allowing at
  // most half that displayed grid, plus floating-point noise. The ratio bound
  // still rejects lakh/crore unit mistakes even at very small prices.
  const roundedCloseCompatible=Math.abs(impliedClose-close)<=.025+1e-7&&impliedClose/close>=.5&&impliedClose/close<=1.5;
  if(relativeGap>.01&&!roundedCloseCompatible)fail('UPSTOX_METADATA_VALUE_OR_UNIT_INVALID');
  stocks.set(symbol,{symbol,marketCap,issueSize,referenceClose:close});
 }
 if(!stocks.size)fail('UPSTOX_METADATA_EMPTY');return [...stocks.values()];
}
function extractMcap(buffer,date){
 const data=Buffer.from(buffer);if(data.length>12*1024*1024||data[0]!==80||data[1]!==75)fail('UPSTOX_METADATA_ARCHIVE_INVALID');
 const name='MCAP'+date.slice(8)+date.slice(5,7)+date.slice(0,4)+'.csv';
 let files;try{files=unzipSync(data,{filter:entry=>entry.name.toUpperCase()===name.toUpperCase()&&entry.originalSize<=12*1024*1024});}catch(_){fail('UPSTOX_METADATA_ARCHIVE_INVALID');}
 const entries=Object.entries(files);if(entries.length!==1)fail('UPSTOX_METADATA_REPORT_MISSING');
 return parseMcap(Buffer.from(entries[0][1]).toString('utf8'),date);
}
async function loadReport(provider,date,{transport=axios}={}){
 const key='nse-mcap:'+date,cached=await provider.read(key);if(cached?.sourceDate===date&&Array.isArray(cached.rows)&&cached.sha256)return cached;
 const url=reportUrl(date);let response;
 try{response=await transport({method:'GET',url,responseType:'arraybuffer',timeout:20000,maxContentLength:12*1024*1024,maxBodyLength:12*1024*1024,headers:{Accept:'application/zip'}});}catch(error){const status=error.response?.status;fail(status===404?'UPSTOX_METADATA_REPORT_NOT_PUBLISHED':status===403?'UPSTOX_METADATA_SOURCE_FORBIDDEN':'UPSTOX_METADATA_SOURCE_UNAVAILABLE');}
 const rows=extractMcap(response.data,date),value={sourceDate:date,source:url,sha256:crypto.createHash('sha256').update(Buffer.from(response.data)).digest('hex'),rows};
 await provider.persist(key,value);return value;
}
function validateManifest(value,now=new Date(),{allowExpired=false}={}){
 if(!value||typeof value.source!=='string'||!value.source.trim()||!Array.isArray(value.stocks)||value.stocks.length<1||value.stocks.length>5000||!['verified','provider-native-audited'].includes(value.adjustmentPolicy))fail('UPSTOX_UNIVERSE_METADATA_STALE_OR_UNVERIFIED');
 const age=now.getTime()-Date.parse(value.asOf);if(!Number.isFinite(age)||age<0||(!allowExpired&&age>7*DAY))fail('UPSTOX_UNIVERSE_METADATA_STALE_OR_UNVERIFIED');
 const symbols=new Set();for(const row of value.stocks){if(!/^[A-Z0-9.&_-]{1,24}$/.test(row.symbol)||symbols.has(row.symbol)||!Number.isFinite(row.marketCap)||row.marketCap<=0||typeof row.sector!=='string'||!row.sector.trim()||row.sector.length>120||row.eligible!==true)fail('UPSTOX_UNIVERSE_METADATA_INVALID');symbols.add(row.symbol);}
 if(value.version===2&&(!value.report||!/^\d{4}-\d{2}-\d{2}$/.test(value.report.sourceDate)||! /^[a-f0-9]{64}$/.test(value.report.sha256)||value.coverage?.expected!==value.stocks.length||!Array.isArray(value.coverage?.excluded)||value.coverage.excluded.length))fail('UPSTOX_UNIVERSE_COVERAGE_INCOMPLETE');
 if(value.version===2&&(value.coverage?.complete!==true||typeof value.universeKey!=='string'||! /^[a-f0-9]{64}$/.test(value.universeKey)||value.scope!=='NSE_EQ_EQ_COMPANY'||value.corporateActionPolicy!=='block-structural-actions'))fail('UPSTOX_UNIVERSE_COVERAGE_INCOMPLETE');
 return value;
}
async function loadManifest(provider,{env=process.env,refresh=false,prepare=prepareUniverse}={}){
 const file=filePath(env);let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){}
 if(!value){const saved=await provider.read('universe-v2');if(saved?.manifest)value=saved.manifest;}
 validateManifest(value,provider.clock(),{allowExpired:refresh&&value?.version===2});
 if(refresh&&value.version===2&&value.report.sourceDate!==expectedLast('D',provider.clock())){
  if(provider.metadataRetryAt&&provider.clock().getTime()<provider.metadataRetryAt&&provider.clock().getTime()-Date.parse(value.asOf)<=7*DAY)return value;
  if(!provider.universePending)provider.universePending=prepare(provider,{env}).finally(()=>{provider.universePending=null;});
  try{value=await provider.universePending;const delayed=value.report.sourceDate!==expectedLast('D',provider.clock());provider.metadataRetryAt=delayed?provider.clock().getTime()+15*60000:0;provider.health.metadataRefresh={status:delayed?'publication-delayed':'current',sourceDate:value.report.sourceDate};}
  catch(error){validateManifest(value,provider.clock());if(!['UPSTOX_METADATA_REPORT_NOT_PUBLISHED','UPSTOX_METADATA_SOURCE_FORBIDDEN','UPSTOX_METADATA_SOURCE_UNAVAILABLE'].includes(error.message))throw error;provider.metadataRetryAt=provider.clock().getTime()+15*60000;provider.health.metadataRefresh={status:'deferred',code:error.message,sourceDate:value.report.sourceDate,note:'Using the original sourced snapshot within the seven-day metadata limit'};}
 }
 return value;
}
async function prepareUniverse(provider,{now=provider.clock(),transport=axios,env=process.env,onProgress=()=>{},signal}={}){
 let date=expectedLast('D',now),report;
 const requestedDate=date;let sourceFailure=null;
 for(let attempt=0;attempt<3;attempt++){
  // A manually imported recent report remains usable after the next close,
  // even if the server cannot download that newer session's archive.
  const cached=await provider.read('nse-mcap:'+date);
  if(cached?.sourceDate===date&&Array.isArray(cached.rows)&&cached.sha256){report=sourceFailure?{...cached,fallback:{requestedDate,reason:sourceFailure.message}}:cached;break;}
  if(!sourceFailure||sourceFailure.message==='UPSTOX_METADATA_REPORT_NOT_PUBLISHED'){
   try{report=await loadReport(provider,date,{transport});break;}
   catch(error){if(!['UPSTOX_METADATA_REPORT_NOT_PUBLISHED','UPSTOX_METADATA_SOURCE_UNAVAILABLE','UPSTOX_METADATA_SOURCE_FORBIDDEN'].includes(error.message))throw error;sourceFailure=error;}
  }
  do{date=new Date(Date.parse(date+'T00:00:00Z')-DAY).toISOString().slice(0,10);}while(!sessionForDate(date));
 }
 if(!report)throw sourceFailure||new Error('UPSTOX_METADATA_SOURCE_UNAVAILABLE');
 const master=await provider.master(),bySymbol=new Map(),scopeExclusions=[];
 for(const item of master.filter(r=>r.segment==='NSE_EQ'&&r.instrument_type==='EQ')){
  const isin=item.isin||item.instrument_key.split('|')[1];
  // NSE EQ series can also contain mutual-fund/ETF units. They are not the
  // company-stock universe and must not be given an invented company sector.
  if(/^INF[A-Z0-9]{9}$/.test(isin)){scopeExclusions.push({symbol:item.trading_symbol,reason:'FUND_UNIT_OUTSIDE_COMPANY_SCOPE'});continue;}
  if(bySymbol.has(item.trading_symbol))fail('UPSTOX_INSTRUMENT_MISSING_OR_AMBIGUOUS');bySymbol.set(item.trading_symbol,item);
 }
 const records=new Map(report.rows.map(row=>[row.symbol,row]));const stocks=[],excluded=[];let processed=0;
 const progress=(currentSymbol=null)=>onProgress({processed,examined:processed,total:bySymbol.size,included:stocks.length,excluded:excluded.length,currentSymbol,updatedAt:provider.clock().toISOString()});
 progress();
 for(const [symbol,item]of [...bySymbol].sort(([a],[b])=>a.localeCompare(b))){
  if(signal?.aborted)fail('UPSTOX_PREPARATION_CANCELLED');
  progress(symbol);
  try {
  const row=records.get(symbol);
  if(!row){excluded.push({symbol,reason:'NSE_EQ_METADATA_MISSING'});continue;}
  if(row.unavailable){excluded.push({symbol,reason:row.unavailable});continue;}
  const isin=item.isin||item.instrument_key.split('|')[1];if(!/^INE[A-Z0-9]{9}$/.test(isin)){excluded.push({symbol,reason:'ISIN_INVALID'});continue;}
  const key='profile:'+isin;let profile=await provider.read(key);
  if(!profile||typeof profile.sector!=='string'||!Number.isFinite(profile.fetchedAt)||now.getTime()-profile.fetchedAt<0||now.getTime()-profile.fetchedAt>7*DAY){
   let data;try{data=await provider.request('/v2/fundamentals/'+encodeURIComponent(isin)+'/profile');}catch(error){if(error.message!=='UPSTOX_HTTP_404')throw error;excluded.push({symbol,reason:'SECTOR_PROFILE_NOT_FOUND'});continue;}
   if(typeof data?.sector!=='string'||!data.sector.trim()||data.sector.length>120){excluded.push({symbol,reason:'SECTOR_METADATA_MISSING'});continue;}
   profile={fetchedAt:provider.clock().getTime(),sector:data.sector.trim(),source:'Upstox /v2/fundamentals/:isin/profile'};await provider.persist(key,profile);
  }
  stocks.push({...row,isin,instrumentKey:item.instrument_key,sector:profile.sector,eligible:true,provenance:{marketCap:report.source,marketCapDate:date,marketCapUnit:'INR',sector:profile.source}});
  } finally { processed++; progress(); }
 }
 if(signal?.aborted)fail('UPSTOX_PREPARATION_CANCELLED');
 const universeKey=crypto.createHash('sha256').update(JSON.stringify(stocks.map(r=>[r.symbol,r.isin]))).digest('hex');
 const session=sessionForDate(date),asOf=new Date(`${date}T${String(session.close.h).padStart(2,'0')}:${String(session.close.m).padStart(2,'0')}:00+05:30`).toISOString();
 const manifest={version:2,universeKey,source:'NSE daily MCAP (CMTR60423) + Upstox company profile',asOf,generatedAt:provider.clock().toISOString(),scope:'NSE_EQ_EQ_COMPANY',adjustmentPolicy:'provider-native-audited',corporateActionPolicy:'block-structural-actions',report:{url:report.source,sha256:report.sha256,sourceDate:date,...(report.fallback?{fallback:report.fallback}:{})},coverage:{expected:bySymbol.size,included:stocks.length,excluded,scopeExclusions,complete:excluded.length===0&&stocks.length>0},stocks};
 // Save incomplete preparation separately, never replace the last valid universe.
 await provider.persist('universe-preparation',{manifest});
 validateManifest(manifest,provider.clock());
 const file=filePath(env);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(manifest),{mode:0o600});fs.renameSync(file+'.tmp',file);
 await provider.persist('universe-v2',{manifest});return manifest;
}
async function assertPrepared(provider,manifest){
 if(manifest.version!==2)return; // Retain externally attested legacy manifests.
 const saved=await provider.read('launch-comparison');
 const report=saved?.comparison,window=report?.captureWindow,start=Date.parse(window?.startedAt),end=Date.parse(window?.finishedAt);
 if(report?.formulaVersion!==require('./screening').FORMULA_VERSION||saved.universeKey!==manifest.universeKey||report.status!=='review-required'||!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>60000||end>provider.clock().getTime()+60000||report.asOf!==window.finishedAt||['intraday','early','swing'].some(mode=>!Array.isArray(report.modes?.[mode]?.comparisons)||!Array.isArray(report.modes?.[mode]?.onlyBaseline)||!Array.isArray(report.modes?.[mode]?.onlyCandidate)))fail('UPSTOX_COMPARISON_REQUIRED');
}
async function importReport(provider,buffer,date,{now=provider.clock(),attested=false}={}){
 if(!attested)fail('UPSTOX_METADATA_SOURCE_ATTESTATION_REQUIRED');
 if(date>expectedLast('D',now)||now.getTime()-Date.parse(date+'T15:30:00+05:30')>7*DAY)fail('UPSTOX_METADATA_DATE_INVALID');
 const source=reportUrl(date),rows=extractMcap(buffer,date),value={sourceDate:date,source,method:'admin-upload-from-NSE',importedAt:now.toISOString(),sha256:crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex'),rows};
 await provider.persist('nse-mcap:'+date,value);return {sourceDate:date,source,sha256:value.sha256,rows:rows.length};
}
module.exports={importReport,assertPrepared,filePath,reportUrl,parseMcap,extractMcap,loadReport,validateManifest,loadManifest,prepareUniverse,dateKey};
