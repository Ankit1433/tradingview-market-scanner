require('dotenv').config();
const fs=require('fs');
const {nowIST}=require('../src/config/timeUtils');
const checks=[];
function add(name,passed,action){checks.push({name,passed:Boolean(passed),...(passed?{}:{action})});}
(async()=>{
 add('upstox_token_configured',process.env.UPSTOX_ACCESS_TOKEN,'Configure UPSTOX_ACCESS_TOKEN privately on this host');
 add('private_access_enabled',process.env.PRIVATE_MODE!=='false','Enable PRIVATE_MODE for invite-only hosting');
 add('database_configuration',process.env.SUPABASE_URL&&(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY),'Configure backend Supabase URL and secret');
 add('origin_configuration',process.env.APP_ORIGIN,'Set APP_ORIGIN to your browser origin');
 const calendar=require('../src/services/tradingCalendar').calendarInfo(nowIST().dateKey);add('calendar_verified',calendar.config?.verified&&!calendar.stale,'Verify official NSE equity holidays and special sessions through the launch date');
 let manifest,comparison;try{const p=require('../src/marketData/upstox').getProvider();manifest=await require('../src/marketData/universe').loadManifest(p);await require('../src/marketData/universe').assertPrepared(p,manifest);comparison=await p.read('launch-comparison');}catch(_){}
 add('sourced_universe',Boolean(manifest),'Prepare the universe from the admin panel; inspect missing source/coverage errors');
 add('comparison_recorded',manifest?.version===2?comparison?.universeKey===manifest.universeKey:Boolean(manifest),'Run the admin shadow comparison for the selected NSE universe and review differences');
 add('parity_approval_recorded',process.env.UPSTOX_SCREENING_APPROVED==='true','Compare screening definitions and explicitly approve differences');
 add('data_use_confirmation_recorded',process.env.UPSTOX_DATA_USE_CONFIRMED==='true','Confirm intended private multi-user data use with Upstox before recording confirmation');
 if(process.argv.includes('--live')){
  const db=require('../src/services/supabaseStore');if(await db.connect()){
   for(const table of ['worker_leases','app_users','app_sessions','personal_trades','signal_outcomes']){try{await db.request('get',table,{params:{select:'*',limit:0},retries:0});add('table_'+table,true);}catch(_){add('table_'+table,false,'Apply and verify the required migrations');}}
  }else add('database_reachable',false,'Verify database credentials/connectivity');
  if(process.env.UPSTOX_ACCESS_TOKEN){try{const p=require('../src/marketData/upstox').getProvider();await p.quotes(['RELIANCE','NIFTY']);for(const name of ['RELIANCE','NIFTY'])for(const interval of ['5','D'])await p.history(name,interval,interval==='5'?100:250);add('authenticated_market_samples',true);}catch(error){add('authenticated_market_samples',false,/^UPSTOX_[A-Z_]+$/.test(error.message)?error.message:'Market connectivity check failed');}}
 }else add('authenticated_host_and_database_checks',false,'Run npm run launch:check -- --live on the intended host after configuring credentials');
 const passed=checks.every(c=>c.passed);console.log(JSON.stringify({ready:passed,scope:'Configuration and sample-connectivity checks only; not production authorization, full scanner parity, permissions certification or performance qualification',checks},null,2));if(!passed)process.exitCode=1;
})().catch(()=>{console.error('Launch check failed; verify backend configuration');process.exitCode=1;});
