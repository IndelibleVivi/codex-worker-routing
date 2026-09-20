// SPDX-License-Identifier: SUL-1.0
import {productMark} from './mark.mjs';
import {mascotMark} from './mascots.mjs';
import {getTheme} from './themes.mjs';
import {dayKey,resolveTimeZone} from './time.mjs';
const exportZone = value => { try { return resolveTimeZone(value); } catch { return 'UTC'; } };
// This is the sole public export boundary. Never spread a private projection.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function projectShare(snapshot) {
  const s = snapshot.summary;
  return {
    schema: 'cwr.dispatch.share/1', scope: 'ACP receipts',
    period: { since: iso(snapshot.period.since), until: iso(snapshot.period.until) },
    time_zone: exportZone(snapshot.time_zone),
    responsibilities: count(s.responsibilities), worker_turns: count(s.worker_turns),
    runtime_completed: count(s.runtime_completed), failed: count(s.failed), cancelled: count(s.cancelled),
    review: Object.fromEntries(['accepted','taken_over','awaiting_review','changes_requested','needs_attention','not_requested','no_receipt','legacy_untracked'].map(key => [key,count(s.review?.[key])])),
    submissions: count(s.submissions),
    revisions: count(s.revisions), accepted: count(s.accepted), taken_over: count(s.taken_over),
    external_tokens: Number.isSafeInteger(s.external_tokens) && s.external_tokens >= 0 ? s.external_tokens : null,
    usage_sessions: count(s.usage_sessions), usage_total_sessions: count(s.usage_total_sessions),
    warning_count: (snapshot.warnings ?? []).reduce((n, w) => n + count(w.count), 0),
  };
}


