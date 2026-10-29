require('dotenv').config();
const {passwordHash}=require('../src/middleware/accounts');
(async()=>{
 const email=process.env.BOOTSTRAP_ADMIN_EMAIL,password=process.env.BOOTSTRAP_ADMIN_PASSWORD;
 if(!email||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length<12||password.length>128)throw Error('configuration');
 await require('../src/services/accountStore').bootstrap(email.trim().toLowerCase(),await passwordHash(password));
 console.log('Initial admin created. Remove the bootstrap password from environment settings.');
})().catch(()=>{console.error('Admin bootstrap failed. Check configuration, migration and whether accounts already exist.');process.exitCode=1;});
