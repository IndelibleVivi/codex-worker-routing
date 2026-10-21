// SPDX-License-Identifier: SUL-1.0
// This private view never feeds Dispatch's aggregate share projection.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function formatBytes(value){
  if(!Number.isFinite(value)||value<0)return '—';
  if(value===0)return '0 B';
  const unit=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)));
  return `${(value/1024**unit).toLocaleString('en',{maximumFractionDigits:unit?2:0})} ${['B','KiB','MiB','GiB','TiB'][unit]}`;
}
const names={
  scratch:['受管临时文件','Managed scratch'],managed_scratch:['受管临时文件','Managed scratch'],
  unowned_scratch:['待核查临时文件','Unverified scratch'],
  tmp:['旧临时文件','Legacy temporary files'],legacy_tmp:['旧临时文件','Legacy temporary files'],
  cache:['Runtime cache','Runtime cache'],sessions:['会话与历史','Sessions & history'],history:['会话与历史','Sessions & history'],
  logs:['Runtime 日志','Runtime logs'],state:['CWR 状态与回执','CWR state & receipts'],
  runtime:['其他 runtime 数据','Other runtime data'],other:['其他文件','Other files'],config:['配置','Configuration'],
  sessions_history:['会话与历史','Sessions & history'],logs_databases:['日志与数据库','Logs & databases'],
  runtime_state_config:['Runtime 状态与配置','Runtime state & config'],cwr_state_receipts:['CWR 状态与回执','CWR state & receipts'],
};
const categoryTone={sessions_history:0,sessions:0,history:0,logs_databases:1,logs:1,legacy_tmp:2,tmp:2,cache:3,managed_scratch:4,runtime_state_config:5,cwr_state_receipts:5,state:5};
const reasons={
  LEGACY_UNMANAGED:['旧目录没有 CWR 所有权记录，需要单独判断。','Legacy data has no CWR ownership record; inspect separately.'],
  BINDING_OPEN:['会话仍可续跑，保留其临时引用。','The session can still continue; retain its temporary references.'],
  SESSION_LOCK:['存在 session 执行锁。','A session execution lock is present.'],WORKSPACE_LOCK:['存在 workspace 执行锁。','A workspace execution lock is present.'],
  SESSION_OPEN:['会话仍可续跑，保留其临时引用。','The session can still continue; retain its temporary references.'],
  CLEANUP_UNCONFIRMED:['执行清理未确认，不能回收。','Execution cleanup is unconfirmed.'],
  ACTIVE_TURN:['本轮执行尚未结束。','A worker turn is still active.'],
  LOCK_PRESENT:['存在执行锁，保留数据。','An execution lock still protects this data.'],
  TOO_RECENT:['尚未达到保留天数。','The retention period has not elapsed.'],
};
const language=(lang,a,b)=>lang==='zh'?a:b;
const label=(key,lang)=>names[key]?.[lang==='zh'?0:1]??key;
const logical=row=>row?.logical_bytes??row?.bytes??0;
const allocated=row=>row?.allocated_bytes??null;
const candidate=row=>row?.eligible===true||['eligible','candidate'].includes(row?.eligibility);
const reasonText=(codes,lang)=>(codes??[]).map(value=>{const code=value.code??value;return reasons[code]?.[lang==='zh'?0:1]??String(code).replaceAll('_',' ').toLowerCase();}).join(' · ');

// The backend owns home/category attribution. Group its disjoint roots for
// reading; deriving another set of totals from targets would count bytes twice.
export function storageDisplay(data){
  function group(rows){
    const groups=new Map();
    for(const row of rows){if(row.status==='missing')continue;const key=row.category??row.id??row.key;const target=groups.get(key)??{category:key,bytes:0,allocated_bytes:0,entries:0,paths:[],incomplete:false};target.bytes+=logical(row);if(allocated(row)===null)target.allocated_bytes=null;else if(target.allocated_bytes!==null)target.allocated_bytes+=allocated(row);target.entries+=row.entries??row.files??row.file_count??0;target.paths.push(row.path);target.incomplete||=['incomplete','unsafe'].includes(row.status??row.scan);groups.set(key,target);}
    return [...groups.values()].sort((a,b)=>b.bytes-a.bytes);
  }
  const homes=(data.homes??[]).map(home=>{
    const rows=(home.categories??[]).map(row=>({...row,category:row.category==='scratch'?'legacy_tmp':row.category}));
    const categories=group(rows);
    return {...home,categories,totals:{bytes:categories.reduce((n,row)=>n+row.bytes,0)}};
  });
  return {...data,homes,targets:(data.targets??[]).filter(row=>row.kind==='scratch'||row.session_id||candidate(row)).sort((a,b)=>Number(candidate(b))-Number(candidate(a))||logical(b)-logical(a))};
}

