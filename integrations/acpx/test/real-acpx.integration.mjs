// This suite intentionally FAILS if the pinned package is missing. It never
// substitutes the contract double. Execute with `npm run test:acpx` after install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { loadAcpx } from '../src/cli.mjs';
import { fixture, sleep } from './helpers.mjs';
const cli=path.resolve('src/cli.mjs'),agent=path.resolve('test/fixture-acp-agent.mjs');
function ownFixture(t,f){
 f.runs=new Set();
 // Stop and reap a failed test's CLI BEFORE deleting its live state. Adapter
 // stdin closes with the CLI; the synthetic server also clears parked timers.
 t.after(async()=>{try{await Promise.all([...f.runs].map(run=>run.stop()))}finally{await f.cleanup()}});
 return f;
}
async function setup(t,overrides={}){await loadAcpx();return ownFixture(t,await fixture({argv:[process.execPath,agent],timeoutMs:5000,...overrides}))}
// Containment, not a raw string prefix: "<home>-other" must not count as being
// under "<home>".
const contained=(root,candidate)=>{const rel=path.relative(root,candidate);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel)};
async function command(f,verb,extra=[],entry=cli){return start(f,verb,extra,entry).done}
// A blocking `run` must be started without awaiting it so a second control
// command can race it. Progress is detected by a real condition, never a fixed
// sleep.
function start(f,verb,extra=[],entry=cli,env={}){
 const mode=['run','continue'].includes(verb)&&!extra.includes('--permissions')?['--permissions','read']:[];
 const args=[entry,verb,'--config',f.configFile,...mode,...extra];
 const child=execFile(process.execPath,args,{timeout:25000,killSignal:'SIGKILL',maxBuffer:512*1024,env:{...process.env,...env,CWR_PRIVATE_TEST_MARKER:'MUST_NOT_ARRIVE'}});
 let closed=false;
 const done=new Promise(resolve=>{
  let stdout='',stderr='',spawnError;
  child.stdout.on('data',d=>{stdout+=d});child.stderr.on('data',d=>{stderr+=d});
  child.on('error',e=>{spawnError=e.code??'ERROR'});
  child.on('close',(code,signal)=>{
   closed=true;let receipt=null;
   try{receipt=stdout.trim()?JSON.parse(stdout):null}catch(error){stderr+=`\nInvalid receipt JSON: ${error.message}`}
   resolve({code:code??spawnError??signal,stdout,stderr,receipt});
  });
 });
 const stop=async()=>{
  if(!closed){
   child.kill('SIGTERM');
   const force=setTimeout(()=>{if(!closed)child.kill('SIGKILL')},2000);
   try{await done}finally{clearTimeout(force)}
  }
 };
 const run={child,done,stop};f.runs.add(run);
 done.then(()=>f.runs.delete(run));
 return run;
}
async function until(check,message,timeout=15000){
 const end=Date.now()+timeout;
 for(;;){const v=await check();if(v)return v;if(Date.now()>=end)throw new Error(message);await sleep(25)}
}
const initial=f=>['--route','worker','--cwd',f.cwd,'--file',f.orderFile];

// A routing config is exercised against the REAL pinned acpx and the spawned
// synthetic ACP server. The default route omits --route entirely; the fallback
// case points the default at a non-existent entry so the run resolves the
// registered backup before any adapter launch and issues exactly one prompt.
async function routingSetup(t,{fallbacks=[],breakDefault=false}={}){
 await loadAcpx();
 const f=ownFixture(t,await fixture({argv:[process.execPath,agent],timeoutMs:5000}));
 // Register a second, launchable route as the backup with a disjoint worker home.
 f.raw.routes.backup={...f.raw.routes.worker,argv:[process.execPath,agent],workerHome:path.join(f.root,'backup-home'),contextRevision:'synthetic-backup-v1'};
 if(breakDefault) f.raw.routes.worker={...f.raw.routes.worker,argv:[path.join(f.root,'missing-agent')]};
 f.raw.routing={default:'worker',...(fallbacks.length?{fallbacks}:{})};
 await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 return f;
}
test('REAL acpx: omitting --route uses routing.default end-to-end',async t=>{
 const f=await routingSetup(t);
 const {code,stderr,receipt}=await command(f,'run',['--cwd',f.cwd,'--file',f.orderFile]);
 assert.equal(code,0,stderr);
 assert.equal(receipt.route,'worker');
 assert.deepEqual(receipt.selection,{schema:'cwr.acp.selection/1',requested_route:'worker',actual_route:'worker',fallback:null,skipped_routes:[]});
 assert.equal(JSON.parse(receipt.output_excerpt).turn,1);
});

