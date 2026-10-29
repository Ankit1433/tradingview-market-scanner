const fs=require('fs');
const path=require('path');
const db=require('./supabaseStore');
const file=path.join(process.env.SWING_DATA_DIR||path.join(__dirname,'../../data'),'push-outbox.json');
function identity(row){return row.eventKey||require('crypto').createHash('sha256').update(JSON.stringify(row)).digest('hex');}
function merge(rows){return [...new Map(rows.map(row=>[identity(row),row])).values()];}
function load(){try{return merge(JSON.parse(fs.readFileSync(file,'utf8')));}catch(error){if(error.code!=='ENOENT')console.warn('[outbox] local recovery failed');return[];}}
function save(rows){try{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(rows));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);db.enqueueState('push-outbox',{rows});return true;}catch(_){console.warn('[outbox] persistence failed; delivery durability is degraded');return false;}}
async function hydrate(local){if(!db.status().connected)return local;try{return merge([...(await db.loadState('push-outbox'))?.payload?.rows||[],...local]);}catch(_){return local;}}
module.exports={load,save,hydrate,merge,identity};
