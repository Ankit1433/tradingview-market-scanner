const {annotateSwing}=require('../indicators/swingTa');
const {evaluateSwingSignals}=require('../indicators/swingSignals');
const {completedBars,barDateKey}=require('../services/dailyBars');
const {nextTradingDay}=require('../services/tradingCalendar');
const {resolveStop,positionSize}=require('../trading/swingPositionManager');
const S=require('../config/swingConstants');
const {LABEL,validBar}=require('../evidence/outcomes');
// Isolated portfolio: never reads or mutates the live position state.
async function replay({symbols,index=[],now=new Date(),evaluate=evaluateSwingSignals}) {
 const clean=rows=>completedBars(rows.filter(validBar),now).sort((a,b)=>a.time-b.time);
 const data=Object.fromEntries(Object.entries(symbols).map(([s,b])=>[s,clean(b)]));
 const benchmark=clean(index);const dates=[...new Set(Object.values(data).flatMap(b=>b.map(barDateKey)))].sort();
 const positions=new Map(),pending=new Map(),trades=[],decisions=[];
 const close=(symbol,p,price,reason,date)=>{p.pnl+=p.remaining*(price-p.entry);trades.push({...p,symbol,exit:price,reason,closedOn:date,resultR:p.pnl/(p.qty*p.risk)});positions.delete(symbol);};
 for(const date of dates){
  const today=new Map(Object.entries(data).map(([s,b])=>[s,b.find(c=>barDateKey(c)===date)]).filter(([,b])=>b));
  // Yesterday's decisions execute only at the next session open, subject to portfolio limits.
  for(const [symbol,plan] of pending){if(plan.date>date)continue;pending.delete(symbol);const bar=today.get(symbol);
   if(plan.date!==date||!bar||positions.has(symbol)||positions.size>=S.SWING_MAX_OPEN_POSITIONS)continue;
   if(bar.open<=plan.stop)continue;
   const deployed=[...positions.values()].reduce((n,p)=>n+p.remaining*p.entry,0);
   const sizing=positionSize(bar.open,plan.stop,S.SWING_TOTAL_CAPITAL-deployed);if(!sizing)continue;
   positions.set(symbol,{entry:bar.open,stop:plan.stop,initialStop:plan.stop,risk:bar.open-plan.stop,qty:sizing.qty,remaining:sizing.qty,target:bar.open+(bar.open-plan.stop)*S.SWING_TARGET_R_MULTIPLE,highest:bar.open,partial:false,pnl:0,barsHeld:0,openedOn:date,signals:plan.signals});
  }
  for(const [symbol,p] of positions){const bar=today.get(symbol);if(!bar)continue;p.barsHeld++;
   // Use the stop known before this bar; if stop and target both touch, stop wins.
   if(bar.low<=p.stop){close(symbol,p,p.stop,'stop',date);continue;}
   if(!p.partial && bar.high>=p.target){const qty=Math.floor(p.qty*S.SWING_PARTIAL_EXIT_FRACTION);p.pnl+=qty*(p.target-p.entry);p.remaining-=qty;p.partial=true;p.stop=p.entry;}
   const prefix=data[symbol].filter(b=>barDateKey(b)<=date).map(b=>({...b}));annotateSwing(prefix);const last=prefix.at(-1);
   p.highest=Math.max(p.highest,bar.high);
   if(p.partial)p.stop=Math.max(p.stop,p.highest-S.SWING_TRAIL_ATR_MULTIPLIER*last.atr);
   else if(p.barsHeld>=S.SWING_TIME_STOP_DAYS && (bar.close-p.entry)/p.risk<1)close(symbol,p,bar.close,'time_stop',date);
  }
  const indexPrefix=benchmark.filter(b=>barDateKey(b)<=date);const lastIndex=indexPrefix.at(-1);
  const indexReturn=lastIndex&&barDateKey(lastIndex)===date&&indexPrefix.length>S.SWING_RS_LOOKBACK_DAYS?(lastIndex.close/indexPrefix.at(-1-S.SWING_RS_LOOKBACK_DAYS).close-1)*100:null;
  const plans=[];
  for(const [symbol,bar] of today){if(positions.has(symbol))continue;
   const prefix=data[symbol].filter(b=>barDateKey(b)<=date).map(b=>({...b}));if(prefix.length<60)continue;annotateSwing(prefix);
   const result=await evaluate(symbol,indexReturn,{candles:prefix,now:new Date(`${date}T23:59:59+05:30`)});
   if(!result||result.signals.length<S.SWING_CONFLUENCE_MIN_SIGNALS)continue;
   const structural=result.signals.find(s=>Number.isFinite(s.entry)&&Number.isFinite(s.structuralStop));if(!structural)continue;
   const {stop}=resolveStop(bar.close,result.atr,structural.structuralStop);if(!(stop>0&&stop<bar.close))continue;
   plans.push({symbol,date:nextTradingDay(date),decisionDate:date,stop,signals:result.signals.map(s=>s.label)});
  }
  plans.sort((a,b)=>b.signals.length-a.signals.length||a.symbol.localeCompare(b.symbol));
  for(const plan of plans){pending.set(plan.symbol,plan);decisions.push(plan);}
 }
 return {label:LABEL,model:'Next-open entries; OHLC stop-first exits; trails updated after each close; no gap slippage',universe:Object.keys(data),coverage:Object.fromEntries(Object.entries(data).map(([s,b])=>[s,{bars:b.length,first:b[0]?barDateKey(b[0]):null,last:b.at(-1)?barDateKey(b.at(-1)):null}])),decisions,trades,openPositions:[...positions].map(([symbol,p])=>({symbol,...p})),sampleSize:trades.length,warning:trades.length<30?'Small sample: n < 30':null};
}
module.exports={replay};
