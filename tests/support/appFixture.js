// Test-only construction; production never imports this module.
const fs=require('fs'),os=require('os'),path=require('path');
async function fixture(){
 const {passwordHash}=require('../../src/middleware/accounts');
 const users=new Map();for(const name of ['alice','bob','admin'])users.set(name,{id:name,email:`${name}@example.test`,password_hash:await passwordHash('Fixture-password-123'),role:name==='admin'?'admin':'friend',settings:{capital:100000,riskPct:1}});
 const sessions=new Map();
 const accountStore={
  async userByEmail(email){return [...users.values()].find(u=>u.email===email);},async user(id){return users.get(id)||null;},
  async session(key){const session=sessions.get(key);return session&&Date.parse(session.expires_at)>Date.now()?session:null;},async addSession(row){sessions.set(row.token_hash,row);},async removeSession(key){sessions.delete(key);},
  async preferences(id,value){users.get(id).alert_preferences=value;},async controls(id,value){Object.assign(users.get(id),value);},async settings(id,value){users.get(id).settings=value;},async trades(){return[];},
 };
 const journal=require('../../src/state/signalJournal');journal.load();
 const event=journal.record({ts:'2026-10-28T04:01:00.000Z',eventKey:'a'.repeat(64),mode:'intraday',symbol:'TEST',signals:['PULLBACK','MOMENTUM','VOLUME SPIKE'],price:105,confluence:true,levels:{entry:105,stop:100,target:115},context:{sector:'IT'}});
 const stamp=Date.parse('2026-10-28T03:45:00Z')/1000;
 require('../../src/services/tvHistory').getHist=async()=>Array.from({length:60},(_,i)=>({time:stamp+i*300,open:100+i,high:103+i,low:99+i,close:102+i,volume:1000}));
 const app=require('../../src/server').createServer({accountStore});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;process.env.APP_ORIGIN=base;
 return{base,server,users,sessions,event,async close(){require('../../src/services/eventStream').closeAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await require('../../src/services/tvHistory').closeClient();}};
}
function setupEnv(prefix){const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));Object.assign(process.env,{NODE_ENV:'test',PUSH_URL:'',PUSH_API_KEY:'',TELEGRAM_BOT_TOKEN:'',UPSTOX_ACCESS_TOKEN:'',PRIVATE_MODE:'true',PUBLIC_MODE:'true',SWING_DATA_DIR:dir,API_KEY:'phase7-fixture-machine-key',MARKET_DATA_PROVIDER:'tradingview',RATE_LIMIT_PER_MIN:'10000',ENABLE_INTRADAY:'false',ENABLE_SWING:'false',ENABLE_PERSONAL_WORKER:'false',SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''});return dir;}
module.exports={fixture,setupEnv};
