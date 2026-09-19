// SPDX-License-Identifier: SUL-1.0
import {renderShareSVG} from '/share.mjs';
import {THEMES,getTheme} from '/themes.mjs';
import {renderMascotSVG} from '/mascots.mjs';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const zh = new Map([...document.querySelectorAll('[data-i18n]')].map(el=>[el.dataset.i18n,el.innerHTML]));
const en = {
  themeLabel:'Paper & companions',runtimeView:'Execution',reviewView:'Review notes',legacy:'Early records',logoDownload:'Cat logo ↓',home:'Overview',records:'Records',browse:'Explore the collaboration records ↗',chartTurns:'Worker turns',chartTasks:'New responsibilities',revisionTitle:'Room to get it right',revisionNote:'Only explicit revisions count. Continuing is not rework.',local:'Local only',export:'Export a little proof',eyebrow:'A LITTLE WORK. ROOM TO BLOOM.',heading:'Good work comes back<span class="blue">.</span>',intro:'The work delegated, the turns taken, the results brought back.',period:'OBSERVATION WINDOW',week:'7 days',month:'30 days',all:'All time',responsibilities:'Responsibilities delegated',turns:'Worker execution turns',turnsNote:'Every turn has a real execution receipt.',tokens:'Observed external workload',scope:'ACP receipts only · Adapter-reported tokens are not Codex quota savings.',trail:'The collaboration trail',allRecords:'All records',attention:'Needs follow-up',execution:'Execution',revision:'Revision',acceptance:'Accepted',legendNote:'One line per responsibility. Continuing is not rework.',loading:'Opening the local records…',more:'A few more records ↓',rhythm:'A little help. A lot gets done.',routes:'Who carried the work',routesNote:'Share of execution turns. Timings describe each route’s tasks, not model speed rankings.',quality:'Where the work stands',qualityNote:'Receipts describe execution; explicit coordinator records describe review.',footer:'Delegate the work. Keep hold of the thread.',refresh:'Refresh',stop:'Close dashboard',replay:'RESPONSIBILITY / COLLABORATION REPLAY',shareTitle:'Take the good work home.',shareNote:'Preview contains ACP aggregates for the selected period. No work orders, route names, paths or internal IDs. List filters do not affect export.',banner:'Landscape · 1600 × 900',poster:'Portrait · 1080 × 1350',
};
let language = localStorage.getItem('dispatch-language') === 'en' ? 'en' : 'zh';
const t = (a,b) => language === 'zh' ? a : b;
const fragments = new URLSearchParams(location.hash.slice(1));
if(fragments.get('token')) sessionStorage.setItem('dispatch-token',fragments.get('token'));
const token = sessionStorage.getItem('dispatch-token') ?? '';
let period = fragments.get('since') ?? 'all';
history.replaceState(null,'',location.pathname);
let theme=getTheme(localStorage.getItem('dispatch-theme'));
let shareTheme=theme;
let view='home', measure='turns', outcome='runtime';
let snapshot, filter='all', search='', limit=12, inflight=false, version='', stopped=false;
let shareData, format='banner', shareLanguage=language, previewUrl, detailTrigger;
const number = value => typeof value==='number' ? value.toLocaleString(language==='zh'?'zh-CN':'en-US') : '—';
const compact = value => value === null || value === undefined ? '—' : value>=1e6 ? `${(value/1e6).toFixed(2)}M` : value>=1e3 ? `${(value/1e3).toFixed(1)}K` : number(value);
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(language==='zh'?'zh-CN':'en-GB',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const shortDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0,10) : '—';
const elapsed = value => value === null || value === undefined ? '—' : value < 60000 ? `${Math.round(value/1000)}s` : `${(value/60000).toFixed(1)}m`;
const kinds = {
  responsibility_started:['派出工单','Dispatched'],responsibility_closed:['关闭责任','Responsibility closed'],turn_started:['开始执行','Execution started'],turn_completed:['运行完成','Runtime completed'],turn_failed:['运行失败','Runtime failed'],turn_cancelled:['运行取消','Runtime cancelled'],
  dispatch:['派出工单','Dispatched'],dispatched:['派出工单','Dispatched'],continued:['同一 worker 续做','Same worker continued'],
  runtime_started:['开始执行','Execution started'],runtime_completed:['运行完成','Runtime completed'],runtime_failed:['运行失败','Runtime failed'],runtime_cancelled:['运行取消','Runtime cancelled'],
  completed:['运行完成','Runtime completed'],failed:['运行失败','Runtime failed'],cancelled:['运行取消','Runtime cancelled'],
  submitted:['提交验收','Submitted for review'],revision_requested:['提出修正','Revision requested'],accepted:['主机已接受','Coordinator accepted'],taken_over:['主机接管','Coordinator takeover'],note:['补充记录','Annotation'],closed:['关闭责任','Responsibility closed'],
};
const reasons = {requirement_missed:['遗漏要求','Requirement missed'],validation_failed:['验证失败','Validation failed'],scope_changed:['范围变化','Scope changed'],constraint_added:['补充约束','Constraint added'],environment_blocked:['环境阻塞','Environment blocked'],uncertain:['原因不确定','Uncertain reason']};
const labelKind = kind => kinds[kind] ? t(...kinds[kind]) : kind;
const labelCategory = kind => ({investigation:t('调查','Investigation'),implementation:t('实施','Implementation'),review:t('审查','Review'),other:t('其他','Other')})[kind] ?? t('未分类','Unclassified');
const reviewLabels = {
  accepted:['主机已接受','Accepted'],taken_over:['主机已接管','Taken over'],awaiting_review:['待验收','Awaiting review'],changes_requested:['需要修正','Changes requested'],needs_attention:['执行需处理','Execution needs attention'],not_requested:['无需复查记录','No review requested'],no_receipt:['等待回执','Awaiting receipt'],legacy_untracked:['早期记录','Early record'],
};
const pendingStates=['awaiting_review','changes_requested','needs_attention'];
const attention = session => pendingStates.includes(session.review_state);
const reviewLabel = session => reviewLabels[session.review_state] ? t(...reviewLabels[session.review_state]) : t('早期记录','Early record');


