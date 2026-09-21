// SPDX-License-Identifier: SUL-1.0
import {productMark} from './mark.mjs';
import {mascotMark} from './mascots.mjs';
import {getTheme} from './themes.mjs';
import {dayKey,resolveTimeZone} from './time.mjs';
import {normalizeShareStyle} from './share-style.mjs';
import {ornamentMarkup} from './ornaments.mjs';
const exportZone = value => { try { return resolveTimeZone(value); } catch { return 'UTC'; } };
// This is the sole receipt-data public export boundary. Never spread a private projection.
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
export function renderShareCaption(data,language='en',style) {
  const d=publicData(data),zh=language==='zh';
  const start=d.period.since?dayKey(d.period.since,d.time_zone):(zh?'全部已记录时间':'All recorded time');
  const end=d.period.until?dayKey(d.period.until,d.time_zone):(zh?'未知':'Unknown');
  const missing=Math.max(0,d.usage_total_sessions-d.usage_sessions);
  const unknown=Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled);
  const stats=zh
    ? `${start} — ${end}（${d.time_zone}）：${d.responsibilities} 份委派任务，${d.worker_turns} 轮执行。运行完成 ${d.runtime_completed}，失败 ${d.failed}，取消 ${d.cancelled}，无终态 ${unknown}。已观测外部用量 ${compact(d.external_tokens)} tokens；${d.usage_total_sessions} 份有回执的任务中，${d.usage_sessions} 份用量可归属，${missing} 份不可归属。仅 ACP；未知用量不计零，不代表验收结论或节省的 Codex 额度。`
    : `${start} — ${end} (${d.time_zone}): ${d.responsibilities} delegated tasks, ${d.worker_turns} worker turns. Completed ${d.runtime_completed}, failed ${d.failed}, cancelled ${d.cancelled}, no terminal receipt ${unknown}. Observed external usage: ${compact(d.external_tokens)} tokens; attributable for ${d.usage_sessions} of ${d.usage_total_sessions} receipted tasks, unavailable for ${missing}. ACP only. Unknown usage is not zero; not acceptance or Codex quota savings.`;
  if(style===undefined)return stats;
  const authored=normalizeShareStyle(style,language);
  return [authored.slogan,authored.sharedBy?`${zh?'分享者':'Shared by'} ${authored.sharedBy}`:'',stats].filter(Boolean).join('\n\n');
}
const xml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const SANS=`Avenir Next,Arial,PingFang SC,Microsoft YaHei,Noto Sans CJK SC,sans-serif`;
const SERIF=`Georgia,'Times New Roman','Songti SC','Noto Serif CJK SC',serif`;
const MONO=`ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace`;
// Deterministic line fitting keeps standalone SVG and PNG typography identical.
// Break at spaces where possible, and allow CJK or long words to wrap by glyph.
const glyphWidth=char=>/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u30ff\uff01-\uff60]|\p{Extended_Pictographic}/u.test(char)?1:/\s/u.test(char)?.32:/[ilI.,!':;]/.test(char)?.3:/[MW@%]/.test(char)?1.05:/[A-Z]/.test(char)?.78:.59;
function wrapSlogan(value,width,size){
 const lines=[];
 for(const paragraph of value.split(/\n+/).filter(Boolean)){
  let line=[];
  for(const char of paragraph){
   line.push(char);
   if(line.reduce((n,c)=>n+glyphWidth(c)*size,0)>width&&line.length>1&&!/[，。！？、；：）》」』】…,.!?;:)]/.test(char)){
    const space=line.lastIndexOf(' '),split=space>0?space:line.length-1;
    lines.push(line.slice(0,split).join('').trim());line=line.slice(space>0?split+1:split);
   }
  }
  if(line.length)lines.push(line.join('').trim());
 }
 return lines;
}
// The primary task count and companion share one woven surface. Secondary
// metrics stay on paper; material never controls quantitative geometry.
export function renderShareSVG(data,format='banner',lang='en',themeId='sage',style={}) {
 const d=publicData(data),theme=getTheme(themeId),c=theme.colors;
 const authored=normalizeShareStyle(style,lang);
 const zh=lang==='zh',portrait=format==='poster',w=portrait?1080:1600,h=portrait?1350:900;
 const T=(a,b)=>zh?a:b;
 const text=(x,y,value,size=24,fill=c.ink,weight=400,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
 const mono=(x,y,value,size=18,extra='')=>text(x,y,value,size,c.textSecondary,400,`font-family="${MONO}" ${extra}`);
 const serif=(x,y,value,size=54,extra='')=>text(x,y,value,size,c.ink,400,`font-family="${SERIF}" ${extra}`);
 const headline=()=>{
  if(!authored.slogan)return '';
  const width=portrait?600:940,height=portrait?150:84,center=portrait?302:262;
  let size=portrait?(zh?64:62):(zh?58:54),lines;
  const value=!portrait||authored.slogan.split(/\n+/).length>4?authored.slogan.replace(/\n/g,' '):authored.slogan;
  do{lines=wrapSlogan(value,width,size);if(lines.length*size*1.08<=height&&lines.every(line=>Array.from(line).reduce((n,c)=>n+glyphWidth(c)*size,0)<=width))break;size-=2;}while(size>24);
  const first=center-(lines.length-1)*size*1.08/2+size*.24;
  return `<g id="share-slogan">${lines.map((line,i)=>serif(78,first+i*size*1.08,line,size,!zh&&i>0?'font-style="italic"':'')).join('')}</g>`;
 };
 const rule=(y,x=80,end=w-80)=>`<path d="M${x} ${y}H${end}" fill="none" stroke="${c.primaryLine}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="1 6"/>`;
 const defs=`<defs>
  <filter id="paper-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="2" seed="11" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .4 0"/></filter>
  <filter id="cloth-lift" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="${c.ink}" flood-opacity=".12"/></filter>
  <pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 1.5H6" stroke="${c.ink}" stroke-opacity=".025"/><path d="M1.5 0V6" stroke="${c.ink}" stroke-opacity=".025"/></pattern>
  <pattern id="unknown-track" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="${c.track}"/><path d="M-1 1L1-1M0 5L5 0M4 6L6 4" stroke="${c.textSecondary}" stroke-width="1"/></pattern>
  <linearGradient id="cloth-light" x2=".8" y2="1"><stop stop-color="${c.surface}" stop-opacity=".35"/><stop offset="1" stop-color="${c.primary}" stop-opacity=".08"/></linearGradient>
  <clipPath id="paper-clip"><rect x="24" y="22" width="${w-48}" height="${h-51}" rx="24"/></clipPath>
 </defs>`;
 const grain=(x,y,rw,rh)=>`<rect x="${x}" y="${y}" width="${rw}" height="${rh}" filter="url(#paper-grain)" opacity=".045"/>`;
 const cloth=(x,y,cw,ch)=>`<g transform="rotate(-1.2 ${x+cw/2} ${y+ch/2})" filter="url(#cloth-lift)">
  <rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="22" fill="${c.primarySoft}"/>
  <rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="22" fill="url(#cloth-light)"/>
  <rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="22" fill="url(#weave)"/>
  <rect x="${x+14}" y="${y+14}" width="${cw-28}" height="${ch-28}" rx="13" fill="none" stroke="${c.primaryLine}" stroke-width="1.7" stroke-dasharray="6 5"/>
 </g>`;
 const companion=(x,y,r)=>`<g id="share-companion" transform="translate(${x} ${y}) rotate(-7)">
  <g transform="rotate(18)"><rect x="${r*.2}" y="${-r-25}" width="${r*.7}" height="${r*.7}" rx="5" fill="${c.secondarySoft}"/><path d="M${r*.25} ${-r-12}h${r*.6}" stroke="${c.secondaryLine}" stroke-width="1.5" stroke-dasharray="5 4"/></g>
  <circle cy="5" r="${r}" fill="${c.shadow}"/>
  <circle r="${r}" fill="${c.surface}" filter="url(#cloth-lift)"/>
  <circle r="${r-7}" fill="${c.primarySoft}"/>
  <circle r="${r-7}" fill="url(#cloth-light)"/>
  <circle r="${r-7}" fill="url(#weave)"/>
  <circle r="${r-20}" fill="none" stroke="${c.primaryLine}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="5 5"/>
  <g transform="translate(${-r*.79} ${-r*.84}) scale(${r*1.58/128})">${mascotMark(theme.mascot)}</g>
 </g>`;
 const countText=compact(d.responsibilities);
 const numberFont=authored.numberStyle==='book'?SERIF:authored.numberStyle==='mono'?MONO:SANS;
 const primarySize=(maxSize,width)=>Math.min(maxSize,width/(countText.length*.65));
 const primaryWidth=size=>Array.from(countText).reduce((sum,char)=>sum+glyphWidth(char)*size,0);
 const primary=(x,y,maxSize,width)=>text(x,y,countText,primarySize(maxSize,width),c.ink,authored.numberStyle==='book'?400:500,`id="share-task-count" font-family="${numberFont}" letter-spacing="-5"`);
 const since=d.period.since?dayKey(d.period.since,d.time_zone).replaceAll('-','.') : T('全部已记录时间','ALL RECORDED TIME');
 const until=d.period.until?dayKey(d.period.until,d.time_zone).replaceAll('-','.') : T('未知','UNKNOWN');
 const outcome=[
  [d.runtime_completed,'completed',T('运行完成','Completed'),c.chartInk],
  [d.failed,'failed',T('执行中断','Failed'),'#566e7d'],
  [d.cancelled,'cancelled',T('已取消','Cancelled'),'#8a9097'],
  [Math.max(0,d.responsibilities-d.runtime_completed-d.failed-d.cancelled),'unknown',T('无终态','No terminal'),'url(#unknown-track)'],
 ];
 // Adjacent exact fractions: neither decoration nor a minimum width may enlarge
 // a rare outcome. The numeric legend remains readable for subpixel segments.
 const track=(x,y,width)=>{
  let cumulative=0;
  const segments=outcome.filter(([n])=>n>0).map(([n,key,,fill])=>{
   const start=x+width*cumulative/d.responsibilities;cumulative+=n;
   return `<rect data-outcome="${key}" x="${start}" y="${y}" width="${x+width*cumulative/d.responsibilities-start}" height="6" fill="${fill}"/>`;
  }).join('');
  return `<g id="share-outcome-track"><rect x="${x}" y="${y}" width="${width}" height="6" fill="${c.track}"/>${segments}</g>`;
 };
 const outcomes=(x,y,step)=>outcome.map(([n,key,label],i)=>`<g data-outcome-label="${key}">${text(x+i*step,y,n,32,c.ink,500)}${text(x+i*step,y+34,label,20,c.textSecondary)}</g>`).join('');
 const coverage=(x,y)=>`<g id="share-usage-coverage">${text(x,y,T(`${d.usage_sessions} / ${d.usage_total_sessions} 份有回执任务`,`${d.usage_sessions} / ${d.usage_total_sessions} receipted tasks`),19,c.textSecondary)}${text(x,y+26,T('用量可归属','with attributable usage'),19,c.textSecondary)}</g>`;
 const footer=(y)=>text(80,y,T('仅 ACP · 未知用量不计零。','ACP only · Unknown usage is not zero.'),18,c.textSecondary)
  +text(80,y+27,T('不代表验收结论或 Codex 额度节省。','Not acceptance or Codex quota savings.'),18,c.textSecondary);
 const repo=(y)=>mono(w-80,y,'github.com/IndelibleVivi/codex-worker-routing',portrait?20:18,'id="share-repository" text-anchor="end"');
 const credit=(y)=>authored.sharedBy?text(portrait?80:w-80,y,`${T('分享者','Shared by')}  ${authored.sharedBy}`,18,c.ink,500,`id="share-credit"${portrait?'':' text-anchor="end"'}`):'';
 const mark=`<g transform="translate(77 63) scale(.98)">${productMark().replace(/^<svg[^>]*>/,'').replace('</svg>','')}</g>`;
 let out=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" lang="${zh?'zh-CN':'en'}" aria-labelledby="share-svg-title share-svg-desc"><title id="share-svg-title">${xml(T('Worker Routing · ACP 协作记录','Worker Routing · ACP collaboration'))}</title><desc id="share-svg-desc">${xml(renderShareCaption(d,lang,authored))}</desc>${defs}
 <rect width="${w}" height="${h}" fill="${c.mat}"/>
 <rect x="24" y="29" width="${w-48}" height="${h-51}" rx="24" fill="${c.shadow}" opacity=".65"/>
 <rect x="24" y="22" width="${w-48}" height="${h-51}" rx="24" fill="${c.surface}"/>
 <g clip-path="url(#paper-clip)">${grain(24,22,w-48,h-51)}</g>
 <rect x="46" y="44" width="${w-92}" height="${h-95}" rx="15" fill="none" stroke="${c.primaryLine}" stroke-width="1.5" stroke-dasharray="7 6" opacity=".7"/>
 <g font-family="${SANS}">${mark}${text(141,97,'worker routing',30,c.ink,550)}${mono(w-80,96,'DISPATCH / FIELD NOTES',18,'text-anchor="end" letter-spacing="2"')}${rule(140)}
 ${mono(80,191,`${since} — ${until}  /  ${d.time_zone}`,portrait?18:20)}`;
 out+=headline();
 if(authored.ornament!=='none')out+=`<g id="share-ornament" aria-hidden="true" transform="${portrait?'translate(720 213) scale(.85)':'translate(1135 171) scale(1.15)'}">${ornamentMarkup(authored.ornament,theme.id)}</g>`;
 if(portrait){
  out+=cloth(80,416,905,307);
  out+=mono(110,465,T('这个窗口里的协作','THIS COLLABORATION WINDOW'),16,'letter-spacing="1.8"');
  out+=primary(108,616,authored.numberStyle==='mono'?154:168,525)+text(112,682,T('份委派任务','delegated tasks'),27,c.ink,500);
  out+=companion(836,494,155);
  out+=text(952,682,T('同一份责任续做，只计一份任务。','One responsibility, counted once.'),18,c.textSecondary,400,'text-anchor="end"');
  out+=text(80,831,compact(d.worker_turns),54,c.ink,500)+text(80,869,T('轮执行','worker turns'),23,c.textSecondary);
  out+=`<path d="M520 787V939" stroke="${c.secondaryLine}" stroke-dasharray="3 5"/>`;
  out+=text(560,831,compact(d.external_tokens),54,c.ink,500)+text(560,869,T('外部已知 tokens','observed tokens'),23,c.textSecondary);
  out+=`<g id="share-turn-note">${text(80,910,T('新派与续做，逐轮计入。','New runs and continuations.'),19,c.textSecondary)}${text(80,936,T('由运行回执自动记录。','Automatically counted from receipts.'),19,c.textSecondary)}</g>`;
  out+=coverage(560,910);
  out+=track(80,992,w-160)+outcomes(80,1056,235);
  out+=rule(1130)+footer(1174)+credit(1233)+repo(authored.sharedBy?1274:1260);
 }else{
  out+=cloth(80,320,880,292);
  out+=mono(110,358,T('这个窗口里的协作','THIS COLLABORATION WINDOW'),16,'letter-spacing="1.8"');
  const bannerCountMax=authored.numberStyle==='mono'?150:164;
  const bannerCountWidth=zh?338:278;
  const bannerCountSize=primarySize(bannerCountMax,bannerCountWidth);
  const bannerLabelX=108+primaryWidth(bannerCountSize)+26;
  out+=primary(108,526,bannerCountMax,bannerCountWidth);
  out+=`<g id="share-task-label">${text(bannerLabelX,468,T('份委派任务','delegated tasks'),27,c.ink,500)}${text(bannerLabelX,509,T('同一份责任续做，','One responsibility,'),18,c.textSecondary)}${text(bannerLabelX,535,T('只计一份任务。','counted once.'),18,c.textSecondary)}</g>`;
  out+=companion(853,435,155);
  out+=text(1110,373,compact(d.worker_turns),54,c.ink,500)+text(1111,412,T('轮执行','worker turns'),23,c.textSecondary);
  out+=rule(446,1110,1518);
  out+=text(1110,522,compact(d.external_tokens),54,c.ink,500)+text(1111,560,T('外部已知 tokens','observed tokens'),23,c.textSecondary);
  out+=coverage(1111,596);
  out+=track(80,650,w-160)+outcomes(80,703,360);
  out+=footer(796)+credit(796)+repo(823);
 }
 return out+'</g></svg>';
}
