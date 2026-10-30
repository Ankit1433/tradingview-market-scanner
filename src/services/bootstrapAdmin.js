const {passwordHash}=require('../middleware/accounts');

async function onStartup({env=process.env,store=require('./accountStore'),hash=passwordHash,log=console.log}={}) {
  if(env.BOOTSTRAP_ADMIN_ON_START!=='true')return 'disabled';
  try {
    // The SQL RPC also locks and rejects any nonempty account table. Existing
    // accounts are never updated, including on repeated starts or replica races.
    if(await store.firstUser()) {
      log('Admin bootstrap skipped: accounts already exist. Remove bootstrap environment variables.');
      return 'existing';
    }
    const email=env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const password=env.BOOTSTRAP_ADMIN_PASSWORD;
    if(!email||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof password!=='string'||password.length<12||password.length>128)throw Error();
    try {await store.bootstrap(email,await hash(password));}
    catch(_) {if(!await store.firstUser())throw Error();return 'existing';}
    log('Initial admin created. Remove BOOTSTRAP_ADMIN_ON_START, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD from Render.');
    return 'created';
  } catch(_) {
    // Do not propagate database/transport exceptions containing request payloads.
    throw new Error('Admin bootstrap failed. Check backend database configuration, account migration and bootstrap credentials.');
  }
}
module.exports={onStartup};
