(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.AQChart=factory();})(typeof window!=='undefined'?window:this,function(){
 function dateKey(seconds){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(seconds*1000));}
 function markerIndex(candles,signal,interval){const stamp=Date.parse(signal.ts)/1000;if(!Number.isFinite(stamp))return -1;
  if(interval==='1d')return candles.findIndex(b=>dateKey(b.time)===dateKey(stamp));
  return candles.findIndex(b=>stamp>=b.time&&stamp<b.time+300);
 }
 function clean(candles){return [...new Map((candles||[]).filter(b=>['time','open','high','low','close'].every(k=>typeof b[k]==='number'&&Number.isFinite(b[k]))&&b.high>=b.low).map(b=>[b.time,b])).values()].sort((a,b)=>a.time-b.time);}
 return {markerIndex,clean,dateKey};
});