export function renderStorageInventory(raw,{lang='zh',selected=new Set(),days=7,busy=false,extraHome=''}={}){
  const data=storageDisplay(raw);
  const T=(a,b)=>language(lang,a,b),targets=data.targets??[],homes=data.homes??[];
  const total=data.totals??{},sum=logical(total),eligible=targets.filter(candidate);
  const scanNotes=[...(data.warnings??[]),...(raw.targets??[]).filter(row=>row.eligibility==='incomplete').flatMap(row=>(row.reasons??[]).map(reason=>({code:reason.code??reason,path:row.path})))];
  const notes=[...new Map(scanNotes.map(note=>[`${note.code??note}\0${note.path??''}`,note])).values()];
  const selectedTargets=eligible.filter(row=>selected.has(row.id));
  const selectedBytes=selectedTargets.reduce((n,row)=>n+logical(row),0);
  const categories=new Map();
  for(const home of homes)for(const row of home.categories??[]){const key=row.category??row.id??row.key;categories.set(key,(categories.get(key)??0)+logical(row));}
  const categoryRows=[...categories].filter(([,bytes])=>bytes>0).sort((a,b)=>b[1]-a[1]);
  return `<div class="storage-head"><div><p class="eyebrow">STORAGE / A LOCAL INVENTORY</p><h2 id="storage-heading">${T('空间，花在了哪里','Where the space goes')}</h2></div><button class="secondary" data-storage-refresh ${busy?'disabled':''}>${busy?T('正在盘点…','Scanning…'):T('重新盘点','Refresh inventory')}</button></div>
    <p class="storage-scope">${T('当前磁盘快照 · 不随协作时间窗口筛选 · 查看明确指定的 worker homes 和 CWR state。','Current disk snapshot · Independent of the collaboration period · Explicit worker homes and CWR state only.')}</p>
    ${(raw.targets??[]).some(row=>row.eligibility==='incomplete')?`<p class="storage-warning" role="status">${T('扫描不完整：以下大小仅覆盖已观测条目，请查看扫描说明。','Incomplete scan: sizes cover observed entries only. See the scan notes.')}</p>`:''}
    <div class="storage-totals"><div><span>${T('文件逻辑大小','Logical file size')}</span><strong>${formatBytes(sum)}</strong></div><div><span>${T('估算磁盘占用','Estimated allocated space')}</span><strong>${formatBytes(allocated(total))}</strong></div><div><span>${T('达到条件的 scratch','Eligible scratch')}</span><strong>${formatBytes(eligible.reduce((n,row)=>n+logical(row),0))}</strong><small>${T(`${eligible.length} 项；保留至少 ${days} 天`,`${eligible.length} ${eligible.length===1?'item':'items'}; retained for at least ${days} days`)}</small></div></div>
    <div class="storage-distribution" role="img" aria-label="${esc(T('按类型的逻辑大小分布','Logical size by category'))}">${categoryRows.map(([key,bytes],i)=>`<span class="storage-segment tone-${categoryTone[key]??5}" data-storage-bytes="${bytes}" title="${esc(label(key,lang))}: ${formatBytes(bytes)}"></span>`).join('')}</div>
    <ul class="storage-legend">${categoryRows.map(([key,bytes],i)=>`<li><i class="tone-${categoryTone[key]??5}" aria-hidden="true"></i>${esc(label(key,lang))}<strong>${formatBytes(bytes)}</strong></li>`).join('')}</ul>
    <p class="storage-measure-note">${T('逻辑大小与实际释放空间可能不同，压缩、稀疏文件、硬链接和快照都会影响统计。扫描不读取聊天或日志正文，也不跟随符号链接。','Logical size can differ from space actually released because of compression, sparse files, hard links and snapshots. Scans do not read chat or log payloads or follow symlinks.')}</p>
    <div class="storage-homes">${homes.length?homes.map(home=>`<details class="storage-home" open><summary><span>${esc(home.route??home.name??T('退役 profile','Retired profile'))}<small>${esc(home.status??'')}</small></span><strong>${formatBytes(logical(home.totals??home))}</strong></summary><code class="storage-path">${esc(home.path)}</code><div class="storage-category-list">${(home.categories??[]).map(row=>`<div><span>${esc(label(row.category??row.id??row.key,lang))}${row.incomplete?` <small>${T('扫描不完整','Incomplete scan')}</small>`:''}</span><strong>${formatBytes(logical(row))}</strong><small>${esc(row.entries??0)} ${T('项','entries')}</small></div>`).join('')}</div>${home.warnings?.length?`<p class="storage-warning">${esc(home.warnings.map(w=>w.code??w).join(' · '))}</p>`:''}</details>`).join(''):`<p class="storage-empty">${T('还没有可盘点的 worker home。','No worker home is available to inspect.')}</p>`}</div>
    <details class="storage-extra" ${extraHome?'open':''}><summary>${T('另看一个已退役的 worker profile','Inspect a retired worker profile')}</summary><form id="storage-extra-form"><label for="storage-extra-home">${T('明确指定专用 profile 的绝对路径；只盘点，不恢复 route。','Specify the dedicated profile’s absolute path; inspection only, without restoring a route.')}</label><div><input id="storage-extra-home" value="${esc(extraHome)}" autocomplete="off" spellcheck="false" placeholder="/absolute/private/retired-worker-home" ${busy?'disabled':''}><button class="secondary" ${busy?'disabled':''}>${T('盘点此目录','Inspect this directory')}</button></div><small>${T('留空并提交可移除这项临时查看。目录不会保存为配置，也不会成为清理候选。','Submit an empty path to remove this temporary inspection. It is not saved as configuration or admitted as a cleanup candidate.')}</small></form></details>
    <section class="storage-cleanup" aria-labelledby="storage-cleanup-heading"><div class="storage-head"><div><p class="eyebrow">CLEANUP / EXPLICITLY SELECTED</p><h2 id="storage-cleanup-heading">${T('只处理有依据的候选','Clean only evidenced candidates')}</h2></div><label class="storage-age">${T('保留至少','Retain for at least')} <select id="storage-days" ${busy?'disabled':''}>${[7,14,30,90].map(n=>`<option value="${n}" ${n===days?'selected':''}>${n} ${T('天','days')}</option>`).join('')}</select></label></div>
    <p class="storage-scope">${T('仅新建的受管 scratch 可以进入清理计划。会话正常关闭、清理确认、无执行锁并达到保留天数后，仍需你主动选择。旧 tmp、cache、日志、数据库与会话历史只盘点。','Only newly managed scratch can enter a cleanup plan. A normally closed session, confirmed cleanup, no execution locks and elapsed retention are required; selection is still explicit. Legacy tmp, caches, logs, databases and session history are inspection only.')}</p>
    <div class="storage-targets">${targets.length?targets.map(row=>{const ok=candidate(row);return `<div class="storage-target-wrap"><label class="storage-target ${ok?'':'protected'}"><input type="checkbox" data-storage-target="${esc(row.id)}" ${ok?'':'disabled'} ${selected.has(row.id)&&ok?'checked':''} ${busy?'disabled':''}><span><strong>${esc(row.session_id??row.id)}</strong><code class="storage-path">${esc(row.path)}</code><small>${ok?T('符合本次保留条件；执行前再次核对。','Meets retention conditions; rechecked before applying.'):esc(reasonText(row.reasons,lang)||T('保留 · 缺少安全回收证据','Retained · Insufficient cleanup evidence'))}</small></span><span class="storage-target-size">${formatBytes(logical(row))}<small>${ok?T('可选择','Selectable'):T('保留','Retained')}</small></span></label>${row.session_id?`<button class="text-link storage-replay" id="storage-replay-${esc(row.id)}" data-task="${esc(row.session_id)}">${T('查看协作记录','View session replay')} ↗</button>`:''}</div>`;}).join(''):`<p class="storage-empty">${T('目前没有受管 scratch 候选。已有旧数据仍可在上方逐项查看。','No managed scratch candidates yet. Existing legacy data is listed above for inspection.')}</p>`}</div>
    <div class="storage-selection"><p id="storage-selection-note">${T(`已选 ${selectedTargets.length} 项 · ${formatBytes(selectedBytes)}`,`${selectedTargets.length} selected · ${formatBytes(selectedBytes)}`)}</p><button class="primary" id="storage-preview" ${!selectedTargets.length||busy?'disabled':''}>${T('预览清理计划','Preview cleanup plan')} ↗</button></div></section>
    ${notes.length?`<details class="storage-warnings"><summary>${T('扫描说明','Scan notes')} · ${notes.length}</summary><ul>${notes.map(w=>`<li>${esc(w.code??w)}${w.path?` <code>${esc(w.path)}</code>`:''}</li>`).join('')}</ul></details>`:''}
    <p class="storage-observed">${T('盘点时间','Observed')} <time>${esc(data.observed_at??'—')}</time> · ${T('估算值，不代表已释放','Estimates, not reclaimed space')}</p>`;
}

