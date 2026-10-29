const fs=require('fs');
const path=require('path');
const db=require('../services/supabaseStore');
const {VERSION}=require('../evidence/outcomes');
const file=path.join(process.env.SWING_DATA_DIR||path.join(__dirname,'../../data'),'signal-outcomes.json');
let rows=new Map(), loaded=false;
function key(r){return `${r.eventKey}:${r.version}`;}
function load(){if(loaded)return;loaded=true;if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,'utf8'));rows=new Map(saved.map(r=>[key(r),r]));}}
function all(){load();return [...rows.values()].filter(r=>r.version===VERSION);}
function get(eventKey){load();return rows.get(`${eventKey}:${VERSION}`);}
function save(r){load();const old=rows.get(key(r));if(old && old.evaluatedAt>r.evaluatedAt)return;
 rows.set(key(r),r);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify([...rows.values()]));fs.renameSync(file+'.tmp',file);
 db.enqueue('outcome write',()=>db.upsertOutcome(r));}
async function hydrate(){load();if(!db.status().connected)return;try{for(const r of await db.loadOutcomes()){const old=rows.get(key(r));if(!old||old.evaluatedAt<r.evaluatedAt)rows.set(key(r),r);}for(const r of rows.values())await db.upsertOutcome(r);}catch(_){console.warn('[outcomes] database unavailable; retaining local evidence');}}
module.exports={all,get,save,hydrate};