async function api(path,options={}) {
  const response = await fetch(path,{...options,headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
  if(!response.ok) throw new Error(response.status === 401 ? t('请使用 CLI 输出的私人链接打开面板。','Open the private URL printed by the CLI.') : t('本地记录读取失败；请检查 CLI，或点击刷新重试。','Unable to read local records. Check the CLI, or refresh to retry.'));
  return response.json();
}
function notice(message) {$('#notice').textContent=message;$('#notice').hidden=!message;}
function coverageNotice() {
  const n=snapshot.warnings.reduce((sum,w)=>sum+w.count,0);
  notice(n?t(`有 ${n} 条数据提示。部分用量或记录不可用；未知值不计作零。`,`There are ${n} data notices. Some usage or records are unavailable; unknown values are not zero.`):'');
}
function setLanguage() {
  document.documentElement.lang = language==='zh'?'zh-CN':'en';
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.innerHTML=language==='en' ? en[el.dataset.i18n] ?? zh.get(el.dataset.i18n) : zh.get(el.dataset.i18n);});
  $('#language').textContent=language==='zh'?'EN':'中';
  $('#search').placeholder=t('查找责任或 route','Find a responsibility or route');
  $('#search').setAttribute('aria-label',$('#search').placeholder);
  renderThemePickers();
  if(snapshot) {render();coverageNotice();}
}
function renderThemePickers() {
  const focused=document.activeElement;
  const focusAttribute=focused?.hasAttribute('data-theme')?'data-theme':focused?.hasAttribute('data-share-theme')?'data-share-theme':null;
  const focusId=focusAttribute?focused.getAttribute(focusAttribute):null;
  for(const [selector,selected,attribute] of [['#theme-picker',theme,'data-theme'],['#share-theme-picker',shareTheme,'data-share-theme']]) {
    const host=$(selector);
    host.innerHTML=THEMES.map(item=>`<button class="theme-choice${item.id===selected.id?' selected':''}" ${attribute}="${item.id}" aria-pressed="${item.id===selected.id}"><span class="theme-colours" aria-hidden="true"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderMascotSVG(item.mascot))}"></span><span>${escape(item.name[language])}${item.id==='sage'?'<small>Canon</small>':''}</span></button>`).join('');
    [...host.children].forEach((button,i)=>button.style.setProperty('--choice-paper',THEMES[i].colors.primarySoft));
  }
  if(focusAttribute)document.querySelector(`button[${focusAttribute}="${focusId}"]`)?.focus({preventScroll:true});
}
function applyTheme() {
  document.documentElement.dataset.theme=theme.id;
  for(const [key,value] of Object.entries(theme.colors))document.documentElement.style.setProperty('--'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),value);
  $('.metric-cat').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(renderMascotSVG(theme.mascot));
  renderThemePickers();
  if(snapshot)render();
}
const titleFor = s => s.title || t(`${date(s.created_at)} 的协作`, `Collaboration · ${date(s.created_at)}`);
function statusFor(s) {
  if(['not_requested','legacy_untracked'].includes(s.review_state)) return [({completed:t('运行完成','Runtime completed'),failed:t('运行失败','Runtime failed'),cancelled:t('已取消','Cancelled')})[s.runtime_status] ?? t('暂无终态回执','No terminal receipt'),''];
  return [reviewLabel(s),s.review_state==='accepted'?'accepted':attention(s)?'attention':''];
}
function miniTrack(s) {
  // Follow observed chronology. Compress a long middle, never rearrange review
  // and correction events into an invented happy path.
  const labels = {
    dispatch:['','派出','Out'],dispatched:['','派出','Out'],responsibility_started:['','派出','Out'],
    turn_completed:['terminal','回执','Run'],runtime_completed:['terminal','回执','Run'],
    turn_failed:['revision','失败','Fail'],runtime_failed:['revision','失败','Fail'],
    turn_cancelled:['revision','取消','Stop'],runtime_cancelled:['revision','取消','Stop'],
    submitted:['','送验','Review'],revision_requested:['revision','修正','Fix'],
    accepted:['accepted','接受','OK'],taken_over:['taken_over','接管','Main'],
  };
  let points=(s.timeline??[]).filter(e=>labels[e.kind]).map(e=>({
    class:labels[e.kind][0],label:t(labels[e.kind][1],labels[e.kind][2]),title:`${labelKind(e.kind)} · ${date(e.at)}`,
  }));
  if(points.length>7) points=[...points.slice(0,3),{class:'',label:`+${points.length-6}`,title:t('展开查看完整轨迹','Open for the full trail')},...points.slice(-3)];
  if(!points.length) return `<span class="small muted">${t('暂无可展示事件','No recorded events')}</span>`;
  return `<span class="mini-track" aria-hidden="true">${points.map(p=>`<span class="mini-node ${p.class}" title="${escape(p.title)}"><i></i><span>${escape(p.label)}</span></span>`).join('')}</span>`;
}

