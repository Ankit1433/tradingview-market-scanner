const {test,expect}=require('@playwright/test');
const {spawn}=require('child_process');
const fs=require('fs'),os=require('os'),path=require('path');
let child,base,dir;
test.beforeAll(async()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'ankquant-e2e-url-'));const file=path.join(dir,'url');child=spawn(process.execPath,[path.join(__dirname,'fixture-server.js')],{env:{...process.env,PLAYWRIGHT_URL_FILE:file},stdio:'ignore'});for(let i=0;i<150;i++){if(fs.existsSync(file)){base=fs.readFileSync(file,'utf8');return;}if(child.exitCode!==null)throw Error('Fixture server exited');await new Promise(r=>setTimeout(r,100));}throw Error('Fixture startup timed out');});
test.afterAll(async()=>{if(child&&child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await ended;clearTimeout(timer);}fs.rmSync(dir,{recursive:true,force:true});});
test.beforeEach(async({context})=>{await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());});
async function login(page,email='alice@example.test'){await page.goto(base+'/login');await expect(page.locator('#login-form')).toHaveAttribute('data-ready','true');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill('Fixture-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page).toHaveURL(base+'/personal');await expect(page.locator('#personal-stats')).toContainText('0 closed');}
test('login → save/reload alert settings → signal journal → logout',async({page,context})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/alerts');await expect(page).toHaveURL(base+'/login');
 await login(page);const cookies=await context.cookies();const session=cookies.find(c=>c.name==='aq_session');expect(session.httpOnly).toBe(true);expect(session.sameSite).toBe('Strict');
 await page.goto(base+'/alerts');await expect(page.locator('#preferences-fields')).toBeEnabled();await page.getByLabel('Maximum signal alerts per day').fill('7');await page.getByLabel('Watchlist-only alerts').check();await page.getByLabel('Account watchlist, separated by commas').fill('TEST, INFY');await page.getByRole('button',{name:'Save preferences'}).click();await expect(page.locator('#page-status')).toContainText('Preferences saved');await page.reload();await expect(page.getByLabel('Maximum signal alerts per day')).toHaveValue('7');await expect(page.getByLabel('Watchlist-only alerts')).toBeChecked();await expect(page.getByLabel('Account watchlist, separated by commas')).toHaveValue('TEST, INFY');
 await page.goto(base+'/journal');await expect(page.locator('#signal-rows')).toContainText('TEST');await page.locator('#signal-rows tr').first().click();await expect(page.locator('#take-signal')).toBeVisible();await page.locator('#take-signal').click();await expect(page.getByLabel('Signal event key')).toHaveValue('a'.repeat(64));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Sign out'}).click();await expect(page).toHaveURL(base+'/login');await page.goto(base+'/alerts');await expect(page).toHaveURL(base+'/login');expect(errors).toEqual([]);
});
test('preferences remain owner-isolated; errors preserve editable form',async({page})=>{
 await login(page,'bob@example.test');await page.goto(base+'/alerts');await expect(page.getByLabel('Maximum signal alerts per day')).toHaveValue('20');
 await page.route('**/api/account/preferences',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture persistence unavailable'})}):route.continue());
 await page.getByLabel('Maximum signal alerts per day').fill('3');await page.getByRole('button',{name:'Save preferences'}).click();await expect(page.locator('#page-status')).toContainText('Fixture persistence unavailable');await expect(page.getByRole('button',{name:'Save preferences'})).toBeEnabled();await page.reload();await expect(page.getByLabel('Maximum signal alerts per day')).toHaveValue('20');
});

test('admin can prepare Upstox data, inspect exclusions and import an NSE report',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let starts=0,imports=0;const ready={state:'review-required',phase:'complete',metadata:{coverage:{expected:2,included:1,excluded:[{symbol:'SPLITTEST'}]}},comparison:{approved:false,excluded:[{symbol:'SPLITTEST',audit:{affected:[{type:'split',date:'2026-10-29'}]}}]}};
 await page.route('**/api/account/admin/upstox',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ready)}));
 await page.route('**/api/account/admin/upstox/prepare',route=>{starts++;return route.fulfill({status:202,contentType:'application/json',body:'{"started":true}'});});
 await page.route('**/api/account/admin/upstox/report',route=>{imports++;expect(route.request().headers()['content-type']).toBe('application/zip');expect(route.request().headers()['x-report-date']).toBe('2026-10-29');return route.fulfill({status:200,contentType:'application/json',body:'{"rows":1}'});});
 await login(page,'admin@example.test');await expect(page.locator('#upstox-panel')).toBeVisible();
 await page.getByRole('button',{name:'Prepare universe and compare'}).click();await expect(page.locator('#upstox-status')).toContainText('review-required');await expect(page.locator('#upstox-report')).toContainText('SPLITTEST');expect(starts).toBe(1);await expect(page.locator('#setup-included')).toHaveText('1');await expect(page.locator('#setup-excluded')).toHaveText('1');
 await page.route('**/api/account/admin/upstox',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'running',phase:'metadata',progress:{examined:1800,total:2357,included:1750,excluded:50,currentSymbol:'TEST',updatedAt:'2026-10-30T09:30:00.000Z'},wait:{reason:'request-budget',until:'2026-10-30T09:41:00.000Z'}})}));
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(page.locator('#upstox-status')).toContainText('Examined 1800/2357');await expect(page.locator('#upstox-status')).toContainText('Excluded 50');await expect(page.locator('#setup-examined')).toHaveText('1800');await expect(page.locator('#setup-excluded')).toHaveText('50');await expect(page.locator('#upstox-status')).toContainText('request-budget');
 await page.getByText('If NSE blocks the server download',{exact:true}).click();const form=page.locator('#upstox-report-form');await form.locator('[name=reportDate]').fill('2026-10-29');await form.locator('[name=reportFile]').setInputFiles({name:'PR291026.zip',mimeType:'application/zip',buffer:Buffer.from('fixture; parser tested separately')});await form.locator('[name=attested]').check();await page.getByRole('button',{name:'Import NSE report',exact:true}).click();await expect(page.locator('#account-status')).toContainText('NSE report imported');expect(imports).toBe(1);await expect(page.locator('#upstox-import-status')).toContainText('NSE report imported');await page.route('**/api/account/admin/upstox/report',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'UPSTOX_METADATA_VALUE_OR_UNIT_INVALID'})}));await page.getByRole('button',{name:'Import NSE report',exact:true}).click();await expect(page.locator('#upstox-import-status')).toContainText('UPSTOX_METADATA_VALUE_OR_UNIT_INVALID');expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('redesigned workspace navigation and motion preference work on every page',async({page})=>{
 await login(page);
 const motion=page.locator('.motion-toggle');
 await motion.click();
 await expect(page.locator('body')).toHaveClass(/motion-paused/);
 await page.reload();
 await expect(page.locator('.motion-toggle')).toHaveAttribute('aria-pressed','true');
 for(const route of ['/app','/journal','/symbol','/alerts','/stats','/personal']) {
  await page.goto(base+route);
  await expect(page.locator('#main-content')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await expect(page.locator('.motion-toggle')).toBeDisabled();
 await expect(page.locator('body')).toHaveClass(/motion-paused/);
 await expect(page.locator('#upstox-panel')).toBeHidden();
});


test('API reference has a responsive branded shell and CDN fallback',async({page})=>{
 await login(page);
 await page.goto(base+'/api/docs');
 await expect(page.getByRole('heading',{name:'Explore the AnkQuant API'})).toBeVisible();
 await expect(page.locator('#docs-load-status')).toContainText('OpenAPI JSON');
 await expect(page.getByRole('link',{name:'OpenAPI JSON',exact:true})).toHaveAttribute('href','/api/docs.json');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const schema=await page.request.get(base+'/api/docs.json');expect(schema.ok()).toBe(true);expect((await schema.json()).openapi).toBe('3.0.3');
});
