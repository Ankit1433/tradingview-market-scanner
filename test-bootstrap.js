const assert=require('node:assert/strict');
const {onStartup}=require('./src/services/bootstrapAdmin');
const {verify}=require('./src/middleware/accounts');
(async()=>{
 const env={BOOTSTRAP_ADMIN_ON_START:'true',BOOTSTRAP_ADMIN_EMAIL:' Admin@Example.test ',BOOTSTRAP_ADMIN_PASSWORD:'Unique-fixture-password-123'};
 let account=null,calls=0;const logs=[];
 const store={firstUser:async()=>account,bootstrap:async(email,password)=>{calls++;account={email,password};}};
 assert.equal(await onStartup({env:{},store:{},log:()=>{}}),'disabled');
 assert.equal(await onStartup({env,store,log:x=>logs.push(x)}),'created');
 assert.equal(account.email,'admin@example.test');assert.notEqual(account.password,env.BOOTSTRAP_ADMIN_PASSWORD);assert(await verify(env.BOOTSTRAP_ADMIN_PASSWORD,account.password));
 const original=account.password;assert.equal(await onStartup({env:{...env,BOOTSTRAP_ADMIN_PASSWORD:'Changed-password-123'},store,log:x=>logs.push(x)}),'existing');assert.equal(calls,1);assert.equal(account.password,original);
 for(const changes of [{BOOTSTRAP_ADMIN_PASSWORD:'short'},{BOOTSTRAP_ADMIN_EMAIL:'invalid'}])await assert.rejects(onStartup({env:{...env,...changes},store:{firstUser:async()=>null},log:()=>{}}),/Admin bootstrap failed/);
 await assert.rejects(onStartup({env,store:{firstUser:async()=>{throw Error(env.BOOTSTRAP_ADMIN_PASSWORD);}}}),e=>!e.message.includes(env.BOOTSTRAP_ADMIN_PASSWORD)&&e.message.includes('Admin bootstrap failed'));
 let checks=0;assert.equal(await onStartup({env,store:{firstUser:async()=>++checks>1?{id:'winner'}:null,bootstrap:async()=>{throw Error('already initialized');}},log:()=>{}}),'existing');
 assert(!logs.join(' ').includes(env.BOOTSTRAP_ADMIN_PASSWORD));assert(!logs.join(' ').includes(env.BOOTSTRAP_ADMIN_EMAIL));
 console.log('Startup bootstrap tests passed: opt-in, real password hash, first-account creation, no resets, validation, sanitized errors and concurrent initialization.');
})().catch(e=>{console.error(e);process.exitCode=1;});
