const crypto=require('crypto');
const counts={};
function clean(value,key=''){
 if(/password|token|secret|authorization|cookie|api.?key|invite|chat.?id|email/i.test(key))return '[REDACTED]';
 if(value instanceof Error)return {name:value.name,code:value.code||'UNEXPECTED_ERROR'};
 if(typeof value==='string')return value.replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/bot\d+:[^/\s]+/g,'bot[REDACTED]').replace(/https?:\/\/[^\s]+/g,'[URL]');
 if(Array.isArray(value))return value.map(v=>clean(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v,k)]));return value;
}
function log(level,event,fields={}){const output={ts:new Date().toISOString(),level,event,...clean(fields)};(level==='error'?console.error:console.log)(JSON.stringify(output));}
function count(name){counts[name]=(counts[name]||0)+1;}
function middleware(req,res,next){const id=crypto.randomUUID(),start=Date.now();res.set('X-Request-Id',id);res.on('finish',()=>{count('http_total');count('http_'+res.statusCode);log('info','http_request',{requestId:id,method:req.method,route:req.route?.path||'unmatched',status:res.statusCode,durationMs:Date.now()-start});});next();}
module.exports={clean,log,count,middleware,snapshot:()=>({...counts})};
