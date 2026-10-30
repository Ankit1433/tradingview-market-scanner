(async function(){
 const $=id=>document.getElementById(id),status=$('account-status');
 async function api(path,body){const response=await fetch('/api/account'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(response.status===401&&!$('login-form')){location.href='/login';throw new Error('Login required');}if(!response.ok)throw new Error(data.error||'Request failed');return data;}
 const protect=fn=>async event=>{
  event?.preventDefault();const source=event?.currentTarget;
  if(source?.dataset.busy==='true')return;
  const buttons=source?.tagName==='FORM'?[...source.querySelectorAll('button')]:source?.tagName==='BUTTON'?[source]:[];
  const disabled=buttons.map(button=>button.disabled);
  if(source){source.dataset.busy='true';source.setAttribute('aria-busy','true');}
  buttons.forEach(button=>button.disabled=true);status.textContent='';
  try{await fn(event);}catch(error){status.textContent=error.message;}
  finally{buttons.forEach((button,i)=>button.disabled=disabled[i]);if(source){source.dataset.busy='false';source.setAttribute('aria-busy','false');}}
 };
 if($('login-form')){$('login-form').addEventListener('submit',protect(async event=>{const body=Object.fromEntries(new FormData(event.currentTarget));const action=event.submitter?.value||'login';await api('/'+action,body);if(action==='login')location.href='/personal';else status.textContent='Account created. You can now sign in.';}));$('login-form').dataset.ready='true';return;}
 function values(form){return Object.fromEntries([...new FormData(form)].filter(([,v])=>v!=='').map(([k,v])=>[k,k==='eventKey'?v:Number(v)]));}
 let me;try{me=await api('/me');}catch(error){status.textContent=error.message;return;}
 for(const [key,value]of Object.entries(me.settings))if($('settings-form').elements[key])$('settings-form').elements[key].value=value;
 if($('upstox-panel')){
  $('upstox-panel').hidden=me.role!=='admin';
  if(me.role==='admin'){
   const renderSetup=data=>{$('upstox-status').textContent=`${data.state} · ${data.phase||'not started'}${data.code?' · '+data.code:''}${data.progress?.examined!==undefined?' · Examined '+data.progress.examined+'/'+data.progress.total+' · Included '+data.progress.included+' · Excluded '+data.progress.excluded+(data.progress.currentSymbol?' · Checking '+data.progress.currentSymbol:'')+' · Updated '+data.progress.updatedAt:''}${data.wait?' · Waiting: '+data.wait.reason+' until '+data.wait.until:''}. Scanning stays controlled by Render settings.`;$('upstox-report').textContent=JSON.stringify(data,null,2);};
   $('upstox-report-form').addEventListener('submit',protect(async event=>{
    const form=event.currentTarget,file=form.elements.reportFile.files[0],message=$('upstox-import-status');message.textContent='Importing NSE report…';
    try{
     if(!file||file.size>12*1024*1024)throw Error('Choose an original NSE PR ZIP no larger than 12 MB');
     const response=await fetch('/api/account/admin/upstox/report',{method:'POST',headers:{'content-type':'application/zip','x-report-date':form.elements.reportDate.value,'x-nse-source-attested':String(form.elements.attested.checked)},body:file});
     let data;try{data=await response.json();}catch(_){throw Error('Report import failed');}if(!response.ok)throw Error(data.error||'Report import failed');
     message.textContent='NSE report imported. Click Prepare universe and compare.';status.textContent=message.textContent;$('upstox-status').textContent=message.textContent;
    }catch(error){message.textContent=error.message;throw error;}
   }));
   $('prepare-upstox').addEventListener('click',protect(async()=>{await api('/admin/upstox/prepare',{});renderSetup(await api('/admin/upstox'));}));
   $('refresh-upstox').addEventListener('click',protect(async()=>renderSetup(await api('/admin/upstox'))));
  }
 }
 $('invite-panel').hidden=me.role!=='admin';$('telegram-status').textContent=me.telegramLinked?'Private Telegram linked.':'No private chat linked.';
 const params=new URLSearchParams(location.search);for(const key of ['eventKey','entry','stop','target'])if(params.has(key))$('trade-form').elements[key].value=params.get(key);
 async function refresh(){const data=await api('/journal');const s=data.stats;$('personal-stats').textContent=`${s.closed} closed · ${s.open} open · ${s.totalR.toFixed(2)}R total · ${s.meanR===null?'—':s.meanR.toFixed(2)}R average. ${s.warning||''}`;const root=$('personal-trades');root.replaceChildren();if(!data.trades.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='No personal paper trades yet. Choose a signal from the journal.';tr.append(td);root.append(tr);}
 for(const trade of data.trades){const tr=document.createElement('tr');for(const value of [trade.symbol,`${trade.entry} / ${trade.stop} / ${trade.target}`,trade.quantity,trade.closed_at?'Closed':'Open']){const td=document.createElement('td');td.textContent=value;tr.append(td);}const td=document.createElement('td');if(!trade.closed_at){const form=document.createElement('form'),input=document.createElement('input'),button=document.createElement('button');input.type='number';input.min='.01';input.step='.01';input.required=true;input.setAttribute('aria-label',`Paper exit price for ${trade.symbol}`);button.textContent='Close paper trade';form.append(input,button);form.addEventListener('submit',protect(async()=>{await api('/journal/'+trade.id+'/close',{exit:Number(input.value)});await refresh();}));td.append(form);}else td.textContent=trade.exit;tr.append(td);root.append(tr);}}
 $('settings-form').addEventListener('submit',protect(async event=>{await api('/settings',values(event.currentTarget));status.textContent='Sizing settings saved.';}));
 $('trade-form').addEventListener('submit',protect(async event=>{await api('/journal',values(event.currentTarget));status.textContent='Paper trade saved. No order placed.';await refresh();}));
 $('logout').addEventListener('click',protect(async()=>{await api('/logout',{});location.href='/login';}));
 $('create-invite').addEventListener('click',protect(async()=>{const data=await api('/invites',{});$('invite-code').textContent=data.code;}));
 $('link-telegram').addEventListener('click',protect(async()=>{const data=await api('/telegram/link',{});$('telegram-link').href=data.url;$('telegram-link').hidden=false;}));
 $('unlink-telegram').addEventListener('click',protect(async()=>{await api('/telegram/unlink',{});$('telegram-status').textContent='Telegram unlinked.';$('telegram-link').hidden=true;}));
 await protect(refresh)();
})();
