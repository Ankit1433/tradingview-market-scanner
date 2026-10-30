const {atr}=require('../indicators/swingTa');
const S=require('../config/swingConstants');
const FORMULA_VERSION='completed-daily-v1';
function discoveryEligible(mode,row,price,change){return mode==='swing'?price>=S.SWING_MIN_PRICE&&price<=S.SWING_MAX_PRICE&&change<5&&row.marketCap>S.SWING_MIN_MARKET_CAP:price>=100&&price<=3000&&(mode==='early'?change>=.5&&change<=3:change>2);}
function priceEligible(mode,row,q){
 if(!q||!Number.isFinite(q.last_price)||q.last_price<=0||!Number.isFinite(q.prev_close_price)||q.prev_close_price<=0)return false;
 const change=(q.last_price-q.prev_close_price)/q.prev_close_price*100;
 return discoveryEligible(mode,row,q.last_price,change);
}
function metrics(row,q,bars){
 if(bars.length<200||!bars.slice(-10).every(b=>Number.isFinite(b.volume)&&b.volume>=0)||!Number.isFinite(q.volume)||q.volume<0)return null;
 const price=q.last_price,average=bars.slice(-10).reduce((s,b)=>s+b.volume,0)/10;
 const mean=n=>bars.slice(-n).reduce((sum,b)=>sum+b.close,0)/n;
 return {price,change:(price-q.prev_close_price)/q.prev_close_price*100,relVolume:average>0?q.volume/average:0,sector:row.sector,marketCap:row.marketCap,volume:q.volume,atrp:atr(bars,14).at(-1)/price*100,avgVolume10d:average,perfWeek:(bars.at(-1).close/bars.at(-6).close-1)*100,perfMonth:(bars.at(-1).close/bars.at(-22).close-1)*100,perf3Month:(bars.at(-1).close/bars.at(-64).close-1)*100,high52w:Math.max(...bars.map(b=>b.high)),low52w:Math.min(...bars.map(b=>b.low)),sma50:mean(50),sma200:mean(200),source:'upstox',formulaVersion:FORMULA_VERSION};
}
function eligible(mode,value){return value&&(mode==='swing'?value.avgVolume10d>S.SWING_MIN_AVG_VOLUME&&value.atrp>S.SWING_MIN_ATRP&&value.price>value.sma200&&value.sma50>value.sma200:value.avgVolume10d>500000&&value.atrp>(mode==='early'?1.5:2)&&value.relVolume>(mode==='early'?1.2:2));}
function select(mode,rows){return Object.fromEntries(Object.entries(rows).filter(([,v])=>discoveryEligible(mode,v,v.price,v.change)&&eligible(mode,v)).sort((a,b)=>(mode==='swing'?b[1].perf3Month-a[1].perf3Month:b[1].relVolume-a[1].relVolume)||a[0].localeCompare(b[0])).slice(0,mode==='swing'?S.SWING_SCAN_LIMIT:100));}
module.exports={FORMULA_VERSION,priceEligible,metrics,eligible,select};
