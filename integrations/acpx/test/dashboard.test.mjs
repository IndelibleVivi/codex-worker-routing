// SPDX-License-Identifier: SUL-1.0
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {renderLogoSVG} from '../src/brand.mjs';
import {mascotMark,renderMascotSVG} from '../src/mascots.mjs';
import {once} from 'node:events';
import {startDashboard} from '../src/dashboard.mjs';
import {projectShare,renderShareSVG} from '../src/share.mjs';
import {THEMES,getTheme} from '../src/themes.mjs';

const THEME_IDS=['sage','rose','mist','lavender'];
const FALLBACK_COLORS=getTheme('sage').colors;

const snapshot = () => ({
  schema:'cwr.dispatch/1',scope:'acp',observed_at:'2026-01-15T12:00:00.000Z',
  period:{since:'2026-01-08T12:00:00.000Z',until:'2026-01-15T12:00:00.000Z'},
  summary:{responsibilities:4,worker_turns:7,runtime_completed:3,failed:1,cancelled:0,submissions:2,revisions:1,accepted:1,taken_over:1,usage_sessions:3,usage_total_sessions:4,external_tokens:125000,review:{accepted:1,taken_over:1,awaiting_review:0,changes_requested:0,needs_attention:0,not_requested:0,no_receipt:0,legacy_untracked:2}},
  routes:[{name:'PRIVATE_ROUTE_MARKER',worker_turns:7}],
  sessions:[{id:'INTERNAL_ID_MARKER',title:'PRIVATE_WORK_ORDER_MARKER',output_excerpt:'PRIVATE_OUTPUT_MARKER',cwd:'/private/PATH_MARKER',diagnostic_path:'/private/DIAGNOSTIC_MARKER'}],
  activity:[],warnings:[],
});
const reader = () => ({read:async()=>snapshot(),detail:async id=>({session:{id},turns:[],events:[]})});
async function start(t,options={}) {
  const d=await startDashboard({reader:reader(),...options});
  t.after(async()=>{if(d.server.listening)await d.close();});
  const u=new URL(d.url),token=new URLSearchParams(u.hash.slice(1)).get('token');
  return {...d,origin:u.origin,headers:{Authorization:`Bearer ${token}`}};
}
test('public export has an explicit aggregate allowlist, no identifiers, strings or private detail',()=>{
  const safe=projectShare(snapshot()),serialized=JSON.stringify(safe);
  assert.doesNotMatch(serialized,/PRIVATE_|INTERNAL_|PATH_MARKER|DIAGNOSTIC/);
  assert.equal(safe.external_tokens,125000);assert.equal(safe.usage_sessions,3);
  assert.deepEqual(Object.keys(safe),['schema','scope','period','responsibilities','worker_turns','runtime_completed','failed','cancelled','review','submissions','revisions','accepted','taken_over','external_tokens','usage_sessions','usage_total_sessions','warning_count']);
  const malformed=snapshot();malformed.summary.external_tokens=null;malformed.summary.accepted='<script>private</script>';malformed.period.since='PRIVATE_PATH';
  const unknown=projectShare(malformed);assert.equal(unknown.external_tokens,null);assert.equal(unknown.period.since,null);assert.equal(unknown.accepted,0);
  malformed.summary.review={accepted:'PRIVATE_REVIEW',legacy_untracked:2,private_note:'PRIVATE_NOTE'};
  assert.equal(projectShare(malformed).review.accepted,0);assert.doesNotMatch(JSON.stringify(projectShare(malformed)),/PRIVATE_/);
  malformed.summary.external_tokens=0;assert.equal(projectShare(malformed).external_tokens,0);
});
test('both share layouts have real selected-period counts and explicit workload scope',()=>{
  const data=projectShare(snapshot());
  for(const [format,width,height] of [['banner',1600,900],['poster',1080,1350]]) {
    const svg=renderShareSVG({...data,route:'PRIVATE_ROUTE_MARKER'},format);
    assert.match(svg,new RegExp(`width="${width}" height="${height}"`));
    assert.match(svg,/2026-01-08/);assert.match(svg,/125.0K/);assert.match(svg,/usage 3\/4/);
    assert.match(svg,/ACP only/);assert.match(svg,/not quota savings/);assert.match(svg,/1 explicit revisions/);assert.doesNotMatch(svg,/Review tracking:/);assert.doesNotMatch(svg,/Faye Fang/);
    assert.doesNotMatch(svg,/PRIVATE_|INTERNAL_|<script|https?:\/\/[^<]*image/);
  }
});
test('dashboard binds only loopback; data needs a bearer token and exact origin',async t=>{
  const d=await start(t);assert.equal(d.server.address().address,'127.0.0.1');
  assert.equal((await fetch(`${d.origin}/api/snapshot`)).status,401);
  assert.equal((await fetch(`${d.origin}/api/snapshot`,{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(`${d.origin}/api/snapshot`,{headers:{...d.headers,Origin:'https://foreign.example'}})).status,403);
  const response=await fetch(`${d.origin}/api/snapshot`,{headers:d.headers});assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal((await response.json()).summary.responsibilities,4);
  const badHost=await new Promise((resolve,reject)=>{const req=http.get(`${d.origin}/api/snapshot`,{headers:{...d.headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(badHost,403);
});
test('static assets are local, read-only and CSP-protected; theme and mascot modules are served the same way',async t=>{
  const d=await start(t);
  for(const asset of ['/','/app.mjs','/style.css','/share.mjs','/brand.mjs','/logo.svg']){
    const r=await fetch(d.origin+asset);assert.equal(r.status,200);
    assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  }
  for(const asset of ['/themes.mjs','/mascots.mjs']){
    const r=await fetch(d.origin+asset);assert.equal(r.status,200);
    assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(r.headers.get('referrer-policy'),'no-referrer');
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');
    assert.equal(r.headers.get('content-type'),'text/javascript; charset=utf-8');
    assert.equal(await r.text(),await fs.readFile(new URL(`../src${asset}`,import.meta.url),'utf8'));
  }
  assert.equal((await fetch(`${d.origin}/state.json`)).status,404);
  assert.equal((await fetch(`${d.origin}/api/snapshot`,{method:'POST',headers:d.headers})).status,405);
  const share=await fetch(`${d.origin}/api/share`,{headers:d.headers});
  assert.doesNotMatch(await share.text(),/PRIVATE_|INTERNAL_|PATH_MARKER/);
});
test('HTTP error contains no raw filesystem or provider detail',async t=>{
  let n=0;const d=await start(t,{reader:{read:async()=>{if(n++)throw new Error('secret /home/private PROVIDER_TOKEN');return snapshot();}}});
  const response=await fetch(`${d.origin}/api/snapshot`,{headers:d.headers});
  assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'LOCAL_READ_FAILED'});
});
test('dashboard stops after authenticated close or an opened page losing its heartbeat',async t=>{
  const d=await start(t);const closed=once(d.server,'close');
  assert.equal((await fetch(`${d.origin}/api/close`,{method:'POST',headers:d.headers})).status,200);await closed;assert.equal(d.server.listening,false);
  const idle=await start(t,{idleMs:40});const idleClosed=once(idle.server,'close');
  await fetch(`${idle.origin}/api/ping`,{headers:idle.headers});await idleClosed;assert.equal(idle.server.listening,false);
});

test('packaged plugin logo matches the dashboard vector source',async()=>{
  assert.equal(await fs.readFile(new URL('../../../plugins/worker-routing/assets/cat.svg',import.meta.url),'utf8'),renderLogoSVG());
});

test('Chinese and English exports keep the same counts in both layouts',()=>{
  const data=projectShare(snapshot());
  for(const format of ['banner','poster']){
    const zh=renderShareSVG(data,format,'zh'),en=renderShareSVG(data,format,'en');
    assert.match(zh,/工作有去有回。/);assert.match(zh,/观测到的外部 TOKENS/);
    assert.match(zh,/3 份运行完成/);assert.match(zh,/不代表节省额度/);
    assert.match(en,/Good work,/);assert.match(en,/3 runtime completed/);
    for(const svg of [zh,en]){assert.match(svg,/125.0K/);assert.match(svg,/2026-01-08/);assert.doesNotMatch(svg,/Faye Fang|PRIVATE_/);}
  }
});

test('theme registry is bounded to four named palettes and falls back to sage',()=>{
  assert.deepEqual(THEMES.map(theme=>theme.id),THEME_IDS);
  for(const theme of THEMES){
    assert.ok(['cat','rabbit','dog','bear'].includes(theme.mascot),`${theme.id} needs a known companion`);
    assert.match(theme.name.zh,/\S/);assert.match(theme.name.en,/\S/);
    assert.deepEqual(Object.keys(theme.colors),Object.keys(THEMES[0].colors),'every palette exposes the same keys');
    for(const value of Object.values(theme.colors))assert.match(value,/^#[0-9a-f]{6}$/i,`${theme.id} has a non-hex colour`);
  }
  assert.equal(new Set(THEMES.map(theme=>JSON.stringify(theme.colors))).size,4,'each id needs a distinct palette');
  assert.equal(getTheme('sage'),THEMES[0]);
  assert.equal(getTheme('lavender'),THEMES.find(theme=>theme.id==='lavender'));
  for(const unknown of ['no-such-theme','___proto___','',null,undefined,{id:'rose'}])assert.equal(getTheme(unknown),THEMES[0]);
});

test('all themes and both layouts preserve the same counts, scope and Canon cat',()=>{
  const data=projectShare(snapshot());
  const canon=renderLogoSVG().match(/<g transform="[^"]*">.*<\/g>/s)[0];
  assert.doesNotMatch(canon,/style\s*=|var\(|currentColor/,'the Canon cat must not take colours from a theme');
  for(const [format,width,height] of [['banner',1600,900],['poster',1080,1350]]){
    for(const theme of THEMES){
      for(const language of ['zh','en']){
        const svg=renderShareSVG(data,format,language,theme.id);
        assert.match(svg,new RegExp(`width="${width}" height="${height}"`));
        assert.match(svg,new RegExp(`lang="${language==='zh'?'zh-CN':'en'}"`));
        assert.ok(svg.includes(canon),`${theme.id}/${format}/${language} must embed the Canon cat unchanged`);
        assert.match(svg,/125\.0K/);assert.match(svg,language==='zh'?/可归属用量 3\/4/:/usage 3\/4/);
        assert.match(svg,/2026-01-08/);assert.match(svg,/2026-01-15/);
        assert.match(svg,language==='zh'?/3 份运行完成/:/3 runtime completed/);
        assert.match(svg,language==='zh'?/不代表节省额度/:/not quota savings/);
        assert.ok(svg.includes('ACP only')||svg.includes('仅 ACP'),`${theme.id}/${format}/${language} lost the ACP-only scope note`);
        assert.doesNotMatch(svg,/PRIVATE_|INTERNAL_|PATH_MARKER|<script|Faye Fang/);
      }
    }
  }
});

test('untrusted export data cannot choose a palette or inject markup',()=>{
  const hostile={...projectShare(snapshot()),
    theme:'no-such-theme',themeId:'rose',color:'#000000',colors:['#ff0000','</style><script>x</script>'],style:'fill:red'};
  const fallback=renderShareSVG(hostile,'banner','en',undefined);
  assert.equal(fallback,renderShareSVG(projectShare(snapshot()),
    'banner','en','sage'),'export data must not influence theme lookup');
  assert.doesNotMatch(fallback,/#ff0000|fill:red|<script|themeId|"rose"/);
  assert.ok(fallback.includes(getTheme('sage').colors.primary));
});

test('each theme exports its own palette and companion while the header keeps the Canon cat',()=>{
  const data=projectShare(snapshot());
  const canon=renderLogoSVG().match(/<g transform="[^"]*">.*<\/g>/s)[0];
  const animals={},
        rendered=new Set();
  for(const id of THEME_IDS){
    const svg=renderShareSVG(data,'banner','en',id);rendered.add(svg);
    const theme=getTheme(id),c=theme.colors;
    for(const [key,value] of Object.entries({mat:c.mat,shadow:c.shadow,surface:c.surface,primary:c.primary,secondary:c.secondary}))
      assert.ok(svg.includes(value),`${id} export does not use its ${key} colour ${value}`);
    // The hero seal carries this theme's companion; the header still carries the Canon cat verbatim.
    const animal=mascotMark(theme.mascot);
    if(id==='sage')assert.equal(animal,canon,'the default sage theme companion is the Canon cat');
    else assert.notEqual(animal,canon,`${id} companion must be a sibling, not the Canon cat mark`);
    assert.ok(svg.includes(animal),`${id} export does not embed its ${theme.mascot} companion`);
    assert.ok(svg.includes(canon),`${id} export lost the header Canon cat`);
    animals[id]=animal;
  }
  assert.equal(rendered.size,4,'exports must differ per theme');
  assert.equal(new Set(Object.values(animals)).size,4,'each theme needs a distinct companion');
  // The Canon cat, not the palette, still carries these fixed mark colours.
  for(const markColor of ['#44324f','#fffefa','#a8be9c','#edbed0','#88657f'])assert.ok(renderShareSVG(data,'banner','en','lavender').includes(markColor));
});

test('mascotMark returns the Canon cat for its default and any unknown companion',()=>{
  const canon=renderLogoSVG().match(/<g transform="[^"]*">.*<\/g>/s)[0];
  for(const unknown of [undefined,null,'no-such-companion','___proto___',{id:'rabbit'}])
    assert.equal(renderMascotSVG(unknown),renderMascotSVG('cat'),`${String(unknown)} must fall back to the Canon cat`);
  assert.equal(renderMascotSVG(),renderMascotSVG('cat'));
  assert.ok(renderMascotSVG('cat').includes(canon));
  assert.match(renderMascotSVG('no-such-companion'),/aria-label="Worker Routing companion"/);
  // Named companions exist and stay siblings, not recolourings of the Canon mark.
  for(const id of ['rabbit','dog','bear']){
    const svg=renderMascotSVG(id);
    assert.notEqual(mascotMark(id),canon,`${id} must not reuse the Canon cat mark`);
    assert.doesNotMatch(svg,/onload|<script/);
  }
});

test('a malicious theme id falls back to the Canon sage palette and cat',()=>{
  const data=projectShare(snapshot()),sage=renderShareSVG(data,'banner','en','sage');
  const hostileIds=['no-such-theme','no-such-theme" onload="alert(1)','</style><script>alert(1)</script>','mist '.repeat(64)];
  for(const id of hostileIds.concat([null,undefined,{},['rose']])){
    const svg=renderShareSVG(data,'banner','en',id);
    assert.equal(svg,sage,`${String(id)} must render the Canon sage export`);
    assert.doesNotMatch(svg,/onload|alert\(|<script|no-such-theme/i);
    assert.ok(svg.includes(FALLBACK_COLORS.primary));
  }
});
