require('dotenv').config();
const fs=require('fs');
const {replay}=require('../src/backtest/swingBacktest');
const {getHist,INTERVAL,closeClient}=require('../src/services/tvHistory');
(async()=>{const fixture=process.argv.find(a=>a.startsWith('--fixture='))?.slice(10);let input;
 if(fixture){input=JSON.parse(fs.readFileSync(fixture,'utf8'));input.now=new Date(input.now);}
 else {const names=(process.argv.find(a=>a.startsWith('--symbols='))?.slice(10)||'RELIANCE,TCS').split(',');input={symbols:{},index:await getHist('NIFTY','NSE',INTERVAL.IN_DAILY,1000)||[]};for(const name of names)input.symbols[name]=await getHist(name,'NSE',INTERVAL.IN_DAILY,1000)||[];}
 console.log(JSON.stringify(await replay(input),null,2));})().catch(()=>{console.error('Swing replay failed; check fixture/data availability');process.exitCode=1;}).finally(closeClient);