export function createStorageView({api,getLanguage,showDialog,isStopped=()=>false,isActive=()=>true}){
  const host=document.querySelector('#storage-content'),dialog=document.querySelector('#storage-dialog'),planHost=document.querySelector('#storage-plan-content');
  let data=null,selected=new Set(),days=7,busy=false,plan=null,receipt=null,error='',sequence=0,opened=false,extraHome='',extraDraft='',applyUnconfirmed=false;
  const T=(a,b)=>language(getLanguage(),a,b);
  const errorMessage=e=>`${T('本次操作未完成。数据可能已变化，请重新盘点并生成计划。','The operation did not complete. Data may have changed; refresh and create a new plan.')}${e.code?` (${e.code})`:''}`;
  function render(){
    const focus=document.activeElement?.id;
    const details=new Set([...host.querySelectorAll('.storage-home[open]')].map(el=>el.querySelector('.storage-path')?.textContent));
    const hadData=Boolean(host.querySelector('.storage-homes'));
    host.innerHTML=(data?renderStorageInventory(data,{lang:getLanguage(),selected,days,busy,extraHome:extraDraft}):`<div class="storage-head"><h2 id="storage-heading">${T('空间，花在了哪里','Where the space goes')}</h2><button class="secondary" data-storage-refresh ${busy?'disabled':''}>${T('重新盘点','Refresh inventory')}</button></div><p class="storage-empty" role="status">${busy?T('正在读取文件元数据…','Reading file metadata…'):T('打开存储视图，查看本机占用。','Open Storage to inspect local disk usage.')}</p>`)+
      (error?`<p class="storage-warning" role="alert">${esc(error)}</p>`:'')+
      (receipt?`<div class="storage-result" role="status">${T('清理结果','Cleanup result')}: ${esc(receipt.status)} · ${T('计划','Plan')} <code>${esc(receipt.plan_id)}</code> · ${T('已确认删除的逻辑大小','Confirmed deleted logical size')} ${formatBytes(receipt.deleted_logical_bytes??receipt.deleted_bytes??receipt.totals?.deleted_bytes??0)}${['partial','applying'].includes(receipt.status)||(receipt.targets??[]).some(row=>row.deletion_uncertain)?`<p>${T('存在未确认部分，以上数字不是完整删除量。请按计划 ID 核查本机回执与锁状态。','Some results are unconfirmed; the count above is not the full deletion amount. Inspect the local receipt and locks using the plan ID.')}</p>`:''}<ul>${(receipt.targets??[]).map(row=>`<li><code>${esc(row.path)}</code> · ${esc(row.status)}${row.reason?` · ${esc(row.reason)}`:''}</li>`).join('')}</ul></div>`:'');
    for(const el of host.querySelectorAll('[data-storage-bytes]'))el.style.flexGrow=el.dataset.storageBytes;
    if(hadData)for(const el of host.querySelectorAll('.storage-home'))el.open=details.has(el.querySelector('.storage-path')?.textContent);
    if(focus)document.getElementById(focus)?.focus({preventScroll:true});
  }
  async function refresh(){
    if(busy||isStopped())return;
    const current=++sequence;busy=true;error='';selected.clear();plan=null;render();
    try{const query=new URLSearchParams({olderThanDays:String(days)});if(extraHome)query.set('extraHome',extraHome);const next=await api(`/api/storage?${query}`);if(current===sequence&&!isStopped())data=next;}
    catch(e){if(current===sequence&&!isStopped())error=errorMessage(e);}
    finally{if(current===sequence){busy=false;render();}}
  }
  function renderPlan(){
    if(!plan)return;
    applyUnconfirmed=false;
    document.querySelector('#storage-plan-title').textContent=T('核对这一份清理','Review this cleanup');
    planHost.innerHTML=`<p class="storage-plan-note">${T('预览已保存，尚未删除任何文件。执行将永久删除下列受管临时文件；会话历史、日志和回执保留。需要的产物请先保存到工作区。','The preview is saved; no files have been deleted. Applying permanently deletes the managed scratch below. Session history, logs and receipts are retained. Save any needed artifacts to your workspace first.')}</p><div class="storage-plan-total"><strong>${formatBytes(logical(plan.totals))}</strong><span>${plan.targets.length} ${T('个选定目录','selected directories')}</span></div><ul class="storage-plan-list">${plan.targets.map(row=>`<li><code>${esc(row.path)}</code><strong>${formatBytes(logical(row))}</strong></li>`).join('')}</ul><p class="storage-plan-id">${T('计划','Plan')} <code>${esc(plan.plan_id)}</code></p><p id="storage-plan-error" class="storage-warning" role="alert" hidden></p><label class="storage-confirm"><input id="storage-confirm" type="checkbox">${T('我确认永久清理以上临时文件，无法撤回。','I confirm permanent cleanup of the temporary files listed above. This cannot be undone.')}</label><div class="storage-plan-actions"><button class="secondary" data-close="storage-dialog">${T('先保留','Keep for now')}</button><button class="primary" id="storage-apply" disabled>${T('确认清理','Apply cleanup')}</button></div>`;
  }
  host.addEventListener('change',e=>{
    if(e.target.id==='storage-days'){days=Number(e.target.value);void refresh();return;}
    const id=e.target.dataset.storageTarget;
    if(id){e.target.checked?selected.add(id):selected.delete(id);const checked=[...(data?.targets??[])].filter(row=>candidate(row)&&selected.has(row.id));document.querySelector('#storage-selection-note').textContent=T(`已选 ${checked.length} 项 · ${formatBytes(checked.reduce((n,row)=>n+logical(row),0))}`,`${checked.length} selected · ${formatBytes(checked.reduce((n,row)=>n+logical(row),0))}`);document.querySelector('#storage-preview').disabled=!checked.length;}
  });
  host.addEventListener('input',e=>{if(e.target.id==='storage-extra-home')extraDraft=e.target.value;});
  host.addEventListener('submit',e=>{if(e.target.id!=='storage-extra-form')return;e.preventDefault();if(busy)return;extraHome=extraDraft.trim();void refresh();});
  host.addEventListener('click',async e=>{
    if(e.target.closest('[data-storage-refresh]')){void refresh();return;}
    if(!e.target.closest('#storage-preview')||busy||!selected.size||isStopped())return;
    busy=true;error='';render();
    try{const next=await api('/api/storage/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetIds:[...selected],olderThanMs:days*86400000})});if(!isStopped()&&isActive()){plan=next;renderPlan();showDialog();}}
    catch(e){error=errorMessage(e);}finally{busy=false;render();}
  });
  planHost.addEventListener('change',e=>{if(e.target.id==='storage-confirm')document.querySelector('#storage-apply').disabled=!e.target.checked||busy;});
  planHost.addEventListener('click',async e=>{
    if(!e.target.closest('#storage-apply')||!plan||busy||isStopped()||!document.querySelector('#storage-confirm').checked)return;
    busy=true;for(const el of dialog.querySelectorAll('button,input'))el.disabled=true;
    try{receipt=await api('/api/storage/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:plan.plan_id,confirm:plan.plan_id})});dialog.close();busy=false;await refresh();}
    catch(e){applyUnconfirmed=true;const note=document.querySelector('#storage-plan-error');note.textContent=T(`清理结果未确认。请先按计划 ${plan.plan_id} 核查本机操作回执与锁状态，不要直接重复执行。`,`Cleanup is unconfirmed. Inspect the local operation receipt and locks for plan ${plan.plan_id} before attempting any further operation.`)+(e.code?` (${e.code})`:'');note.hidden=false;document.querySelector('#storage-confirm').checked=false;}
    finally{busy=false;for(const el of dialog.querySelectorAll('button,input'))el.disabled=false;const confirm=document.querySelector('#storage-confirm');if(confirm)confirm.disabled=applyUnconfirmed;const apply=document.querySelector('#storage-apply');if(apply)apply.disabled=true;render();}
  });
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.addEventListener('close',()=>{plan=null;document.querySelector('#storage-preview')?.focus({preventScroll:true});});
  return {render,refresh,open:async()=>{if(!opened){opened=true;await refresh();}}};
}
