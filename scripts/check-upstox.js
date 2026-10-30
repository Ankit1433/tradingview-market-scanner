require('dotenv').config();
const {details}=require('../src/operations/failureDetails');
async function check({provider,env=process.env}={}) {
 let stage='configuration';
 try{
  if(!env.UPSTOX_ACCESS_TOKEN)throw new Error('UPSTOX_TOKEN_MISSING');
  const p=provider||require('../src/marketData/upstox').getProvider(),samples=[];
  for(const symbol of ['RELIANCE','NIFTY']){
   stage='instrument_'+symbol;const instrument=await p.instrument(symbol);
   stage='quote_'+symbol;const quote=Object.values(await p.quotes([symbol]))[0];
   stage='daily_'+symbol;const daily=await p.history(symbol,'D',250);
   stage='five_minute_'+symbol;const five=await p.history(symbol,'5',100);
   samples.push({symbol,instrument:instrument.instrument_key,price:quote.last_price,dailyBars:daily.length,fiveMinuteBars:five.length,lastDaily:new Date(daily.at(-1).time*1000).toISOString(),lastFiveMinute:new Date(five.at(-1).time*1000).toISOString()});
  }
  return {authenticated:true,host:'current execution environment',samples};
 }catch(error){return {authenticated:false,...details(error,stage)};}
}
if(require.main===module)check().then(result=>{if(result.authenticated)console.log(JSON.stringify(result,null,2));else{console.error(JSON.stringify(result));process.exitCode=1;}});
module.exports={check};
