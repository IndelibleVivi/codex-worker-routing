// SPDX-License-Identifier: SUL-1.0
// This is the sole public export boundary. Never spread a private projection.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function projectShare(snapshot) {
  const s = snapshot.summary;
  return {
    schema: 'cwr.dispatch.share/1', scope: 'ACP receipts',
    period: { since: iso(snapshot.period.since), until: iso(snapshot.period.until) },
    responsibilities: count(s.responsibilities), worker_turns: count(s.worker_turns),
    runtime_completed: count(s.runtime_completed), submissions: count(s.submissions),
    revisions: count(s.revisions), accepted: count(s.accepted), taken_over: count(s.taken_over),
    external_tokens: Number.isSafeInteger(s.external_tokens) && s.external_tokens >= 0 ? s.external_tokens : null,
    usage_sessions: count(s.usage_sessions), usage_total_sessions: count(s.usage_total_sessions),
    warning_count: (snapshot.warnings ?? []).reduce((n, w) => n + count(w.count), 0),
  };
}

const esc = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const compact = value => value === null ? '—' : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value);
export function renderShareSVG(data, format = 'banner') {
  const d = projectShare({summary:data,period:data.period,warnings:[{count:data.warning_count}]});
  const poster=format==='poster',w=poster?1080:1600,h=poster?1350:900;
  const ink='#3e3348',muted='#7c7d76',sage='#95ad89',pink='#e6b4c6',plum='#65506f';
  const text=(x,y,value,size=24,color=ink,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`;
  const bold='font-weight="600" letter-spacing="-3"';
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Worker Routing Dispatch, aggregate ACP statistics"><rect width="${w}" height="${h}" fill="#fdfdfb"/><g font-family="Arial, Helvetica, sans-serif">`;
  svg+=`<path d="M75 88V56L89 68L103 56V88Q89 104 75 88M89 96V109H122" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  svg+=text(145,85,'WORKER ROUTING',24,ink,'font-weight="700" letter-spacing="2"')+text(w-75,85,'DISPATCH',17,muted,'text-anchor="end" letter-spacing="3"');
  svg+=text(75,poster?223:215,'Good work',poster?102:104,ink,bold)+text(75,poster?333:327,'adds up.',poster?102:104,plum,bold);
  svg+=text(78,poster?389:383,'A little delegation. A visible difference.',23,muted);
  // The visual encodes aggregate acceptance, never fabricated task edges.
  const cx=poster?810:1200,cy=poster?892:350,r=poster?120:154;
  svg+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eeede8" stroke-width="${poster?32:37}"/>`;
  let offset=0;
  for(const [value,color] of [[d.accepted,sage],[d.taken_over,pink]]){
    const n=value/Math.max(1,d.responsibilities)*100;
    if(n)svg+=`<circle cx="${cx}" cy="${cy}" r="${r}" pathLength="100" fill="none" stroke="${color}" stroke-width="${poster?32:37}" stroke-dasharray="${Math.max(0,n-.6)} ${100-Math.max(0,n-.6)}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset+=n;
  }
  svg+=text(cx,cy+13,compact(d.accepted),poster?62:80,ink,`${bold} text-anchor="middle"`)+text(cx,cy+48,'ACCEPTED',15,muted,'text-anchor="middle" letter-spacing="2"');
  if(!poster)svg+=text(cx,cy+222,`${d.accepted} accepted · ${d.taken_over} taken over`,19,muted,'text-anchor="middle"')+text(cx,cy+253,`${Math.max(0,d.responsibilities-d.accepted-d.taken_over)} unverified`,18,muted,'text-anchor="middle"');
  const card=(x,y,cw,ch,value,label,note,fill)=>`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="23" fill="${fill}"/>`+text(x+30,y+43,label,17,muted)+text(x+30,y+132,compact(value),77,ink,bold)+text(x+30,y+169,note,16,muted);
  if(poster){
    svg+=card(75,451,445,200,d.responsibilities,'RESPONSIBILITIES',`${d.runtime_completed} runtime completed`,'#edf3e8');
    svg+=card(540,451,465,200,d.worker_turns,'WORKER TURNS',`${d.submissions} submissions recorded`,'#f9edf1');
    svg+=card(75,673,445,210,d.external_tokens,'OBSERVED EXTERNAL TOKENS',`Attributable usage ${d.usage_sessions}/${d.usage_total_sessions}`,'#f3f1f6');
    svg+=text(80,965,`${d.revisions} explicit revision${d.revisions===1?'':'s'}`,27,ink)+text(80,1006,`${d.taken_over} coordinator takeover${d.taken_over===1?'':'s'}`,21,muted)+text(80,1046,`${Math.max(0,d.responsibilities-d.accepted-d.taken_over)} responsibilities unverified`,19,muted);
  }else{
    svg+=card(75,472,268,210,d.responsibilities,'RESPONSIBILITIES',`${d.runtime_completed} runtime completed`,'#edf3e8');
    svg+=card(361,472,268,210,d.worker_turns,'WORKER TURNS',`${d.revisions} explicit revisions`,'#f9edf1');
    svg+=card(647,472,298,210,d.external_tokens,'EXTERNAL TOKENS',`Attributable usage ${d.usage_sessions}/${d.usage_total_sessions}`,'#f3f1f6');
  }
  const footer=h-119,start=d.period.since?.slice(0,10)??'ALL RECORDED TIME',end=d.period.until?.slice(0,10)??'UNKNOWN';
  svg+=`<path d="M75 ${footer-33}H${w-75}" stroke="#e5e8df"/>`;
  svg+=text(75,footer,`${start} → ${end} UTC · ACP only · usage ${d.usage_sessions}/${d.usage_total_sessions}`,poster?19:21,muted);
  svg+=text(75,footer+36,`Adapter-reported workload, not quota savings.${d.warning_count?' Partial coverage.':''}`,poster?18:20,muted);
  svg+=text(w-75,h-28,'Faye Fang · github.com/IndelibleVivi/codex-worker-routing',poster?16:18,muted,'text-anchor="end"');
  return svg+'</g></svg>';
}
