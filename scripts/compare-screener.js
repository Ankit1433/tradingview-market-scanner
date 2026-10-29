// Offline comparison of same-time normalized screener snapshots; never fetches credentials.
const fs=require('fs');
function compare(baseline,candidate){
 if(!baseline.asOf||baseline.asOf!==candidate.asOf)throw Error('Snapshots must declare the same asOf timestamp');
 if(!baseline.stocks||!candidate.stocks)throw Error('Snapshots must contain stocks keyed by symbol');
 const keys=['price','change','relVolume','avgVolume10d','atrp','marketCap','sma50','sma200','perf3Month'];
 const symbols=[...new Set([...Object.keys(baseline.stocks),...Object.keys(candidate.stocks)])].sort();
 return {asOf:baseline.asOf,onlyBaseline:symbols.filter(s=>baseline.stocks[s]&&!candidate.stocks[s]),onlyCandidate:symbols.filter(s=>candidate.stocks[s]&&!baseline.stocks[s]),comparisons:symbols.filter(s=>baseline.stocks[s]&&candidate.stocks[s]).map(symbol=>({symbol,sectorMatches:baseline.stocks[symbol].sector===candidate.stocks[symbol].sector,fields:Object.fromEntries(keys.map(k=>{const a=baseline.stocks[symbol][k],b=candidate.stocks[symbol][k];return[k,Number.isFinite(a)&&Number.isFinite(b)?{baseline:a,candidate:b,absoluteDifference:b-a,relativeDifferencePct:a?(b-a)/Math.abs(a)*100:null}:{status:'missing-or-non-numeric'}];}))})),note:'Differences require review; this report does not automatically approve parity.'};
}
if(require.main===module){try{const args=process.argv.slice(2);if(args.length!==2)throw Error('Usage: npm run compare:screeners -- baseline.json candidate.json');console.log(JSON.stringify(compare(...args.map(file=>JSON.parse(fs.readFileSync(file,'utf8')))),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={compare};
