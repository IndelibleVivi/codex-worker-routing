// SPDX-License-Identifier: SUL-1.0
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {startDashboard} from '../src/dashboard.mjs';
import {projectShare,renderShareSVG} from '../src/share.mjs';

const snapshot = () => ({
  schema:'cwr.dispatch/1',scope:'acp',observed_at:'2026-01-15T12:00:00.000Z',
  period:{since:'2026-01-08T12:00:00.000Z',until:'2026-01-15T12:00:00.000Z'},
  summary:{responsibilities:4,worker_turns:7,runtime_completed:3,failed:1,cancelled:0,submissions:2,revisions:1,accepted:1,taken_over:1,usage_sessions:3,usage_total_sessions:4,external_tokens:125000},
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
  assert.deepEqual(Object.keys(safe),['schema','scope','period','responsibilities','worker_turns','runtime_completed','submissions','revisions','accepted','taken_over','external_tokens','usage_sessions','usage_total_sessions','warning_count']);
  const malformed=snapshot();malformed.summary.external_tokens=null;malformed.summary.accepted='<script>private</script>';malformed.period.since='PRIVATE_PATH';
  const unknown=projectShare(malformed);assert.equal(unknown.external_tokens,null);assert.equal(unknown.period.since,null);assert.equal(unknown.accepted,0);
  malformed.summary.external_tokens=0;assert.equal(projectShare(malformed).external_tokens,0);
});
test('both share layouts have real selected-period counts and explicit workload scope',()=>{
  const data=projectShare(snapshot());
  for(const [format,width,height] of [['banner',1600,900],['poster',1080,1350]]) {
    const svg=renderShareSVG({...data,route:'PRIVATE_ROUTE_MARKER'},format);
    assert.match(svg,new RegExp(`width="${width}" height="${height}"`));
    assert.match(svg,/2026-01-08/);assert.match(svg,/125.0K/);assert.match(svg,/usage 3\/4/);
    assert.match(svg,/ACP only/);assert.match(svg,/not quota savings/);assert.match(svg,/unverified/);
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
test('static assets are local, read-only, protected by CSP; filesystem routes are not served',async t=>{
  const d=await start(t);
  for(const asset of ['/','/app.mjs','/style.css','/share.mjs']){
    const r=await fetch(d.origin+asset);assert.equal(r.status,200);
    assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(r.headers.get('referrer-policy'),'no-referrer');
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