const compact = value => value === null ? '—' : value >= 1e6 ? `${(value/1e6).toFixed(2)}M` : value >= 1e3 ? `${(value/1e3).toFixed(1)}K` : String(value);
function publicData(data) { return projectShare({summary:data,period:data.period,time_zone:data.time_zone,warnings:[{count:data.warning_count}]}); }
export function renderShareCaption(data,language='en') {
  const d=publicData(data),zh=language==='zh';
  const start=d.period.since?dayKey(d.period.since,d.time_zone):(zh?'全部已记录时间':'All recorded time');
  const end=d.period.until?dayKey(d.period.until,d.time_zone):(zh?'未知':'Unknown');
  const missing=Math.max(0,d.usage_total_sessions-d.usage_sessions);
  const unknown=Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled);
  return zh
    ? `${start} — ${end}（${d.time_zone}）：${d.responsibilities} 份委派任务，${d.worker_turns} 轮执行。运行完成 ${d.runtime_completed}，失败 ${d.failed}，取消 ${d.cancelled}，无终态 ${unknown}。已观测外部用量 ${compact(d.external_tokens)} tokens；${d.usage_total_sessions} 份有回执的任务中，${d.usage_sessions} 份用量可归属，${missing} 份不可归属。仅 ACP；未知用量不计零，不代表验收结论或节省的 Codex 额度。`
    : `${start} — ${end} (${d.time_zone}): ${d.responsibilities} delegated tasks, ${d.worker_turns} worker turns. Completed ${d.runtime_completed}, failed ${d.failed}, cancelled ${d.cancelled}, no terminal receipt ${unknown}. Observed external usage: ${compact(d.external_tokens)} tokens; attributable for ${d.usage_sessions} of ${d.usage_total_sessions} receipted tasks, unavailable for ${missing}. ACP only. Unknown usage is not zero; not acceptance or Codex quota savings.`;
}
const xml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function renderShareSVG(data,format='banner',lang='en',themeId='sage'){
 const d=publicData(data),theme=getTheme(themeId),c=theme.colors;
 const p={ink:c.ink,text:c.textSecondary,line:c.line,soft:c.primarySoft,seam:c.primaryLine,mat:c.mat,surface:c.surface,mascot:theme.mascot};
 const zh=lang==='zh',portrait=format==='poster',w=portrait?1080:1600,h=portrait?1350:900;
 const T=(a,b)=>zh?a:b;
 const text=(x,y,value,size=30,fill=p.ink,weight=400,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
 const line=(y,x=80,end=w-80)=>`<path d="M${x} ${y}H${end}" fill="none" stroke="${p.line}" stroke-width="1.5"/>`;
 const seal=(cx,cy,r)=>`<g transform="rotate(5 ${cx} ${cy})"><circle cx="${cx}" cy="${cy+4}" r="${r}" fill="${p.line}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.soft}"/><circle cx="${cx}" cy="${cy}" r="${r-12}" fill="none" stroke="${p.seam}" stroke-width="2" stroke-dasharray="2.5 7"/><g transform="translate(${cx-r*.75} ${cy-r*.82}) scale(${r*1.5/128})">${mascotMark(p.mascot)}</g></g>`;
 const mark=`<g transform="translate(77 63) scale(.98)">${productMark().replace(/^<svg[^>]*>/,'').replace('</svg>','')}</g>`;
 let out=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" lang="${zh?'zh-CN':'en'}" aria-labelledby="share-svg-title share-svg-desc"><title id="share-svg-title">${xml(T('Worker Routing · ACP 协作记录','Worker Routing · ACP collaboration'))}</title><desc id="share-svg-desc">${xml(renderShareCaption(d,lang))}</desc><rect width="${w}" height="${h}" fill="${p.mat}"/><rect x="24" y="28" width="${w-48}" height="${h-51}" rx="23" fill="${p.line}"/><rect x="24" y="22" width="${w-48}" height="${h-51}" rx="23" fill="${p.surface}"/><g font-family="Avenir Next,Arial,PingFang SC,Microsoft YaHei,Noto Sans CJK SC,sans-serif">`;
 out+=mark+text(141,97,'worker routing',30,p.ink,550)+text(w-80,97,'DISPATCH / FIELD NOTES',19,p.text,400,'text-anchor="end" letter-spacing="2"')+line(142);
 const since=d.period.since?dayKey(d.period.since,d.time_zone).replaceAll('-','.') : T('全部已记录时间','ALL RECORDED TIME'),until=d.period.until?dayKey(d.period.until,d.time_zone).replaceAll('-','.') : T('未知','UNKNOWN');
 const dates=`${since} — ${until}`;
 if(portrait){
  out+=text(80,200,dates,28,p.text)+text(80,243,d.time_zone,24,p.text);
  if(zh)out+=text(77,340,'工作有去有回。',62,p.ink,500,'letter-spacing="-1.5"');
  else out+=text(77,314,'Good work,',56,p.ink,500)+text(77,381,'in good company.',56,p.ink,500);
  out+=text(70,587,compact(d.responsibilities),194,p.ink,500,'letter-spacing="-9"')+text(83,643,T('份委派任务','DELEGATED TASKS'),34,p.ink,450,zh?'':'letter-spacing="1"');
  out+=seal(820,526,148);
  out+=line(697);
  out+=text(80,782,compact(d.worker_turns),64,p.ink,500)+text(81,828,T('轮执行','worker turns'),30,p.text);
  out+=text(550,782,compact(d.external_tokens),64,p.ink,500)+text(552,828,T('外部已知 tokens','observed tokens'),30,p.text);
  out+=`<path d="M511 738v92" stroke="${p.line}" stroke-width="1.5"/>`;
  out+=text(81,895,T(`用量可归属 ${d.usage_sessions} / ${d.usage_total_sessions} 份有回执任务`,`Usage coverage: ${d.usage_sessions} / ${d.usage_total_sessions} receipted tasks`),zh?30:28,p.text);
  out+=text(81,938,T('未知部分，不计作零。','Unknown usage is not zero.'),29,p.text);
  out+=line(979);
  const states=[[d.runtime_completed,T('运行完成','Completed')],[d.failed,T('执行中断','Failed')],[d.cancelled,T('已取消','Cancelled')],[Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled),T('无终态','No terminal')]];
  states.forEach(([n,l],i)=>{const x=81+i*233;out+=text(x,1053,String(n),49,p.ink,500)+text(x,1097,l,28,p.text)});
  out+=line(1140);
  out+=text(81,1190,T('仅 ACP · 非验收结论或额度节省','ACP only · Not acceptance or quota savings'),zh?28:26,p.text);
  out+=text(81,1235,T('同一份责任续做，只计一份任务。','Continued work stays one task.'),26,p.text,500);
  out+=text(81,1291,'github.com/IndelibleVivi/codex-worker-routing',25,p.ink);
 }else{
  out+=text(80,194,`${dates}   /   ${d.time_zone}`,27,p.text);
  out+=text(76,288,T('有帮手，工作有去有回。','Good work, in good company.'),58,p.ink,500,'letter-spacing="-1"');
  out+=text(69,491,compact(d.responsibilities),191,p.ink,500,'letter-spacing="-9"')+text(423,445,T('份委派任务','DELEGATED TASKS'),34,p.ink,500)+text(425,491,T('同一份责任，只计一次。','One responsibility, counted once.'),27,p.text);
  out+=seal(1321,458,169);
  out+=line(543,80,1020);
  out+=text(80,622,compact(d.worker_turns),62,p.ink,500)+text(81,665,T('轮执行','worker turns'),29,p.text);
  out+=text(416,622,compact(d.external_tokens),62,p.ink,500)+text(418,665,T('外部已知 tokens','observed tokens'),29,p.text);
  out+=text(773,610,T(`用量可归属 ${d.usage_sessions}/${d.usage_total_sessions}`,`Usage coverage ${d.usage_sessions}/${d.usage_total_sessions}`),27,p.text)+text(774,651,T('分母：有回执的任务','of tasks with receipts'),25,p.text);
  out+=text(80,727,T(`运行完成 ${d.runtime_completed}   ·   执行中断 ${d.failed}   ·   取消 ${d.cancelled}   ·   无终态 ${Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled)}`,`Completed ${d.runtime_completed}   ·   Failed ${d.failed}   ·   Cancelled ${d.cancelled}   ·   Unknown ${Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled)}`),29,p.ink,450);
  out+=line(758);
  out+=text(80,802,T('仅 ACP · 未知用量不计零 · 非验收结论或额度节省','ACP only · Unknown usage is not zero · Not acceptance or quota savings'),26,p.text);
  out+=text(80,850,'github.com/IndelibleVivi/codex-worker-routing',24,p.ink);
 }
 return out+'</g></svg>';
}
