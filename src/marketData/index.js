const name=process.env.MARKET_DATA_PROVIDER||'tradingview';
if(!['tradingview','upstox'].includes(name))throw new Error('MARKET_DATA_PROVIDER must be tradingview or upstox');
function provider(){return require('./upstox').getProvider();}
function status(){return name==='upstox'?{...provider().health,stream:provider().feed?.status()||{state:'disabled'}}: {provider:'tradingview',status:'legacy-provider'};}
module.exports={name,provider,status};
