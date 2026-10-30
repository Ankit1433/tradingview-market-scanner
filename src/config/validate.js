function validate(env=process.env){const errors=[];const bools=['BOOTSTRAP_ADMIN_ON_START','PRIVATE_MODE','PUBLIC_MODE','INGEST_MODE','ENABLE_INTRADAY','ENABLE_SWING','ENABLE_OUTCOMES','ENABLE_PERSONAL_WORKER','SIGNAL_ALERTS_ENABLED','UPSTOX_STREAM_ENABLED','UPSTOX_SCREENING_APPROVED'];for(const name of bools)if(env[name]!==undefined&&!['true','false'].includes(env[name]))errors.push(name+' must be true or false');
 for(const [name,min,max]of [['PORT',1,65535],['RATE_LIMIT_PER_MIN',1,100000],['KEEPALIVE_INTERVAL_MS',1000,86400000],['PUSH_FLUSH_MS',100,3600000],['UPSTOX_FINALIZATION_DELAY_MS',0,600000]])if(env[name]!==undefined&&(!Number.isSafeInteger(Number(env[name]))||Number(env[name])<min||Number(env[name])>max))errors.push(name+' is outside its allowed integer range');
 if(Boolean(env.SUPABASE_URL)!==Boolean(env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY))errors.push('Supabase URL and backend key must be configured together');
 for(const name of ['SUPABASE_URL','PUSH_URL','APP_ORIGIN','CORS_ORIGIN'])if(env[name]&&env[name]!=='*'){try{const url=new URL(env[name]);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error();if(env.NODE_ENV==='production'&&url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw Error();if(name==='APP_ORIGIN'&&url.pathname!=='/')throw Error();}catch(_){errors.push(name+' must be a valid HTTP origin/URL without credentials, query or fragment');}}
 if(env.NODE_ENV==='production'&&env.PRIVATE_MODE!=='false'&&!env.APP_ORIGIN)errors.push('APP_ORIGIN is required for private production hosting');
 if(env.PUSH_URL&&!(env.PUSH_API_KEY||env.API_KEY))errors.push('PUSH_URL requires PUSH_API_KEY or API_KEY');
 if(env.ENABLE_PERSONAL_WORKER==='true'&&(!env.SUPABASE_URL||!env.TELEGRAM_BOT_TOKEN))errors.push('Personal worker requires Supabase and Telegram configuration');
 if(!['tradingview','upstox'].includes(env.MARKET_DATA_PROVIDER||'tradingview'))errors.push('Unsupported MARKET_DATA_PROVIDER');
 if(env.MARKET_DATA_PROVIDER==='upstox'&&!env.UPSTOX_ACCESS_TOKEN)errors.push('Upstox requires its backend token');
 if(errors.length)throw new Error('Invalid startup configuration: '+errors.join('; '));return true;
}
module.exports={validate};
