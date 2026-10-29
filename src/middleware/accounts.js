const crypto=require('crypto');
const {promisify}=require('util');
const scrypt=promisify(crypto.scrypt);
const PRIVATE_MODE=process.env.PRIVATE_MODE!=='false';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const token=()=>crypto.randomBytes(32).toString('hex');
async function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(password,salt,64);return `scrypt:${salt}:${key.toString('hex')}`;}
async function verify(password,stored){const [,salt,key]=(stored||'').split(':');const actual=await scrypt(password,salt||'00000000000000000000000000000000',64);const expected=Buffer.from(key||'00'.repeat(64),'hex');return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected);}
function cookie(req){const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('aq_session='));return raw?.slice(11)||'';}
function setCookie(res,value){res.cookie('aq_session',value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:value?7*86400000:0});}
function createAccounts(store){
 const {hasValidKey}=require('./auth');
 const buckets=new Map();
 function limited(req,res,next){const now=Date.now();for(const [k,v]of buckets)if(v.until<=now)buckets.delete(k);
 const keys=[`ip:${req.ip}`,`email:${String(req.body?.email||'').toLowerCase()}`];
 for(const k of keys){const v=buckets.get(k)||{n:0,until:now+15*60000};v.n++;buckets.set(k,v);if(v.n>10){res.set('Retry-After',String(Math.ceil((v.until-now)/1000)));return res.status(429).json({error:'Too many attempts. Try again later.'});}}next();}
 function sameOrigin(req,res,next){let origin;try{origin=new URL(process.env.APP_ORIGIN||`${req.protocol}://${req.get('host')}`).origin;}catch(_){return res.status(503).json({error:'App origin is not configured'});}
 if(req.get('origin')!==origin)return res.status(403).json({error:'Same-origin request required'});next();}
 async function identify(req,res,next){res.set('Cache-Control','no-store');try{const value=cookie(req);if(/^[a-f0-9]{64}$/.test(value)){const session=await store.session(hash(value));if(session){req.user=await store.user(session.user_id);req.sessionExpires=Date.parse(session.expires_at);}}next();}catch(_){res.status(503).json({error:'Account database unavailable'});}}
 function requireUser(req,res,next){if(!req.user)return res.status(401).json({error:'Login required'});next();}
 function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Admin required'});next();}
 function gate(req,res,next){if(!PRIVATE_MODE)return next();
 if(hasValidKey(req))return next();
 if(!req.user){if(!req.path.startsWith('/api/'))return res.redirect('/login');return res.status(401).json({error:'Login required'});}
 // Shared scanner money/state remains administrator-only, including PUBLIC_MODE=false deployments.
 if(req.user.role!=='admin' && (/^\/api\/scanner\/(positions|summary)/.test(req.path)||/^\/api\/swing\/(positions|trades)/.test(req.path)))return res.status(403).json({error:'Admin required'});
 if(req.path==='/api/public/stream'&&req.sessionExpires){const timer=setTimeout(()=>res.end(),Math.max(0,req.sessionExpires-Date.now()));const check=setInterval(async()=>{try{if(!await store.session(hash(cookie(req))))res.end();}catch(_){res.end();}},30000);res.on('close',()=>{clearTimeout(timer);clearInterval(check);});}
 next();}
 return {limited,sameOrigin,identify,requireUser,admin,gate};
}
module.exports={PRIVATE_MODE,hash,token,passwordHash,verify,cookie,setCookie,createAccounts};
