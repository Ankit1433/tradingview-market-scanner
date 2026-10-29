const TYPES = ['PULLBACK','ORB BREAKOUT','NO-PULLBACK RUNNER','AFTERNOON BREAKOUT','MOMENTUM','VOLUME SPIKE','VWAP RECLAIM','BASE BREAKOUT','MA PULLBACK','MA STACK','52W HIGH','VOLUME DRYUP','RS LEADER'];
const defaults = { modes:['intraday','swing'],signalTypes:[],minConfluence:3,minPrice:100,maxPrice:5000,sectors:[],quietEnabled:false,quietStart:'22:00',quietEnd:'08:00',maxAlertsPerDay:20,watchlistOnly:false,watchlist:[],digest:false };
function validate(value) {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Preferences must be an object');
 const result={...defaults,...value};
 function list(key,max,allowed){const xs=result[key];if(!Array.isArray(xs)||xs.length>max||xs.some(x=>typeof x!=='string'||!allowed(x)))throw new Error(`Invalid ${key}`);result[key]=[...new Set(xs)];}
 list('modes',2,x=>['intraday','swing'].includes(x));if(!result.modes.length)throw new Error('Choose at least one mode');
 list('signalTypes',TYPES.length,x=>TYPES.includes(x));list('sectors',50,x=>x.length>0&&x.length<=120);list('watchlist',200,x=>/^[A-Z0-9.&_-]{1,24}$/.test(x));
 if(!Number.isInteger(result.minConfluence)||result.minConfluence<1||result.minConfluence>7)throw new Error('Minimum signal count must be 1–7');
 if(!Number.isFinite(result.minPrice)||!Number.isFinite(result.maxPrice)||result.minPrice<0||result.maxPrice<result.minPrice||result.maxPrice>1e8)throw new Error('Invalid price range');
 if(!Number.isInteger(result.maxAlertsPerDay)||result.maxAlertsPerDay<0||result.maxAlertsPerDay>1000)throw new Error('Daily alert limit must be 0–1000');
 for(const key of ['quietEnabled','watchlistOnly','digest'])if(typeof result[key]!=='boolean')throw new Error(`Invalid ${key}`);
 for(const key of ['quietStart','quietEnd'])if(typeof result[key]!=='string'||! /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result[key]))throw new Error('Quiet hours must be HH:MM');
 return Object.fromEntries(Object.keys(defaults).map(k=>[k,result[k]]));
}
module.exports={TYPES,defaults,validate};
