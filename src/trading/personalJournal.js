const {nowIST}=require('../config/timeUtils');
const {nextTradingDay}=require('../services/tradingCalendar');
function positive(x){return typeof x==='number'&&Number.isFinite(x)&&x>0;}
function settings(input){if(!positive(input.capital)||input.capital>1e10||!positive(input.riskPct)||input.riskPct>10)throw new Error('Capital must be positive and risk must be 0–10%');return {capital:input.capital,riskPct:input.riskPct};}
function plan(input,config,open=[]){settings(config);const {entry,stop}=input;if(!positive(entry)||!positive(stop)||stop>=entry)throw new Error('Entry must be greater than a positive stop');
 const risk=entry-stop,available=Math.max(0,config.capital-open.filter(t=>!t.closed_at).reduce((sum,t)=>sum+Number(t.entry)*t.quantity,0));
 const suggested=Math.floor(Math.min(config.capital*config.riskPct/100/risk,available/entry));
 const quantity=input.quantity??suggested;if(!Number.isInteger(quantity)||quantity<1||quantity>1e7)throw new Error('Quantity must be a positive integer; available capital may be insufficient');
 if(quantity*entry>available||quantity*risk>config.capital*config.riskPct/100)throw new Error('Quantity exceeds your capital or risk limit');
 const target=input.target??entry+2.5*risk,trail_pct=input.trailPct??1.5,time_stop_sessions=input.timeStopSessions??15;
 if(!positive(target)||target<=entry||!positive(trail_pct)||trail_pct>50||!Number.isInteger(time_stop_sessions)||time_stop_sessions<1||time_stop_sessions>100)throw new Error('Invalid target, trail or time stop');
 return {entry,stop,target,quantity,trail_pct,time_stop_sessions,highest:entry};}
function stats(trades){const closed=trades.filter(t=>t.closed_at&&positive(Number(t.exit)));const values=closed.map(t=>(Number(t.exit)-Number(t.entry))/(Number(t.entry)-Number(t.stop)));return {label:'Personal paper results — no slippage or fees',closed:values.length,open:trades.length-closed.length,totalR:values.reduce((a,b)=>a+b,0),meanR:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,winRate:values.length?values.filter(r=>r>0).length/values.length:null,warning:values.length<30?'Small sample: n < 30':null};}
function reminders(trade,price,now=new Date()){
 if(trade.closed_at||!positive(price))return [];
 const types=[];if(price<=Number(trade.stop))types.push('stop');if(price>=Number(trade.target))types.push('target');
 if(Number(trade.highest)>Number(trade.entry)&&price<=Number(trade.highest)*(1-Number(trade.trail_pct)/100))types.push('trail');
 let due=nowIST(new Date(trade.opened_at)).dateKey;for(let i=0;i<trade.time_stop_sessions;i++)due=nextTradingDay(due);
 const local=nowIST(now);
 if((trade.mode==='intraday' && (local.dateKey>nowIST(new Date(trade.opened_at)).dateKey || local.time.h*60+local.time.m>=15*60+15)) || local.dateKey>=due)types.push('time_stop');
 return types.map(kind=>({user_id:trade.user_id,trade_id:trade.id,kind,message:`PAPER REMINDER · ${trade.symbol}\n${kind.replace('_',' ')} level reached at ₹${price.toFixed(2)}. Review your personal paper journal. No order placed.`}));}
module.exports={positive,settings,plan,stats,reminders};