function switchView(next) {
  view=next;
  $('#home-view').hidden=view!=='home';$('#records-view').hidden=view!=='records';
  document.querySelectorAll('[data-view]').forEach(el=>{const active=el.dataset.view===view;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
}
const chartPalette=()=>{const c=theme.colors;return [c.primary,c.secondary,c.tertiary,c.fourth,c.fifth,c.sixth];};
function renderHome() {
  renderActivity();
  const c=theme.colors,chartColors=chartPalette();
  const s=snapshot.summary,total=s.responsibilities;
  const review=s.review;
  const reviewKeys=['accepted','taken_over','awaiting_review','changes_requested'];
  const reviewed=reviewKeys.reduce((n,k)=>n+review[k],0);
  const parts=outcome==='runtime' ? [
    {label:t('运行完成','Runtime completed'),value:s.runtime_completed,color:c.primary},
    {label:t('运行失败','Runtime failed'),value:s.failed,color:c.secondary},
    {label:t('已取消','Cancelled'),value:s.cancelled,color:c.tertiary},
    {label:t('尚无终态回执','No terminal receipt'),value:Math.max(0,total-s.runtime_completed-s.failed-s.cancelled),color:c.track},
  ] : Object.entries(reviewLabels).filter(([key])=>reviewKeys.includes(key)).map(([key,label],i)=>({label:t(...label),value:review[key],color:chartColors[i]}));
  const chartTotal=outcome==='runtime'?total:reviewed;
  let offset=0;
  const arcs=parts.filter(p=>p.value).map(p=>{const length=p.value/Math.max(1,chartTotal)*100;const result=`<circle cx="120" cy="120" r="91" pathLength="100" fill="none" stroke="${p.color}" stroke-width="25" stroke-dasharray="${Math.max(0,length-0.8)} ${100-Math.max(0,length-0.8)}" stroke-dashoffset="${-offset}" transform="rotate(-90 120 120)"/>`;offset+=length;return result;}).join('');
  $('#acceptance-chart').innerHTML=`<div class="donut-wrap"><svg viewBox="0 0 240 240" role="img" aria-label="${escape(parts.map(p=>`${p.label}: ${p.value}`).join('; '))}"><circle cx="120" cy="120" r="91" fill="none" stroke="${c.track}" stroke-width="25"/>${arcs}</svg><div class="donut-label"><strong>${number(chartTotal)}</strong><span>${outcome==='runtime'?t('份责任','responsibilities'):t('份主动复盘','review notes')}</span></div></div><div class="donut-legend">${parts.filter(p=>p.value||['运行完成','Runtime completed','主机已接受','Accepted'].includes(p.label)).map(p=>`<div><span><i data-color="${p.color}"></i>${escape(p.label)}</span><strong>${number(p.value)}</strong></div>`).join('')}</div>${outcome==='review'?`<p class="chart-note">${escape(t('仅展示主动记录的复盘；普通完成不要求另作标记。','Only deliberate review notes appear here. Ordinary completion needs no extra annotation.'))}</p>`:''}`;
  document.querySelectorAll('[data-outcome]').forEach(el=>{const active=el.dataset.outcome===outcome;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  const pending=pendingStates.reduce((n,k)=>n+review[k],0);
  $('#review-inbox').hidden=pending===0;
  $('#review-inbox').innerHTML=`<div><strong>${t(`${number(pending)} 份协作需要留意`,`${number(pending)} responsibilities need a look`)}</strong><p>${t('执行异常或明确提出的复查；普通完成不会变成待办。','Execution issues or explicit review requests. Ordinary completion adds no to-do.')}</p></div><button class="text-button" data-review-filter="attention">${t('查看记录 ↗','View records ↗')}</button>`;
  $('#review-inbox').querySelector('[data-review-filter]').addEventListener('click',()=>{filter='attention';search='';$('#search').value='';limit=12;renderSessions();switchView('records');$('#records-view').scrollIntoView({behavior:'instant'});});
  const routes=snapshot.routes,totalTurns=routes.reduce((n,r)=>n+r.worker_turns,0);
  $('#route-count').textContent=t(`${routes.length} 条 route`,`${routes.length} routes`);
  $('#route-ribbon').innerHTML=routes.map((r,i)=>`<span data-width="${r.worker_turns/Math.max(1,totalTurns)*100}" data-color="${chartColors[i%chartColors.length]}"></span>`).join('');
  $('#routes').innerHTML=routes.length?routes.map((r,i)=>`<button class="route-item" data-route="${escape(r.name)}" aria-label="${escape(t(`查看 ${r.name} 的记录`,`View records for ${r.name}`))}"><span class="route-title"><i data-color="${chartColors[i%chartColors.length]}"></i><strong>${escape(r.name)}</strong><span>${number(r.worker_turns)} ${t('轮','turns')} <b>${Math.round(r.worker_turns/Math.max(1,totalTurns)*100)}%</b></span></span><span class="route-meta"><span>${number(r.responsibilities)} ${t('份责任','responsibilities')} · ${t('中位','median')} ${elapsed(r.median_elapsed_ms)}</span><span>${compact(r.external_tokens)} tokens · ${t('用量覆盖','coverage')} ${r.usage_sessions}/${r.usage_total_sessions??r.responsibilities} ↗</span></span></button>`).join(''):`<p class="chart-note">${t('还没有 route 留下回执。','No route receipts yet.')}</p>`;
  $('#quality').innerHTML=[[s.submissions,t('次送验','submissions')],[s.revisions,t('次明确修正','explicit revisions')],[snapshot.sessions.filter(x=>x.evidence_count>0).length,t('份含主机证据','with coordinator evidence')]].map(([n,l])=>`<div><strong>${number(n)}</strong><span>${l}</span></div>`).join('');
  const reasonCounts=new Map();
  for(const session of snapshot.sessions)for(const e of session.timeline??[])if(e.kind==='revision_requested')reasonCounts.set(e.reason??'uncertain',(reasonCounts.get(e.reason??'uncertain')??0)+1);
  const max=Math.max(1,...reasonCounts.values());
  $('#revision-reasons').innerHTML=reasonCounts.size?[...reasonCounts].sort((a,b)=>b[1]-a[1]).map(([r,n])=>`<div class="reason-row"><span>${escape(reasons[r]?t(...reasons[r]):t('未分类','Unclassified'))}</span><div><i data-width="${n/max*100}"></i></div><strong>${number(n)}</strong></div>`).join(''):`<div class="no-revisions"><span aria-hidden="true">✳</span><p>${t('这段时间，没有明确记录的修正。','No explicit revisions recorded in this period.')}</p></div>`;
  document.querySelectorAll('[data-width]').forEach(el=>el.style.width=`${el.dataset.width}%`);
  document.querySelectorAll('[data-color]').forEach(el=>el.style.backgroundColor=el.dataset.color);
}
function renderActivity() {
  const DAY=86400000, end=new Date(snapshot.period.until);end.setUTCHours(0,0,0,0);
  const points=new Map();
  if(measure==='turns')for(const a of snapshot.activity)points.set(a.date,a.turns);
  else for(const s of snapshot.sessions){const at=Date.parse(s.created_at);if(Number.isFinite(at)&&at<=Date.parse(snapshot.period.until)&&(!snapshot.period.since||at>=Date.parse(snapshot.period.since))){const key=new Date(at).toISOString().slice(0,10);points.set(key,(points.get(key)??0)+1);}}
  const first=snapshot.period.since?new Date(snapshot.period.since):points.size?new Date([...points.keys()].sort()[0]):new Date(end-6*DAY);first.setUTCHours(0,0,0,0);
  const dayCount=Math.max(1,Math.floor((end-first)/DAY)+1),maxBars=matchMedia('(max-width:760px)').matches?21:35,span=Math.max(1,Math.ceil(dayCount/maxBars));
  const bins=Array.from({length:Math.ceil(dayCount/span)},(_,i)=>({start:new Date(+first+i*span*DAY).toISOString().slice(0,10),end:new Date(Math.min(+end,+first+((i+1)*span-1)*DAY)).toISOString().slice(0,10),value:0}));
  for(const [day,n] of points){const i=Math.floor((Date.parse(day)-first)/(span*DAY));if(bins[i])bins[i].value+=n;}
  const total=bins.reduce((n,b)=>n+b.value,0),peak=Math.max(1,...bins.map(b=>b.value));
  $('#chart-total').textContent=number(total);$('#chart-unit').textContent=measure==='turns'?t('轮执行','worker turns'):t('份新责任','new responsibilities');
  const label=b=>`${b.start}${b.start===b.end?'':` → ${b.end}`} · ${number(b.value)} ${measure==='turns'?t('轮执行','turns'):t('份新责任','new responsibilities')}`;
  $('#chart-detail').textContent=t('轻触柱形，查看这一段的数字','Touch a bar to see the numbers');
  $('#activity').innerHTML=`<div class="plot-axis" aria-hidden="true"><span>${number(peak)}</span><span>${number(Math.round(peak/2))}</span><span>0</span></div><div class="plot-columns">${bins.map((b,i)=>`<button class="plot-bin${b.value===peak?' peak':''}" data-bin="${i}" aria-label="${escape(label(b))}"><i data-height="${b.value/peak*100}"></i><span class="bin-value">${number(b.value)}</span></button>`).join('')}</div>`;
  $('#activity').querySelectorAll('[data-height]').forEach(el=>{el.style.height=`${el.dataset.height}%`;if(Number(el.dataset.height)===0)el.classList.add('zero');});
  $('#activity').querySelectorAll('[data-bin]').forEach(el=>{const select=()=>{const b=bins[Number(el.dataset.bin)];$('#chart-detail').textContent=label(b);$('#activity').querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');};el.addEventListener('pointerenter',select);el.addEventListener('focus',select);el.addEventListener('click',select);});
  $('#activity-range').innerHTML=`<span>${bins[0].start}</span><span>${bins.at(-1).end}</span>`;
  $('#activity-note').textContent=t(`${span===1?'每柱 1 天':`每柱最多 ${span} 天`} · UTC · 覆盖整个所选窗口${total?'':' · 暂无这类回执'}`,`${span===1?'Daily bars':`Up to ${span} days per bar`} · UTC · Entire selected window${total?'':' · No recorded activity'}`);
  document.querySelectorAll('[data-measure]').forEach(el=>{const active=el.dataset.measure===measure;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
}
function renderSessions() {
  const visible = snapshot.sessions.filter(s=>(filter==='all'||filter==='attention'&&attention(s)||filter==='legacy'&&s.review_state==='legacy_untracked') && `${s.title} ${s.route} ${s.category} ${s.id}`.toLowerCase().includes(search.toLowerCase()));
  document.querySelectorAll('[data-filter]').forEach(el=>{const active=el.dataset.filter===filter;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  $('#session-count').textContent=t(`${visible.length} 份记录`,`${visible.length} records`);
  const focused = document.activeElement?.dataset.session;
  $('#sessions').innerHTML=visible.length ? visible.slice(0,limit).map((s,index)=>{
    const [status,state]=statusFor(s);
    const title=titleFor(s);
    const summary=t(`${s.turns} 轮执行，${s.submissions} 次送验，${s.revisions} 次修正`,`${s.turns} turns, ${s.submissions} submissions, ${s.revisions} revisions`);
    return `<button class="session-row" data-session="${escape(s.id)}" aria-label="${escape(`${title} · ${summary} · ${status}`)}"><span class="row-title"><span class="row-kicker">${String(index+1).padStart(2,'0')} / ${escape(labelCategory(s.category))}</span><strong>${escape(title)}</strong><span class="row-meta">${escape(s.route)} · ${escape(date(s.updated_at))}</span></span>${miniTrack(s)}<span class="row-state"><span class="status ${state}">${escape(status)}</span><span>${escape(s.evidence_count?t(`${s.evidence_count} 项主机证据`,`${s.evidence_count} coordinator checks`):t(`${s.turns} 轮回执`,`${s.turns} execution receipts`))}</span></span><span class="row-arrow" aria-hidden="true">↗</span></button>`;
  }).join('') : `<div class="empty"><svg viewBox="0 0 80 70" aria-hidden="true"><path d="M10 51h17c8 0 10-5 10-12V15l10 8 10-8v27c0 12 17 12 17 2 0-7-7-7-8-2M42 36h1m8 0h1"/></svg>${escape(snapshot.sessions.length?t('没有匹配的记录。试试另一个筛选。','No matching records. Try another filter.'):t('这里还很安静。照常派活，回执会自己长成轨迹。','Quiet for now. Delegate as usual; receipts will leave a trail.'))}</div>`;
  $('#more').hidden=visible.length<=limit;
  if(focused) [...document.querySelectorAll('[data-session]')].find(el=>el.dataset.session===focused)?.focus({preventScroll:true});
}
function render() {
  const s=snapshot.summary;
  document.querySelectorAll('[data-period]').forEach(el=>{const active=el.dataset.period===period;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  $('#period-caption').textContent=`${snapshot.period.since?shortDate(snapshot.period.since):t('所有已记录时间','All recorded time')} → ${shortDate(snapshot.period.until)} UTC`;
  $('#responsibilities').textContent=number(s.responsibilities);$('#worker-turns').textContent=number(s.worker_turns);$('#external-tokens').textContent=compact(s.external_tokens);
  $('#completed-note').textContent=t(`${number(s.runtime_completed)} 份运行完成`,`${number(s.runtime_completed)} runtime completed`);
  $('#usage-note').textContent=t(`tokens · 可归属用量 ${s.usage_sessions} / ${s.usage_total_sessions}`,`tokens · attributable usage ${s.usage_sessions} / ${s.usage_total_sessions}`);
  renderSessions();
  renderHome();
  $('#export').disabled=false;
  $('#observed').textContent=t(`最后观察 ${date(snapshot.observed_at)}`,`Observed ${date(snapshot.observed_at)}`);
}
async function refresh(force=false) {
  if(inflight||stopped)return;inflight=true;
  const requestedPeriod=period;
  try {
    const next=await api(`/api/snapshot?since=${encodeURIComponent(requestedPeriod)}`);
    if(requestedPeriod!==period)return;
    // Observation time advances without replacing the focused UI on unchanged data.
    const signature=JSON.stringify({...next,observed_at:null,period:{since:next.period.since?.slice(0,10),until:next.period.until?.slice(0,10)}});
    snapshot=next;
    if(force||signature!==version){version=signature;render();}
    $('#observed').textContent=t(`最后观察 ${date(next.observed_at)}`,`Observed ${date(next.observed_at)}`);
    coverageNotice();
  } catch(e){notice(e.message);} finally{inflight=false;if(requestedPeriod!==period)void refresh(true);}
}
function evidenceMarkup(evidence=[]) {
  return evidence.map(e=>`<div class="evidence">${escape(e.source==='coordinator'?t('主机记录','Coordinator evidence'):t('Worker 自述','Worker-reported'))} · ${escape(e.kind)}<br>${escape(e.summary)}</div>`).join('');
}
async function openDetail(id,trigger) {
  detailTrigger=trigger;$('#detail-content').innerHTML=`<h2 id="detail-title" class="detail-heading">${t('正在打开协作回放…','Opening the replay…')}</h2>`;$('#detail-dialog').showModal();
  try {
    const d=await api(`/api/detail/${encodeURIComponent(id)}`),s=d.session;
    const parent=s.parent?.thread_id||s.parent?.session_id;
    $('#detail-content').innerHTML=`<h2 id="detail-title" class="detail-heading">${escape(titleFor(s))}</h2><div class="detail-subtitle">${!s.title?escape(t('旧记录未保存标题，按发起时间显示。','No historical title was saved; showing the dispatch time.'))+'<br>':''}${escape(s.route)} · ${escape(labelCategory(s.category))} · ${escape(s.id)}<br>${escape(parent?t(`已关联主会话 ${parent}${s.parent.observed_at?' · 关联始于 '+date(s.parent.observed_at):''}`,`Linked parent ${parent}${s.parent.observed_at?' · observed since '+date(s.parent.observed_at):''}`):t('历史记录未关联主会话；独立展示。','No recorded parent link; shown independently.'))}</div><div class="detail-stats"><span><strong>${number(s.turns)}</strong>${t('轮执行','turns')}</span><span><strong>${number(s.submissions)}</strong>${t('次送验','submissions')}</span><span><strong>${number(s.revisions)}</strong>${t('次修正','revisions')}</span><span><strong>${number(s.evidence_count)}</strong>${t('项主机证据','coordinator checks')}</span></div><div class="detail-grid"><section><h3>${t('这份责任怎样走完','How this responsibility unfolded')}</h3><ol class="timeline">${s.timeline.map(e=>`<li class="${escape(e.kind)}"><strong>${escape(labelKind(e.kind))}</strong><time>${escape(date(e.at))}</time>${e.reason?`<span class="reason">${escape(reasons[e.reason]?t(...reasons[e.reason]):e.reason)}</span>`:''}${e.summary?`<p>${escape(e.summary)}</p>`:''}${evidenceMarkup(e.evidence)}</li>`).join('')}</ol></section><section><h3>${t('工单与对应回执','Work orders & receipts')}</h3><p class="privacy-note">${t('以下内容仅在本机查看，不进入分享图。测试自述保留其来源，不自动升级为主机验证。','These details remain local and never enter share exports. Worker-reported tests are not independent coordinator verification.')}</p>${d.turns.map((r,i)=>`<details class="receipt-detail"><summary>${t(`第 ${i+1} 轮`,`Turn ${i+1}`)} · ${escape(labelKind(r.runtime_status))}<br><span class="muted small">${escape(date(r.finished_at))} · ${t('清理','cleanup')}: ${escape(r.cleanup)}</span></summary><div class="receipt-body"><h4>${t('原始工单','WORK ORDER')}</h4><pre>${escape(r.work_order??t('旧记录未保存独立工单。','No separately saved work order in this legacy record.'))}</pre><h4>${t('WORKER 回执节选','WORKER OUTPUT EXCERPT')}</h4><pre>${escape(r.output_excerpt??t('没有回执节选。','No output excerpt.'))}</pre></div></details>`).join('')}${!d.turns.length?`<p class="aside-note">${t('尚无终态回执。','No terminal receipt yet.')}</p>`:''}</section></div>${d.events?.some(e=>e.supersedes)?`<details class="history-note"><summary>${t('查看原始标记与修订历史','View original annotations & corrections')}</summary>${d.events.map(e=>`<p>${escape(labelKind(e.kind))} · ${escape(date(e.at))}${e.supersedes?' · '+t('修订先前记录','Corrects an earlier annotation'):''}<br>${escape(e.summary)}</p>`).join('')}</details>`:''}`;
  }catch(e){$('#detail-content').innerHTML=`<h2 id="detail-title">${t('未能读取这份记录','Record unavailable')}</h2><p class="privacy-note">${escape(e.message)}</p>`;}
}
function updatePreview(){
  if(!shareData)return;
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(new Blob([renderShareSVG(shareData,format,shareLanguage,shareTheme.id)],{type:'image/svg+xml'}));
  $('#share-preview').src=previewUrl;
  document.querySelectorAll('[data-share-language]').forEach(el=>{const active=el.dataset.shareLanguage===shareLanguage;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll('[data-format]').forEach(el=>{const active=el.dataset.format===format;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
}
function download(blob,ext) {
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`worker-routing-${shareTheme.id}-${shareLanguage}-${format}-${shortDate(shareData.period.until)}.${ext}`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.querySelectorAll('[data-period]').forEach(el=>el.addEventListener('click',()=>{period=el.dataset.period;limit=12;void refresh(true);}));
document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('click',()=>{filter=el.dataset.filter;limit=12;document.querySelectorAll('[data-filter]').forEach(b=>{const active=b===el;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});if(snapshot)renderSessions();}));
$('#search').addEventListener('input',e=>{search=e.target.value;limit=12;if(snapshot)renderSessions();});
$('#more').addEventListener('click',()=>{limit+=12;renderSessions();});
$('#refresh').addEventListener('click',()=>void refresh(true));
$('#language').addEventListener('click',()=>{language=language==='zh'?'en':'zh';localStorage.setItem('dispatch-language',language);setLanguage();});
$('#sessions').addEventListener('click',e=>{const button=e.target.closest('[data-session]');if(button)void openDetail(button.dataset.session,button);});
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>switchView(el.dataset.view)));
document.querySelectorAll('[data-open-records]').forEach(el=>el.addEventListener('click',()=>switchView('records')));
document.querySelectorAll('[data-measure]').forEach(el=>el.addEventListener('click',()=>{measure=el.dataset.measure;if(snapshot)renderActivity();}));
$('#routes').addEventListener('click',e=>{const button=e.target.closest('[data-route]');if(!button)return;search=button.dataset.route;filter='all';$('#search').value=search;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter==='all'));renderSessions();switchView('records');});
document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>document.getElementById(el.dataset.close).close()));
$('#detail-dialog').addEventListener('close',()=>{if(detailTrigger?.isConnected)detailTrigger.focus();else $('[data-session]')?.focus();});
$('#share-dialog').addEventListener('close',()=>$('#export').focus());
$('#export').addEventListener('click',async()=>{
  $('#export').disabled=true;
  try{shareData=await api(`/api/share?since=${encodeURIComponent(period)}`);shareTheme=theme;renderThemePickers();updatePreview();$('#export-status').textContent='';$('#share-dialog').showModal();}catch(e){notice(e.message);}finally{$('#export').disabled=false;}
});
document.querySelectorAll('[data-format]').forEach(el=>el.addEventListener('click',()=>{format=el.dataset.format;updatePreview();}));
$('#download-svg').addEventListener('click',()=>{download(new Blob([renderShareSVG(shareData,format,shareLanguage,shareTheme.id)],{type:'image/svg+xml'}),'svg');$('#export-status').textContent=t('SVG 已生成，可以直接编辑或分享。','SVG ready to edit or share.');});
$('#download-png').addEventListener('click',async()=>{
  $('#download-png').disabled=true;
  document.querySelectorAll('[data-format],[data-share-language],[data-share-theme]').forEach(el=>el.disabled=true);
  try{
    await $('#share-preview').decode();
    const canvas=document.createElement('canvas');canvas.width=format==='poster'?1080:1600;canvas.height=format==='poster'?1350:900;
    canvas.getContext('2d').drawImage($('#share-preview'),0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('Export failed');download(blob,'png');$('#export-status').textContent=t('PNG 已生成。猫可以叼走了。','PNG ready. Take a little proof home.');
  }catch{$('#export-status').textContent=t('PNG 生成失败，仍可下载 SVG。','PNG export failed; SVG is still available.');}finally{$('#download-png').disabled=false;document.querySelectorAll('[data-format],[data-share-language],[data-share-theme]').forEach(el=>el.disabled=false);}
});
$('#stop').addEventListener('click',async()=>{try{await api('/api/close',{method:'POST'});stopped=true;notice(t('面板已关闭，本地预览进程已释放。重新运行 dashboard 命令可再打开。','Dashboard closed. Run the dashboard command to open it again.'));document.querySelectorAll('button,input').forEach(el=>el.disabled=true);}catch(e){notice(e.message);}});
matchMedia('(max-width:760px)').addEventListener('change',()=>{if(snapshot)renderHome();});
applyTheme();setLanguage();switchView(view);void refresh();
setInterval(()=>{if(document.visibilityState==='visible')void refresh();},10000);
setInterval(()=>{if(!stopped)void api('/api/ping').catch(()=>{});},20000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});

document.querySelectorAll('[data-outcome]').forEach(el=>el.addEventListener('click',()=>{outcome=el.dataset.outcome;if(snapshot)renderHome();}));

document.querySelectorAll('[data-share-language]').forEach(el=>el.addEventListener('click',()=>{shareLanguage=el.dataset.shareLanguage;updatePreview();}));

$('#theme-picker').addEventListener('click',e=>{const button=e.target.closest('button[data-theme]');if(!button)return;theme=getTheme(button.dataset.theme);localStorage.setItem('dispatch-theme',theme.id);applyTheme();});
$('#share-theme-picker').addEventListener('click',e=>{const button=e.target.closest('button[data-share-theme]');if(!button)return;shareTheme=getTheme(button.dataset.shareTheme);renderThemePickers();updatePreview();});
