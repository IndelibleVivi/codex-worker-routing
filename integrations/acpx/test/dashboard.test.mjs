// SPDX-License-Identifier: SUL-1.0
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {renderProductMarkSVG,productMark} from '../src/mark.mjs';
import {Fault} from '../src/state.mjs';
import {resolveTimeZone} from '../src/time.mjs';
import fs from 'node:fs/promises';
import {renderLogoSVG} from '../src/brand.mjs';
import {mascotMark,renderMascotSVG} from '../src/mascots.mjs';
import {once} from 'node:events';
import {startDashboard} from '../src/dashboard.mjs';
import {projectShare,renderShareSVG,renderShareCaption} from '../src/share.mjs';
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
  assert.deepEqual(Object.keys(safe),['schema','scope','period','time_zone','responsibilities','worker_turns','runtime_completed','failed','cancelled','review','submissions','revisions','accepted','taken_over','external_tokens','usage_sessions','usage_total_sessions','warning_count']);
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
    assert.match(svg,/2026-01-08/);assert.match(svg,/125.0K/);assert.match(svg,/attributable for 3 of 4 receipted tasks/);
    assert.match(svg,/ACP only/);assert.match(svg,/not acceptance or Codex quota savings/);assert.doesNotMatch(svg,/Review tracking:/);assert.doesNotMatch(svg,/Faye Fang/);
    assert.doesNotMatch(svg,/PRIVATE_|INTERNAL_|<script|https?:\/\/[^<]*image/);
  }
});
test('share outcome geometry preserves rare proportions and the full track width',()=>{
  const data={...projectShare(snapshot()),responsibilities:10000,worker_turns:12000,runtime_completed:9997,failed:1,cancelled:1,usage_sessions:9000,usage_total_sessions:10000};
  for(const [format,width] of [['poster',920],['banner',1440]]){
    const svg=renderShareSVG(data,format);
    const segments=[...svg.matchAll(/<rect data-outcome="([^"]+)" x="([^"]+)" y="[^"]+" width="([^"]+)"/g)].map(([,key,x,w])=>({key,x:Number(x),width:Number(w)}));
    assert.equal(segments.length,4);
    const counts={completed:9997,failed:1,cancelled:1,unknown:1};
    let end=80;
    for(const segment of segments){
      assert.ok(Math.abs(segment.x-end)<1e-9,'segments must be adjacent');
      assert.ok(Math.abs(segment.width/width-counts[segment.key]/10000)<1e-12,'width must encode the actual fraction');
      end=segment.x+segment.width;
    }
    assert.ok(Math.abs(end-(80+width))<1e-9,'the strip must end at its allotted boundary');
  }
});
test('empty share outcomes keep a neutral track without fabricated segments',()=>{
  const data={...projectShare(snapshot()),responsibilities:0,runtime_completed:0,failed:0,cancelled:0,worker_turns:0,external_tokens:null,usage_sessions:0,usage_total_sessions:0};
  for(const format of ['poster','banner']){
    const svg=renderShareSVG(data,format);
    assert.match(svg,/id="share-outcome-track"/);
    assert.doesNotMatch(svg,/data-outcome="|NaN|Infinity/);
    assert.match(svg,/>—<\/text>/);
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
  for(const asset of ['/','/app.mjs','/style.css','/share.mjs','/share-style.mjs','/ornaments.mjs','/brand.mjs','/logo.svg','/mark.mjs','/mark.svg','/time.mjs']){
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
    assert.match(zh,/工作有去有回。/);assert.match(zh,/外部已知 tokens/);
    assert.match(zh,/运行完成 3/);assert.match(zh,/不代表验收结论或节省的 Codex 额度/);
    assert.match(en,/Good work,/);assert.match(en,/Completed 3/);
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

test('all themes and both layouts preserve counts, scope and the selected unchanged companion',()=>{
  const data=projectShare(snapshot());
  const canon=renderLogoSVG().match(/<g transform="[^"]*">.*<\/g>/s)[0];
  assert.doesNotMatch(canon,/style\s*=|var\(|currentColor/,'the Canon cat must not take colours from a theme');
  for(const [format,width,height] of [['banner',1600,900],['poster',1080,1350]]){
    for(const theme of THEMES){
      for(const language of ['zh','en']){
        const svg=renderShareSVG(data,format,language,theme.id);
        assert.match(svg,new RegExp(`width="${width}" height="${height}"`));
        assert.match(svg,new RegExp(`lang="${language==='zh'?'zh-CN':'en'}"`));
        assert.ok(svg.includes(mascotMark(theme.mascot)),`${theme.id}/${format}/${language} must embed its companion unchanged`);
        assert.ok(svg.includes(productMark().match(/<path[^>]+>/)[0]),'fixed product mark remains in the header');
        assert.match(svg,/125\.0K/);assert.match(svg,language==='zh'?/3 份用量可归属/:/attributable for 3 of 4/);
        assert.match(svg,/2026-01-08/);assert.match(svg,/2026-01-15/);
        assert.match(svg,language==='zh'?/运行完成 3/:/Completed 3/);
        assert.match(svg,language==='zh'?/不代表验收结论或节省的 Codex 额度/:/not acceptance or Codex quota savings/);
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
  assert.ok(fallback.includes(getTheme('sage').colors.primarySoft));
});

test('each theme exports its own palette and companion while the product mark stays fixed',()=>{
  const data=projectShare(snapshot());
  const canon=renderLogoSVG().match(/<g transform="[^"]*">.*<\/g>/s)[0];
  const animals={},
        rendered=new Set();
  for(const id of THEME_IDS){
    const svg=renderShareSVG(data,'banner','en',id);rendered.add(svg);
    const theme=getTheme(id),c=theme.colors;
    for(const [key,value] of Object.entries({mat:c.mat,surface:c.surface,primary:c.primarySoft}))
      assert.ok(svg.includes(value),`${id} export does not use its ${key} colour ${value}`);
    // The hero seal carries the unchanged theme companion; the product header is fixed.
    const animal=mascotMark(theme.mascot);
    if(id==='sage')assert.equal(animal,canon,'the default sage theme companion is the Canon cat');
    else assert.notEqual(animal,canon,`${id} companion must be a sibling, not the Canon cat mark`);
    assert.ok(svg.includes(animal),`${id} export does not embed its ${theme.mascot} companion`);
    assert.ok(svg.includes(productMark().match(/<path[^>]+>/)[0]),`${id} export lost the product mark`);
    animals[id]=animal;
  }
  assert.equal(rendered.size,4,'exports must differ per theme');
  assert.equal(new Set(Object.values(animals)).size,4,'each theme needs a distinct companion');
  // The Canon cat, not the palette, still carries these fixed mark colours.
  for(const markColor of ['#44324f','#fffefa','#a8be9c','#edbed0','#88657f'])assert.ok(renderShareSVG(data,'banner','en','sage').includes(markColor));
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
    assert.ok(svg.includes(FALLBACK_COLORS.primarySoft));
  }
});

test('share caption and image use the frozen calendar zone and drop project and runtime detail',()=>{
  const input=snapshot();input.time_zone='Asia/Shanghai';input.period={since:'2026-01-14T18:00:00Z',until:'2026-01-15T18:00:00Z'};
  input.workspaces=[{name:'PRIVATE_PROJECT',root:'/private/PATH_MARKER'}];input.runtime_notes={events:[{code:'PRIVATE_RUNTIME'}]};
  const data=projectShare(input);
  for(const language of ['en','zh']){
    const caption=renderShareCaption({...data,workspace:input.workspaces},language),svg=renderShareSVG(data,'poster',language);
    for(const value of [caption,svg]){assert.match(value,/2026-01-15/);assert.match(value,/2026-01-16/);assert.match(value,/Asia\/Shanghai/);assert.doesNotMatch(value,/PRIVATE_|PATH_MARKER/);}
  }
  assert.match(renderProductMarkSVG(),/aria-label="Worker Routing"/);
});

test('display preferences persist across dashboard ports with an authenticated, bounded allowlist',async t=>{
  const stateDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'cwr-prefs-')));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const a=await start(t,{stateDir});
  const get=d=>fetch(d.origin+'/api/preferences',{headers:d.headers});
  const put=(d,value,headers=d.headers)=>fetch(d.origin+'/api/preferences',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:typeof value==='string'?value:JSON.stringify(value)});
  assert.deepEqual(await (await get(a)).json(),{theme:'sage',language:'zh',timeZone:'local'});
  const selected={theme:'mist',language:'en',timeZone:'America/New_York'};
  assert.equal((await put(a,selected,{})).status,401);
  assert.equal((await put(a,selected,{...a.headers,Origin:'https://foreign.example'})).status,403);
  assert.equal((await put(a,selected)).status,200);
  for(const bad of [{...selected,cwd:'/private/work'}, {...selected,theme:'invalid'}, {...selected,timeZone:'BAD/ZONE'}, '{', []])assert.equal((await put(a,bad)).status,400);
  assert.equal((await put(a,'x'.repeat(1025))).status,413);
  const b=await start(t,{stateDir});assert.notEqual(a.port,b.port);
  assert.deepEqual(await (await get(b)).json(),selected);
  assert.deepEqual(await fs.readdir(stateDir),['dashboard-preferences.json']);
});

test('all private and share HTTP reads forward the same explicit timezone; invalid zones are 400',async t=>{
  const calls=[];const projection={read:async opts=>{calls.push(opts);try{const time_zone=resolveTimeZone(opts.timeZone);return {...snapshot(),time_zone};}catch{throw new Fault('BAD_TIME_ZONE','Bad zone');}},detail:async(id,opts)=>{calls.push(opts);return {id,time_zone:opts.timeZone};}};
  const d=await start(t,{reader:projection});
  for(const route of ['/api/snapshot','/api/share','/api/detail/11111111-1111-4111-8111-111111111111']){
    const response=await fetch(d.origin+route+'?timeZone=Asia%2FShanghai',{headers:d.headers});assert.equal(response.status,200);assert.equal((await response.json()).time_zone,'Asia/Shanghai');assert.equal(calls.at(-1).timeZone,'Asia/Shanghai');
  }
  assert.equal((await fetch(d.origin+'/api/snapshot?timeZone=Bad%2FZone',{headers:d.headers})).status,400);
});

test('share author text is explicit, XML-escaped and independent of receipt data',()=>{
  const data=projectShare(snapshot()),slogan='<script>hello & goodbye</script>',sharedBy='A & B <crew>';
  for(const format of ['poster','banner']){
    const svg=renderShareSVG({...data,slogan:'PRIVATE_SLOGAN',sharedBy:'PRIVATE_CREDIT'},format,'en','sage',{slogan,sharedBy});
    assert.match(svg,/id="share-slogan"/);assert.match(svg,/id="share-credit"/);
    assert.match(svg,/&lt;script&gt;/);assert.match(svg,/A &amp; B &lt;crew&gt;/);
    assert.doesNotMatch(svg,/<script>|PRIVATE_SLOGAN|PRIVATE_CREDIT/);
    assert.equal(renderShareSVG({...data,slogan:'PRIVATE_SLOGAN',sharedBy:'PRIVATE_CREDIT'},format),renderShareSVG(data,format));
  }
  const caption=renderShareCaption(data,'en',{slogan:'My little record',sharedBy:'A & B'});
  assert.ok(caption.startsWith('My little record\n\nShared by A & B\n\n'));
  assert.match(caption,/4 delegated tasks/);assert.match(caption,/not acceptance or Codex quota savings/);
  assert.equal(projectShare({...snapshot(),slogan,sharedBy}).slogan,undefined);
});

test('share personalization changes lettering and ornament without changing statistics or Canon',()=>{
  const data=projectShare(snapshot()),base=renderShareSVG(data);
  const track=svg=>svg.match(/<g id="share-outcome-track">.*?<\/g>/s)[0];
  for(const numberStyle of ['soft','book','mono'])for(const ornament of ['thread','bloom','none']){
    const svg=renderShareSVG(data,'banner','zh','sage',{slogan:'小小协作，慢慢成事。',numberStyle,ornament});
    assert.equal(track(svg),track(base));assert.ok(svg.includes(mascotMark('cat')));
    assert.equal(svg.includes('id="share-ornament"'),ornament!=='none');
    assert.match(svg,/125\.0K/);
  }
  const empty=renderShareSVG(data,'poster','en','sage',{slogan:'',sharedBy:'',ornament:'none'});
  assert.doesNotMatch(empty,/id="share-slogan"|id="share-credit"|id="share-ornament"/);
  assert.equal(track(empty),track(renderShareSVG(data,'poster')));
});