test('REAL acpx: dependent continuations reuse one existing session and preserve each exact report', async t => {
 const f = await setup(t);
 const initialRun = await command(f, 'run', initial(f));
 assert.equal(initialRun.code, 0, initialRun.stderr);
 const session = initialRun.receipt.session_id;
 const secondOrder = path.join(f.root, 'second-turn.md');
 await fs.writeFile(secondOrder, 'Compare the exact predecessor report in this existing responsibility.');
 const manifestFile = path.join(f.root, 'continued-graph.json');
 await fs.writeFile(manifestFile, JSON.stringify({ schema:'cwr.acp.batch-manifest/1', maxConcurrency:2, jobs:[
  { id:'first', verb:'continue', session, cwd:f.cwd, file:f.orderFile, permissions:'read' },
  { id:'second', verb:'continue', session, cwd:f.cwd, file:secondOrder, permissions:'read',
    depends_on:['first'], inputs:[{job:'first',report:true}] },
 ] }));
 const batch = await command(f, 'batch', ['--manifest', manifestFile]);
 assert.equal(batch.code, 0, JSON.stringify(batch));
 assert.equal(batch.receipt.status, 'complete');
 const first = batch.receipt.jobs.find(j => j.id === 'first');
 const second = batch.receipt.jobs.find(j => j.id === 'second');
 assert.equal(first.session_id, session);
 assert.equal(second.session_id, session);
 assert.notEqual(first.request_id, second.request_id);
 assert.equal(first.cleanup, 'confirmed');
 assert.equal(second.cleanup, 'confirmed');
 const bound = await fs.readFile(path.join(path.dirname(batch.receipt.index_path), 'second.order.md'), 'utf8');
 assert.ok(bound.includes(first.request_id));
 assert.ok(bound.includes('synthetic delivery'));
 const audit = (await fs.readFile(path.join(f.selection.route.workerHome, 'fixture-audit.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(audit.filter(e => e.method === 'session/new').length, 1);
 assert.equal(audit.filter(e => e.method === 'session/load').length, 2);
 assert.equal(audit.filter(e => e.method === 'session/prompt').length, 3);
});
test('REAL acpx: an unavailable default falls back before launch and issues exactly one prompt',async t=>{
 const f=await routingSetup(t,{fallbacks:['backup'],breakDefault:true});
 const {code,stderr,receipt}=await command(f,'run',['--cwd',f.cwd,'--file',f.orderFile]);
 assert.equal(code,0,stderr);
 assert.equal(receipt.route,'backup');
 assert.deepEqual(receipt.selection,{schema:'cwr.acp.selection/1',requested_route:'worker',actual_route:'backup',fallback:'backup',skipped_routes:[{route:'worker',code:'BAD_EXECUTABLE'}]});
 // Exactly one responsibility/prompt in the fallback worker home's audit trail.
 const audit=(await fs.readFile(path.join(f.raw.routes.backup.workerHome,'fixture-audit.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(audit.filter(e=>e.method==='session/new').length,1);
 assert.equal(audit.filter(e=>e.method==='session/prompt').length,1);
 // The unavailable default never launched: its worker home was never created.
 await assert.rejects(fs.stat(f.raw.routes.worker.workerHome),{code:'ENOENT'});
});

test('REAL acpx plus spawned synthetic ACP process: restart, same session, clean env, preserved history',async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);assert.equal(a.receipt.cleanup,'confirmed');
 const text=JSON.parse(a.receipt.output_excerpt);assert.equal(text.turn,1);assert.equal(text.main_marker_present,false);assert.equal(text.home,f.selection.route.workerHome);
 const scratch=text.tmpdir;
 assert.equal(path.dirname(scratch),path.join(f.config.stateDir,'scratch'));
 assert.ok(path.basename(scratch).length<=22,'the session component stays compact');
 assert.equal(text.tmpdir,scratch,'the spawned ACP process sees this session’s scratch');
 const manifest=JSON.parse(await fs.readFile(path.join(scratch,'.cwr-scratch.json'),'utf8'));
 assert.equal(manifest.session_id,a.receipt.session_id);assert.equal(manifest.home,f.selection.route.workerHome);
 const b=await command(f,'continue',['--session',a.receipt.session_id,'--file',f.orderFile]);assert.equal(b.code,0,b.stderr);assert.equal(b.receipt.acp_session_id,a.receipt.acp_session_id);assert.equal(JSON.parse(b.receipt.output_excerpt).turn,2);
 assert.equal(JSON.parse(b.receipt.output_excerpt).tmpdir,scratch,'continuation retains temporary references');
 const c=await command(f,'close',['--session',a.receipt.session_id]);assert.equal(c.code,0,c.stderr);assert.equal(c.receipt.history_deleted,false);
 assert.equal((await fs.stat(scratch)).isDirectory(),true,'closing alone never deletes scratch');
 assert.ok(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-sessions.json'),'utf8'),'provider history is retained');
});
test('REAL acpx: provider cannot load the old session, so no replacement prompt is issued',async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);
 await fs.writeFile(path.join(f.selection.route.workerHome,'fixture-sessions.json'),'{}');
 const b=await command(f,'continue',['--session',a.receipt.session_id,'--file',f.orderFile]);assert.notEqual(b.code,0);assert.equal(b.receipt.runtime_status,'failed');
 const audit=(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-audit.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(audit.filter(e=>e.method==='session/new').length,1);assert.equal(audit.filter(e=>e.method==='session/prompt').length,1);
});
test('REAL ACP permission handshake: read policy denies edit; explicit full continuation permits it',async t=>{
 const f=await setup(t);await fs.writeFile(f.orderFile,'FIXTURE_WRITE');
 const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);assert.equal(JSON.parse(a.receipt.output_excerpt).allowed,false);
 await assert.rejects(fs.stat(path.join(f.cwd,'fixture-result.txt')),{code:'ENOENT'});
 const b=await command(f,'continue',['--session',a.receipt.session_id,'--file',f.orderFile,'--permissions','full']);assert.equal(b.code,0,b.stderr);assert.equal(JSON.parse(b.receipt.output_excerpt).allowed,true);assert.equal(b.receipt.acp_session_id,a.receipt.acp_session_id);
});
// Real run -> cancel -> cancelled receipt -> confirmed cleanup and an idle lock.
// The synthetic fixture parks on FIXTURE_WAIT; cancellation is issued only after
// the audit file proves the prompt reached the spawned adapter, so there is no
// fixed sleep race. Account-free and network-free, like the rest of this suite.
test('REAL acpx: cancelling a waiting turn yields a cancelled receipt and an idle lock',async t=>{
 const f=await setup(t,{timeoutMs:15000});
 await fs.writeFile(f.orderFile,'FIXTURE_WAIT');
 const run=start(f,'run',initial(f));
 const bindings=path.join(f.config.stateDir,'bindings');
 const id=await until(async()=>{
  const entries=await fs.readdir(bindings).catch(()=>[]);
  for(const entry of entries){
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry))continue;
   try{const owner=JSON.parse(await fs.readFile(path.join(bindings,entry,'active.lock','owner.json'),'utf8'));if(typeof owner.nonce==='string')return entry}catch{/* lock not written yet */}
  }
  return null;
 },'the run never published a session lock');
 const audit=path.join(f.selection.route.workerHome,'fixture-audit.ndjson');
 await until(async()=>{const log=await fs.readFile(audit,'utf8').catch(()=>'');return log.includes('session/prompt')},'the adapter never received the prompt');
 const cancel=await command(f,'cancel',['--session',id]);
 assert.equal(cancel.code,0,cancel.stderr);assert.equal(cancel.receipt.cancel_requested,true);assert.equal(cancel.receipt.stopped,false);
 const a=await run.done;
 assert.equal(a.code,130,a.stderr);
 assert.equal(a.receipt.session_id,id);assert.equal(a.receipt.runtime_status,'cancelled');assert.equal(a.receipt.cleanup,'confirmed');
 const s=await command(f,'status',['--session',id]);
 assert.equal(s.code,0,s.stderr);assert.equal(s.receipt.active,'idle');assert.equal(s.receipt.closed,false);
});
test('REAL recovery: normal final remains completed with CWR-owned task budget',async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));
 assert.equal(a.code,0,a.stderr);assert.equal(a.receipt.runtime_status,'completed');
 assert.equal(a.receipt.error_code,null);assert.equal(a.receipt.cleanup,'confirmed');
 assert.equal(a.receipt.budget.task_ms,5000);assert.ok(a.receipt.budget.prompt_started_at);
 assert.equal(JSON.parse(a.receipt.output_excerpt).turn,1);
});
test('REAL recovery: progress without RPC final reaches CWR deadline despite cooperative end_turn on cancel',async t=>{
 const f=await setup(t,{timeoutMs:2000});
 await fs.writeFile(f.orderFile,'FIXTURE_PROGRESS_ONLY CANCEL_END_TURN');
 const a=await command(f,'run',initial(f));
 assert.equal(a.code,1,a.stderr);assert.equal(a.receipt.runtime_status,'failed');
 assert.equal(a.receipt.error_code,'TURN_TIMEOUT');assert.equal(a.receipt.stop_reason,null);
 assert.equal(a.receipt.cleanup,'confirmed');assert.match(a.receipt.output_excerpt,/Synthetic progress, no final response/);
 assert.ok(Date.parse(a.receipt.finished_at)-Date.parse(a.receipt.budget.prompt_started_at)>=2000);
 assert.equal(Date.parse(a.receipt.budget.task_deadline_at)-Date.parse(a.receipt.budget.prompt_started_at),2000);
 assert.ok(a.receipt.budget.task_elapsed_ms>=1900);assert.ok(a.receipt.activity.event_count>0);
 assert.ok(a.receipt.activity.last_event_age_ms>=1000,'the initial progress is retained as an old observation at the deadline');
 const audit=(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-audit.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(audit.filter(e=>e.method==='session/prompt').length,1);
 assert.ok(audit.some(e=>e.method==='session/cancel'));
 const s=await command(f,'status',['--session',a.receipt.session_id]);assert.equal(s.receipt.active,'idle');
 assert.equal(s.receipt.last_error_code,'TURN_TIMEOUT');assert.equal(s.receipt.receipt_evidence.source,'binding');
 assert.deepEqual(s.receipt.receipt_evidence.activity,a.receipt.activity);assert.deepEqual(s.receipt.receipt_evidence.budget,a.receipt.budget);
});
test('REAL recovery: public zero turn timeout overrides a shorter inherited runtime timer',async t=>{
 const f=await setup(t,{timeoutMs:6000});
 // Use only public APIs. A 2s inherited runtime timer would recover this
 // progress-only reply at about 3s, before CWR's 6s budget. Therefore failure
 // specifically at CWR's deadline distinguishes honored timeoutMs:0 from a
 // runtime that ignores zero or silently substitutes its default.
 // Run in its own process just like the other real-runtime tests: acpx's
 // agentProcessEnv is an overlay, so it is not a substitute for CLI scrubbing.
 await fs.writeFile(f.orderFile,'FIXTURE_PROGRESS_ONLY CANCEL_END_TURN');
 const {code,stderr,receipt}=await command(f,'run',initial(f),path.resolve('test/fixture-inherited-timeout.mjs'));
 const evidence=JSON.stringify({code,stderr,receipt});
 assert.equal(code,1,evidence);assert.equal(receipt.runtime_status,'failed',evidence);assert.equal(receipt.error_code,'TURN_TIMEOUT',evidence);assert.equal(receipt.cleanup,'confirmed',evidence);
 assert.match(receipt.output_excerpt,/Synthetic progress/);
 assert.ok(Date.parse(receipt.finished_at)-Date.parse(receipt.budget.prompt_started_at)>=6000);
 const s=await command(f,'status',['--session',receipt.session_id]);assert.equal(s.receipt.active,'idle');
});
test('REAL recovery: operator cancel remains cancelled when adapter answers end_turn',async t=>{
 const f=await setup(t,{timeoutMs:15000});await fs.writeFile(f.orderFile,'FIXTURE_PROGRESS_ONLY CANCEL_END_TURN');
 const run=start(f,'run',initial(f));
 const audit=path.join(f.selection.route.workerHome,'fixture-audit.ndjson');
 await until(async()=>{const log=await fs.readFile(audit,'utf8').catch(()=>'');return log.includes('session/prompt')},'the adapter never received the prompt');
 const entries=await fs.readdir(path.join(f.config.stateDir,'bindings'));let id;
 for(const entry of entries){try{await fs.stat(path.join(f.config.stateDir,'bindings',entry,'active.lock'));id=entry;break}catch{}}
 assert.ok(id);const cancel=await command(f,'cancel',['--session',id]);assert.equal(cancel.code,0,cancel.stderr);
 const a=await run.done;assert.equal(a.code,130,a.stderr);assert.equal(a.receipt.runtime_status,'cancelled');
 assert.equal(a.receipt.error_code,'CANCEL_REQUESTED');assert.equal(a.receipt.cleanup,'confirmed');
 assert.match(a.receipt.output_excerpt,/Synthetic progress/);
});
// Runs only on windows-latest. The unit contract double cannot prove that the
// real spawn path and acpx's Windows command resolution see the relocated
// profile/temp/launcher variables, so this asserts them from the child itself.
// Two independent CLI processes share ONE route worker home and use different
// registered workspaces. The synthetic fixture's lock-protected store is what
// makes both sessions resumable; this exercises the REAL pinned acpx spawn path.
async function sharedHomeSetup(t){
 await loadAcpx();
 const f=ownFixture(t,await fixture({argv:[process.execPath,agent],timeoutMs:5000}));
 const cwdB=path.join(f.root,'workspace-b');await fs.mkdir(cwdB,{mode:0o700});
 const orderB=path.join(f.root,'order-b.md');await fs.writeFile(orderB,'Second shared-home job.');
 f.raw.routes.worker.workspaces=[f.cwd,cwdB];
 await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 return {...f,cwdB,orderB};
}
test('REAL acpx: two overlapping processes sharing one worker HOME both resume after restart',async t=>{
 const f=await sharedHomeSetup(t);
 // Start both runs so their lifetimes overlap; each writes its own session.
 const a=start(f,'run',['--route','worker','--cwd',f.cwd,'--file',f.orderFile]);
 const b=start(f,'run',['--route','worker','--cwd',f.cwdB,'--file',f.orderB]);
 const [ra,rb]=[await a.done,await b.done];
 assert.equal(ra.code,0,ra.stderr);assert.equal(rb.code,0,rb.stderr);
 assert.notEqual(ra.receipt.session_id,rb.receipt.session_id);
 // Each original session must still continue in a fresh process (durable state).
 const ca=await command(f,'continue',['--session',ra.receipt.session_id,'--file',f.orderFile]);assert.equal(ca.code,0,ca.stderr);
 const cb=await command(f,'continue',['--session',rb.receipt.session_id,'--file',f.orderB]);assert.equal(cb.code,0,cb.stderr);
 assert.equal(ca.receipt.acp_session_id,ra.receipt.acp_session_id);
 assert.equal(JSON.parse(ca.receipt.output_excerpt).turn,2);
 assert.equal(JSON.parse(cb.receipt.output_excerpt).turn,2);
});
test('REAL acpx: cancelling one shared-home turn does not cancel the other',async t=>{
 const f=await sharedHomeSetup(t);
 await fs.writeFile(f.orderFile,'FIXTURE_WAIT');
 await fs.writeFile(f.orderB,'FIXTURE_WAIT');
 const a=start(f,'run',['--route','worker','--cwd',f.cwd,'--file',f.orderFile]);
 const b=start(f,'run',['--route','worker','--cwd',f.cwdB,'--file',f.orderB]);
 // Wait until BOTH prompts reached the adapter before cancelling one.
 const audit=path.join(f.selection.route.workerHome,'fixture-audit.ndjson');
 await until(async()=>{const log=await fs.readFile(audit,'utf8').catch(()=>'');return (log.match(/session\/prompt/g)??[]).length>=2},'both prompts never reached the adapter');
 const bindings=path.join(f.config.stateDir,'bindings');
 const ids=await until(async()=>{const out=[];for(const e of await fs.readdir(bindings).catch(()=>[])){try{await fs.stat(path.join(bindings,e,'active.lock','owner.json'));out.push(e)}catch{}}return out.length>=2?out:null},'both session locks never appeared');
 const cancel=await command(f,'cancel',['--session',ids[0]]);assert.equal(cancel.code,0,cancel.stderr);
 const done=await Promise.race([a.done.then(r=>({who:'a',r})),b.done.then(r=>({who:'b',r}))]);
 const cancelledId=ids[0];
 // Exactly the cancelled session reports cancelled; the other keeps running or
 // completes on its own and is NOT cancelled.
 assert.equal(done.r.receipt.session_id,cancelledId,`cancelled ${cancelledId} but ${done.r.receipt.session_id} returned first`);
 assert.equal(done.r.receipt.runtime_status,'cancelled');
 const other=done.who==='a'?b:a;
 const otherDone=await other.done;
 // The other turn must not have been cancelled by the first cancel. Distinct
 // session ids alone would ALSO pass a double-cancel, so assert the surviving
 // turn's own terminal state: this fixture's waited turn ends failed by the
 // turn deadline on its own; it must never read cancelled.
 assert.notEqual(otherDone.receipt.session_id,cancelledId);
 assert.notEqual(otherDone.receipt.runtime_status,'cancelled','a single cancel must not cancel the sibling session');
});
test('REAL acpx: batch runs two jobs as real subprocesses and expands decision impacts',async t=>{
 await loadAcpx();
 const f=ownFixture(t,await fixture({argv:[process.execPath,agent],timeoutMs:5000}));
 const cwdB=path.join(f.root,'workspace-b');await fs.mkdir(cwdB,{mode:0o700});
 const orderB=path.join(f.root,'order-b.md');await fs.writeFile(orderB,'Second batch job.');
 f.raw.routes.worker.workspaces=[f.cwd,cwdB];
 f.raw.routes.backup={...f.raw.routes.worker,workerHome:path.join(f.root,'backup-home')};
 await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 const manifest=path.join(f.root,'batch.json');
 await fs.writeFile(manifest,JSON.stringify({schema:'cwr.acp.batch-manifest/1',maxConcurrency:2,jobs:[
  {id:'a',verb:'run',route:'worker',cwd:f.cwd,file:f.orderFile,permissions:'read'},
  {id:'b',verb:'run',route:'backup',cwd:cwdB,file:orderB,permissions:'read'},
 ]}));
 const {code,stderr,receipt}=await command(f,'batch',['--manifest',manifest]);
 assert.equal(code,0,stderr);
 assert.equal(receipt.status,'complete');
 assert.equal(receipt.jobs.length,2);
 for(const j of receipt.jobs){
  assert.ok(j.start_handle,'each job must expose a machine start handle');
  assert.equal(j.runtime_status,'completed');assert.equal(j.cleanup,'confirmed');
  // deliver defaults to true: the synthetic adapter echoes a cwr-delivery block,
  // so each result carries the bounded worker-reported projection. A clean
  // completed+ready result has no candidate follow-up.
  assert.equal(j.delivery_status,'ready');
  assert.equal(j.delivery_excerpt.source,'worker_reported');
  assert.equal(j.delivery_excerpt.summary,'synthetic delivery');
  assert.equal(j.delivery_excerpt.summary_truncated,false);
  assert.equal(j.delivery_excerpt.decision_impacts.total,1);
  assert.deepEqual(j.delivery_excerpt.decision_impacts.affected_targets,['synthetic target']);
  // The DEFAULT terminal keeps the full legacy receipt: no field is dropped.
  assert.ok(Array.isArray(j.delivery_questions),'legacy delivery_questions is preserved');
  assert.ok(Array.isArray(j.artifact_references),'legacy artifact_references is preserved');
  assert.deepEqual(j.next_actions,[]);
 }
 // The durable index reached its terminal status with the same projection…
 const index=JSON.parse(await fs.readFile(receipt.index_path,'utf8'));
 assert.equal(index.status,'complete');
 assert.equal(index.total,2);
 assert.equal(index.results.length,2);
 assert.equal(index.results.find(r=>r.id==='a').delivery_excerpt.summary,'synthetic delivery');
 // …and the read-only collect verb serves it back without loading any adapter.
 const collected=await command(f,'collect',['--batch',receipt.batch_id]);
 assert.equal(collected.code,0,collected.stderr);
 assert.equal(collected.receipt.schema,'cwr.acp.batch-collect/1');
 assert.equal(collected.receipt.status,'complete');
 assert.equal(collected.receipt.total,2);
 assert.equal(collected.receipt.settled,2);
 assert.equal(collected.receipt.outstanding,0);
 assert.equal(collected.receipt.results.find(r=>r.id==='a').delivery_excerpt.summary,'synthetic delivery');
 const impacts=await command(f,'collect',['--batch',receipt.batch_id,'--impacts','a']);
 assert.equal(impacts.code,0,impacts.stderr);
 assert.equal(impacts.receipt.schema,'cwr.acp.batch-impacts/1');
 assert.equal(impacts.receipt.source,'worker_reported');
 assert.equal(impacts.receipt.session_id,receipt.jobs.find(j=>j.id==='a').session_id);
 assert.equal(impacts.receipt.request_id,receipt.jobs.find(j=>j.id==='a').request_id);
 assert.equal(impacts.receipt.impacts[0].target,'synthetic target');
 // The OPTIONAL compact terminal stays within its whole-response byte budget,
 // carries the batch metadata, and its cursor continues through the read verb.
 const budget=8192;
 const compactRun=await command(f,'batch',['--manifest',manifest,'--compact','--limit','1','--max-bytes',String(budget)]);
 assert.equal(compactRun.code,0,compactRun.stderr);
 assert.ok(Buffer.byteLength(compactRun.stdout)<=budget,`compact terminal ${Buffer.byteLength(compactRun.stdout)} must fit ${budget}`);
 assert.equal(compactRun.receipt.schema,'cwr.acp.batch-collect-compact/1');
 assert.equal(compactRun.receipt.status,'complete');
 assert.equal(compactRun.receipt.items.length,1,'the compact terminal returns at least one locatable item');
 assert.equal(compactRun.receipt.page.has_more,true);
 assert.equal(compactRun.receipt.page.limited_by,'limit');
 assert.ok(compactRun.receipt.batch.index_path.endsWith('index.json'));
 const cont=await command(f,'collect',['--batch',compactRun.receipt.batch_id,'--compact','--limit','8','--cursor',compactRun.receipt.next_cursor]);
 assert.equal(cont.code,0,cont.stderr);
 const ids=new Set(compactRun.receipt.items.map(i=>i.id));
 for(const it of cont.receipt.items)ids.add(it.id);
 assert.deepEqual([...ids].sort(),['a','b'],'the continuation page reaches the remaining job');
});

// Runs only on windows-latest. The unit contract double cannot prove that the
// real spawn path and acpx's Windows command resolution see the relocated
// profile/temp/launcher variables, so this asserts them from the child itself.
test('REAL acpx on Windows: the adapter process sees relocated profile, temp and launcher variables',{skip:process.platform!=='win32'},async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);
 const text=JSON.parse(a.receipt.output_excerpt),home=f.selection.route.workerHome;
 assert.equal(text.userprofile,home);
 for(const key of ['appdata','localappdata'])assert.ok(text[key]&&contained(home,text[key]),`${key} must stay under the worker home, got ${text[key]}`);
 assert.equal(path.dirname(text.tmpdir),path.join(f.config.stateDir,'scratch'));
 assert.ok(path.basename(text.tmpdir).length<=22);
 for(const key of ['temp','tmp'])assert.equal(text[key],text.tmpdir,`${key} must use the same session scratch as TMPDIR`);
 const manifest=JSON.parse(await fs.readFile(path.join(text.tmpdir,'.cwr-scratch.json'),'utf8'));
 assert.equal(manifest.session_id,a.receipt.session_id);assert.equal(manifest.home,home);
 assert.ok(text.comspec&&text.pathext&&text.systemroot,'launcher variables must reach the adapter process');
 assert.equal(text.main_marker_present,false);
});
// Runs only on windows-latest. The admitted entry set includes `.cmd`/`.bat`
// because pinned acpx has a %COMSPEC% batch-shim branch; this drives that branch
// with a synthetic wrapper around the fixture agent. Account-free, network-free,
// no generic shell fallback. The wrapper path contains spaces on purpose, so the
// cmd escaping acpx applies to the entry must survive.
test('REAL acpx on Windows: a .cmd entry is launched through the batch-shim branch',{skip:process.platform!=='win32'},async t=>{
 const wrapperRoot=await fs.mkdtemp(path.join(os.tmpdir(),'cwr test cmd '));
 t.after(()=>fs.rm(wrapperRoot,{recursive:true,force:true}));
 const wrapper=path.join(wrapperRoot,'synthetic agent.cmd');
 await fs.writeFile(wrapper,`@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`);
 const f=await setup(t,{argv:[wrapper],timeoutMs:5000});
 const a=await command(f,'run',initial(f));
 assert.equal(a.code,0,a.stderr);
 const text=JSON.parse(a.receipt.output_excerpt);
 assert.equal(text.turn,1);assert.equal(text.home,f.selection.route.workerHome);
 assert.equal(text.main_marker_present,false);assert.equal(a.receipt.cleanup,'confirmed');
});


