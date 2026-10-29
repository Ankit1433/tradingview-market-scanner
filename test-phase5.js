process.env.PRIVATE_MODE='false';
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const {validate,defaults}=require('./src/config/alertPreferences');
const {markerIndex,clean}=require('./public/assets/symbol-chart');
const {createServer}=require('./src/server');
const {closeClient}=require('./src/services/tvHistory');
async function main(){
 assert.deepEqual(validate(defaults),defaults);
 for(const bad of [{modes:[]},{signalTypes:['FAKE']},{minConfluence:8},{minPrice:100,maxPrice:90},{maxAlertsPerDay:-1},{quietStart:'25:99'},{watchlist:['<script>']},{digest:'yes'}])assert.throws(()=>validate({...defaults,...bad}));
 assert.equal(validate({...defaults,user_id:'attacker'}).user_id,undefined);
 const b={time:Date.parse('2026-10-28T03:45:00Z')/1000,open:100,high:110,low:90,close:105};
 assert.equal(markerIndex([b],{ts:'2026-10-28T03:49:59Z'},'5m'),0);
 assert.equal(markerIndex([b],{ts:'2026-10-28T03:50:00Z'},'5m'),-1);
 assert.equal(markerIndex([b],{ts:'2026-10-28T04:30:00Z'},'5m'),-1);
 assert.equal(markerIndex([b],{ts:'2026-10-27T20:00:00Z'},'1d'),0);
 assert.equal(markerIndex([b],{ts:'invalid'},'1d'),-1);
 assert.equal(clean([b,b,{...b,high:NaN}]).length,1);
 for(const name of ['symbol','alerts','stats']){const html=fs.readFileSync(`public/${name}.html`,'utf8');assert(html.includes('id="main-content"'));assert(html.includes('role="status"'));const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);}
 assert(fs.readFileSync('public/login.html','utf8').includes('method="post" action="/api/account/login"'));
 new vm.Script(fs.readFileSync('public/assets/pages.js','utf8'));
 new vm.Script(fs.readFileSync('public/assets/accounts.js','utf8'));
 const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const base=`http://127.0.0.1:${server.address().port}`;for(const route of ['/symbol','/alerts','/stats','/assets/pages.js','/assets/pages.css','/assets/symbol-chart.js'])assert.equal((await fetch(base+route)).status,200,route);}finally{await new Promise(r=>server.close(r));}
 console.log('Phase 5 checks passed: preference validation, timestamp markers, page contracts and asset routes');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(closeClient);
