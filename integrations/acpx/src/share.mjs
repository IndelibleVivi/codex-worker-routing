// SPDX-License-Identifier: SUL-1.0
import { catMark } from './brand.mjs';
import { mascotMark } from './mascots.mjs';
import { getTheme } from './themes.mjs';
// This is the sole public export boundary. Never spread a private projection.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function projectShare(snapshot) {
  const s = snapshot.summary;
  return {
    schema: 'cwr.dispatch.share/1', scope: 'ACP receipts',
    period: { since: iso(snapshot.period.since), until: iso(snapshot.period.until) },
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

const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const compact = value => value === null ? '—' : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value);
export function renderShareSVG(data, format = 'banner', language = 'en', themeId = 'sage') {
  const d = projectShare({summary:data,period:data.period,warnings:[{count:data.warning_count}]});
  const zh=language==='zh', t=(a,b)=>zh?a:b, poster=format==='poster';
  const w=poster?1080:1600, h=poster?1350:900;
  const theme=getTheme(themeId), c=theme.colors;
  const {ink,muted}=c, green=c.primary;
  const text=(x,y,value,size=24,color=ink,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`;
  const bold='font-weight="600" letter-spacing="-3"', label='font-weight="500" letter-spacing="1.5"';
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" lang="${zh?'zh-CN':'en'}" aria-label="${t('Worker Routing 派工台，ACP 汇总统计','Worker Routing Dispatch, aggregate ACP statistics')}">
    <rect width="${w}" height="${h}" fill="${c.mat}"/>
    <rect x="25" y="28" width="${w-50}" height="${h-50}" rx="22" fill="${c.shadow}"/>
    <rect x="24" y="22" width="${w-48}" height="${h-50}" rx="22" fill="${c.surface}" stroke="${c.line}"/>
    <g font-family="Avenir Next, Arial, PingFang SC, Microsoft YaHei, sans-serif">`;
  svg+=`<circle cx="91" cy="76" r="31" fill="${c.primarySoft}"/><circle cx="91" cy="76" r="26" fill="none" stroke="${c.primaryLine}" stroke-dasharray="2 4"/><g transform="translate(64 47) scale(.42)">${catMark()}</g>`;
  svg+=text(140,85,'worker routing',26,ink,'font-weight="600" letter-spacing="-1"')+text(w-73,82,t('DISPATCH / 协作手记','DISPATCH / FIELD NOTES'),12,muted,`text-anchor="end" ${label}`);
  svg+=`<path d="M73 123H${w-73}" stroke="${c.line}"/>`;
  const start=d.period.since?.slice(0,10)??t('全部已记录时间','ALL RECORDED TIME'), end=d.period.until?.slice(0,10)??t('未知','UNKNOWN');
  svg+=text(73,176,`${start} — ${end} / UTC`,13,muted,label);
  svg+=text(70,poster?250:240,t('有帮手，','Good work,'),poster?62:52,ink,'font-weight="500" letter-spacing="-2"');
  svg+=text(70,poster?322:303,t('工作有去有回。','in good company.'),poster?62:52,ink,'font-weight="500" letter-spacing="-2"');
  // The family seal is decorative; the header always retains the Canon cat.
  const sx=poster?814:1300,sy=poster?511:390,r=poster?165:199;
  svg+=`<g transform="rotate(7 ${sx} ${sy})"><circle cx="${sx}" cy="${sy+4}" r="${r}" fill="${c.shadow}" opacity=".65"/><circle cx="${sx}" cy="${sy}" r="${r}" fill="${c.primarySoft}"/><circle cx="${sx}" cy="${sy}" r="${r-15}" fill="none" stroke="${c.primaryLine}" stroke-width="1.5" stroke-dasharray="3 7"/>`;
  svg+=`<g transform="translate(${sx-(poster?121:149)} ${sy-(poster?141:169)}) scale(${poster?1.9:2.33})">${mascotMark(theme.mascot)}</g>`;
  svg+=text(sx,sy+r-32,t('一点帮忙，多一点从容','A LITTLE HELP GOES A LONG WAY'),zh?13:10,ink,`text-anchor="middle" ${label}`)+'</g>';
  // A small companion-coloured paper tab balances the seal, with no badge or status meaning.
  svg+=`<path d="M${sx+r-35} ${sy-r-3}l40 8-12 62-17-14-23 6Z" fill="${c.secondary}" opacity=".9"/>`;
  const heroY=poster?548:488;
  svg+=text(66,heroY,compact(d.worker_turns),poster?191:176,ink,'font-weight="500" letter-spacing="-10"');
  svg+=text(poster?76:449,poster?598:423,t('轮真实执行','WORKER TURNS'),poster?24:20,ink,label);
  svg+=text(poster?76:449,poster?635:457,t('每一次托付，都留下了回声。','Every round leaves a receipt.'),poster?19:17,muted);
  const divider=poster?687:530;
  svg+=`<path d="M73 ${divider}H${poster?w-73:958}" stroke="${c.line}"/>`;
  const metric=(x,y,value,name,note)=>text(x,y,name,14,muted,label)+text(x-3,y+79,compact(value),76,ink,bold)+text(x,y+116,note,15,muted);
  const my=poster?742:572,secondX=poster?560:485;
  svg+=metric(76,my,d.responsibilities,t('交出去的责任','RESPONSIBILITIES'),t('同一份责任，只数一次','One assignment, one responsibility'));
  svg+=metric(secondX,my,d.external_tokens,t('观测到的外部 TOKENS','EXTERNAL TOKENS'),t(`可归属用量 ${d.usage_sessions}/${d.usage_total_sessions}`,`Attributable usage ${d.usage_sessions}/${d.usage_total_sessions}`));
  svg+=`<path d="M${poster?523:426} ${my-10}v119" stroke="${c.line}"/>`;
  const y=poster?1000:736,barW=w-146,known=Math.min(d.responsibilities,d.runtime_completed);
  svg+=text(73,y,t(`${d.runtime_completed} 份运行完成`,`${d.runtime_completed} runtime completed`),20,ink,'font-weight="600"');
  svg+=text(w-73,y,t(`${d.review.accepted} 次接受 · ${d.review.taken_over} 次接管`,`${d.review.accepted} accepted · ${d.review.taken_over} taken over`),17,muted,'text-anchor="end"');
  svg+=`<rect x="73" y="${y+18}" width="${barW}" height="9" rx="4.5" fill="${c.track}"/>`;
  if(known)svg+=`<rect x="73" y="${y+18}" width="${barW*known/Math.max(1,d.responsibilities)}" height="9" rx="4.5" fill="${green}"/>`;
  svg+=text(73,y+(poster?79:52),t(`主动记录的复盘：${d.revisions} 次修正 · ${d.submissions} 次送验`,`Deliberate notes: ${d.revisions} explicit revisions · ${d.submissions} review submissions`),poster?17:15,muted);
  const footer=poster?1183:808;
  svg+=`<path d="M73 ${footer}H${w-73}" stroke="${c.primaryLine}" stroke-dasharray="3 7"/>`;
  svg+=text(73,footer+27,t(`仅 ACP · Adapter 报告的工作量，不代表节省额度。${d.warning_count?'部分数据不可用。':''}`,`ACP only · Adapter-reported workload, not quota savings.${d.warning_count?' Partial coverage.':''}`),poster?16:13,muted);
  svg+=text(73,h-46,'github.com/IndelibleVivi/codex-worker-routing',poster?15:13,ink);
  svg+=text(w-73,h-46,t('把成果叼回来。','WORK, WITH A LITTLE PURR.'),11,muted,`text-anchor="end" ${label}`);
  return svg+'</g></svg>';
}