test('REAL batch: a parent cancellation reaches its child through the canonical nonce mailbox', async t => {
 const f=await setup(t,{timeoutMs:15000});
 await fs.writeFile(f.orderFile,'FIXTURE_PROGRESS_ONLY CANCEL_END_TURN');
 const cwdB=path.join(f.root,'queued');await fs.mkdir(cwdB,{mode:0o700});
 f.raw.routes.worker.workspaces=[f.cwd,cwdB];await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 const manifest=path.join(f.root,'batch-cancel.json');
 await fs.writeFile(manifest,JSON.stringify({schema:'cwr.acp.batch-manifest/1',maxConcurrency:1,jobs:[
  {id:'a',verb:'run',route:'worker',cwd:f.cwd,file:f.orderFile,permissions:'read',deliver:false},
  {id:'b',verb:'run',route:'worker',cwd:cwdB,file:f.orderFile,permissions:'read',deliver:false},
 ]}));
 const result=await command(f,'batch',['--manifest',manifest],path.resolve('test/fixture-batch-cancel.mjs'));
 assert.equal(result.code,1,result.stderr);
 assert.equal(result.receipt.status,'partial');assert.equal(result.receipt.cancelled,true);
 assert.equal(result.receipt.jobs.length,1,'queued work must not launch after cancellation');
 assert.equal(result.receipt.jobs[0].runtime_status,'cancelled');
 assert.equal(result.receipt.jobs[0].cleanup,'confirmed');
 const audit=(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-audit.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(audit.filter(e=>e.method==='session/prompt').length,1);
 assert.ok(audit.some(e=>e.method==='session/cancel'));
 assert.equal(result.receipt.jobs[0].start_handle.phase,'locks_held');
});

// Two batches coexist through the REAL CLI. Each publishes its own start handle
// after the initial index and before any launch, so a caller reads the batch id
// from the handle instead of scanning the private state root. A fast item must be
// collectable through the public compact read while a slow sibling is still
// running, and neither batch may re-read the other's jobs.
test('REAL acpx: two coexisting batches publish start handles and collect without cross-recognition', async t => {
 const f=await ownFixture(t,await fixture({argv:[process.execPath,agent],timeoutMs:60000}));
 const cwdSlow=path.join(f.root,'ws-slow'),cwdSolo=path.join(f.root,'ws-solo');
 await fs.mkdir(cwdSlow,{mode:0o700});await fs.mkdir(cwdSolo,{mode:0o700});
 const orderSlow=path.join(f.root,'order-slow.md');await fs.writeFile(orderSlow,'FIXTURE_PROGRESS_ONLY');
 const orderSolo=path.join(f.root,'order-solo.md');await fs.writeFile(orderSolo,'Second independent batch job.');
 // Three disjoint workspaces and three disjoint worker homes: the batches share
 // no cwd, session lock or HOME, so their coexistence is a real concurrency, not
 // a serialized accident.
 f.raw.routes.worker.workspaces=[f.cwd,cwdSlow,cwdSolo];
 f.raw.routes.backup={...f.raw.routes.worker,workerHome:path.join(f.root,'backup-home')};
 f.raw.routes.solo={...f.raw.routes.worker,workerHome:path.join(f.root,'solo-home')};
 await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 const handleA=path.join(f.root,'a.handle.json'),handleB=path.join(f.root,'b.handle.json');
 const manifestA=path.join(f.root,'batch-a.json');
 await fs.writeFile(manifestA,JSON.stringify({schema:'cwr.acp.batch-manifest/1',maxConcurrency:2,jobs:[
  {id:'fast',verb:'run',route:'worker',cwd:f.cwd,file:f.orderFile,permissions:'read'},
  {id:'slow',verb:'run',route:'backup',cwd:cwdSlow,file:orderSlow,permissions:'read',deliver:false},
 ]}));
 const manifestB=path.join(f.root,'batch-b.json');
 await fs.writeFile(manifestB,JSON.stringify({schema:'cwr.acp.batch-manifest/1',jobs:[
  {id:'solo',verb:'run',route:'solo',cwd:cwdSolo,file:orderSolo,permissions:'read'},
 ]}));
 // Start BOTH real CLI batches without awaiting. Each must publish its handle
 // BEFORE it launches anything.
 const stopFile=path.join(f.root,'cancel-parent.marker');
 const runA=start(f,'batch',['--manifest',manifestA,'--start-handle',handleA],
  process.platform==='win32'?path.resolve('test/fixture-batch-cancel.mjs'):cli,
  process.platform==='win32'?{CWR_TEST_PARENT_CANCEL_FILE:stopFile}:{});
 const runB=start(f,'batch',['--manifest',manifestB,'--start-handle',handleB]);
 const readHandle=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return null}};
 const hA=await until(async()=>{const h=await readHandle(handleA);return h&&h.schema==='cwr.acp.batch-handle/1'?h:null},'batch A must publish its start handle');
 const hB=await until(async()=>{const h=await readHandle(handleB);return h&&h.schema==='cwr.acp.batch-handle/1'?h:null},'batch B must publish its start handle');
 assert.notEqual(hA.batch_id,hB.batch_id,'coexisting batches have distinct ids');
 assert.ok(hA.index_path&&hB.index_path,'each handle locates its own durable index');
 // The fast item settles while the slow sibling is still running. The compact
 // read is the public, bounded coordination path.
 const mid=await until(async()=>{
  const r=await command(f,'collect',['--batch',hA.batch_id,'--compact','--limit','8']);
  if(r.code!==0)return null;
  const resp=r.receipt;
  return resp.items.some(i=>i.id==='fast')&&resp.unresolved.running.includes('slow')?resp:null;
 },'the fast item must be collectable while the slow item still runs',25000);
 assert.equal(mid.batch_id,hA.batch_id);
 assert.equal(mid.status,'running');
 assert.ok(mid.items.every(i=>i.id==='fast'),'batch A returns only its own settled jobs');
 assert.ok(!JSON.stringify(mid).includes(hB.batch_id),'batch A never references batch B');
 assert.ok(!JSON.stringify(mid).includes('solo'),'batch A never leaks batch B job ids');
 // Batch B, running independently, serves only its own job.
 const bDone=await runB.done;
 assert.equal(bDone.code,0,bDone.stderr);
 assert.equal(bDone.receipt.batch_id,hB.batch_id);
 const bCollected=await command(f,'collect',['--batch',hB.batch_id,'--compact']);
 assert.equal(bCollected.code,0,bCollected.stderr);
 assert.ok(bCollected.receipt.items.some(i=>i.id==='solo'));
 assert.ok(bCollected.receipt.items.every(i=>i.id==='solo'),'batch B returns only its own job');
 assert.ok(!JSON.stringify(bCollected.receipt).includes(hA.batch_id),'batch B never references batch A');
 // POSIX delivers the OS signal. Windows force-kills a target via child.kill,
 // so use the existing test-only wrapper to emit the parent handler instead.
 // Both paths must exercise production cancellation and durable settlement.
 if(process.platform==='win32')await fs.writeFile(stopFile,'cancel');
 else runA.child.kill('SIGTERM');
 const aDone=await runA.done;
 assert.equal(aDone.code,1,aDone.stderr);
 assert.equal(aDone.receipt?.status,'partial');
 assert.equal(aDone.receipt?.cancelled,true);
 assert.equal(aDone.receipt.jobs.length,2);
 assert.equal(aDone.receipt.jobs.find(j=>j.id==='slow').runtime_status,'cancelled');
 assert.equal(aDone.receipt.jobs.find(j=>j.id==='slow').cleanup,'confirmed');
 assert.ok(aDone.receipt.jobs.every(j=>['fast','slow'].includes(j.id)),'batch A only ever owns its own jobs');
});
