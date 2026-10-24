// Recovery contracts use synthetic local state and a runtime double only.
// Real public-API timer semantics are separately gated in real-acpx.integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main, parseArgs } from '../src/cli.mjs';
import { executeTurn } from '../src/engine.mjs';
import { loadConfig, selectRoute } from '../src/config.mjs';
import { atomicJSON, digest, loadBinding, paths, readJSON } from '../src/state.mjs';
import { createAdmissionOwner, initializeLifecycleJournal, createLifecycleJournal, recoverExactLockPair } from '../src/lock-recovery.mjs';
import { createProjectionReader } from '../src/dispatch.mjs';
import { fixture, fakeAcpx, deferred, lifecycleEvidence, syntheticEvidence } from './helpers.mjs';
async function setup(t) {
 const f=await fixture();t.after(f.cleanup);f.api=fakeAcpx();f.results=[];f.loads=0;
 f.deps={loadAcpx:async()=>{f.loads++;return f.api},replaceEnvironment:()=>{},output:r=>f.results.push(r),progress:()=>{},processEvidence:f.processEvidence};
 f.run=(mode='read',extra=[])=>main(['run','--config',f.configFile,'--route','worker','--cwd',f.cwd,'--file',f.orderFile,...(mode?['--permissions',mode]:[]),...extra],f.deps);
 f.cont=(id,mode='read')=>main(['continue','--config',f.configFile,'--session',id,'--file',f.orderFile,...(mode?['--permissions',mode]:[])],f.deps);
 f.save=()=>fs.writeFile(f.configFile,JSON.stringify(f.raw));
 f.starts=()=>f.api.calls.filter(c=>c[0]==='start');return f;
}
test('missing run/continue permissions fails before config access, import or any state mutation',async t=>{
 const f=await setup(t);const before=await fs.readdir(f.root,{recursive:true});
 await assert.rejects(f.run(null,['--category','implementation']),{code:'PERMISSIONS_REQUIRED'});
 await assert.rejects(f.cont(f.binding.id,null),{code:'PERMISSIONS_REQUIRED'});
 await assert.rejects(main(['continue','--config',path.join(f.root,'absent'),'--session',f.binding.id,'--file',f.orderFile],f.deps),{code:'PERMISSIONS_REQUIRED'});
 assert.equal(f.loads,0);assert.deepEqual(await fs.readdir(f.root,{recursive:true}),before);
});
test('category never promotes read; explicit full/read/full continues one conversation without inheritance',async t=>{
 const f=await setup(t);await f.run('read',['--category','implementation']);const id=f.results.at(-1).session_id;
 assert.match(f.starts()[0][1].text,/not authorized to modify files/);
 await f.cont(id,'full');await assert.rejects(f.cont(id,null),{code:'PERMISSIONS_REQUIRED'});await f.cont(id,'read');await f.cont(id,'full');
 assert.deepEqual(f.results.map(r=>r.permissions),['read','full','read','full']);
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 assert.equal(new Set(f.starts().map(c=>c[1].handle.backendSessionId)).size,1);
});
test('workspace inventory additions/reordering and task budget changes preserve new execution identity',async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;
 const before=(await loadBinding(f.config.stateDir,id)).executionIdentity;
 const other=path.join(f.root,'other');await fs.mkdir(other);
 f.raw.routes.worker.workspaces=[other,f.cwd];f.raw.routes.worker.timeoutMs=2500;await f.save();await f.cont(id);
 f.raw.routes.worker.workspaces.reverse();await f.save();await f.cont(id);
 assert.deepEqual((await loadBinding(f.config.stateDir,id)).executionIdentity,before);
 assert.equal(f.results.at(-1).budget.task_ms,2500);assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
});
test('current workspace/route revocation stops continuation and preserves control recovery',async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;
 const other=path.join(f.root,'other');await fs.mkdir(other);f.raw.routes.worker.workspaces=[other];await f.save();
 await assert.rejects(f.cont(id),{code:'WORKSPACE_NOT_ALLOWED'});
 f.raw.routes.worker.enabled=false;await f.save();await assert.rejects(f.cont(id),{code:'ROUTE_DISABLED'});
 for(const verb of ['status','close'])assert.equal(await main([verb,'--config',f.configFile,'--session',id],f.deps),0);
 assert.equal(f.starts().length,1);
});
test('full revocation refuses full but an explicit read turn remains authorized on the same identity',async t=>{
 const f=await setup(t);await f.run('full');const id=f.results.at(-1).session_id;
 f.raw.routes.worker.maxPermissions='read';await f.save();
 await assert.rejects(f.cont(id,'full'),{code:'PERMISSION_DENIED'});assert.equal(await f.cont(id,'read'),0);
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
});
for(const [name,change] of [
 ['profile revision',r=>r.contextRevision='synthetic-v2'],
 ['profile arguments',r=>r.argv.push('--synthetic-profile-b')],
 ['explicit model',r=>r.sessionOptions={model:'synthetic-model-b'}],
 ['worker home',(r,f)=>r.workerHome=path.join(f.root,'other-home')],
])test(`execution identity rejects changed ${name}`,async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;change(f.raw.routes.worker,f);await f.save();
 await assert.rejects(f.cont(id),{code:'ROUTE_CHANGED'});assert.equal(f.loads,1);assert.equal(f.starts().length,1);
});
async function makeLegacy(f,id) {
 const binding=await loadBinding(f.config.stateDir,id);
 const selection=await selectRoute(await loadConfig(f.configFile),'worker',f.cwd);
 delete binding.executionIdentity;binding.routeFingerprint=selection.legacyFingerprint;
 await atomicJSON(paths(f.config.stateDir,id).binding,binding);return binding;
}
test('fully matching legacy binding migrates under locks without creating another runtime conversation',async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;const legacy=await makeLegacy(f,id);
 await f.cont(id);const migrated=await loadBinding(f.config.stateDir,id);
 assert.equal(migrated.executionIdentity.schema,'cwr.acp.execution-identity/1');assert.equal(migrated.routeFingerprint,undefined);
 assert.deepEqual(migrated.handle,legacy.handle);assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 const view=await createProjectionReader(f.config.stateDir).detail(id);assert.equal(view.session.turns,2);
});
test('legacy inventory mismatch cannot be guessed away and preserves binding/history unchanged',async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;await makeLegacy(f,id);
 const file=paths(f.config.stateDir,id).binding;const before=await fs.readFile(file,'utf8');
 const other=path.join(f.root,'other');await fs.mkdir(other);f.raw.routes.worker.workspaces.push(other);await f.save();
 await assert.rejects(f.cont(id),{code:'ROUTE_CHANGED'});assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(f.starts().length,1);
 assert.equal(await main(['status','--config',f.configFile,'--session',id],f.deps),0);
 assert.equal((await createProjectionReader(f.config.stateDir).detail(id)).session.turns,1);
});
test('authorization revoked during preflight is rechecked under locks before legacy migration or prompt',async t=>{
 const f=await setup(t);await f.run('full');const id=f.results.at(-1).session_id;await makeLegacy(f,id);
 const file=paths(f.config.stateDir,id).binding,before=await fs.readFile(file,'utf8');
 f.deps.loadAcpx=async()=>{f.raw.routes.worker.maxPermissions='read';await f.save();return f.api};
 await assert.rejects(f.cont(id,'full'),{code:'PERMISSION_DENIED'});
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(f.starts().length,1);
 await assert.rejects(fs.stat(paths(f.config.stateDir,id).lock),{code:'ENOENT'});
});
test('unregistered worktree-shaped cwd has no new state, runtime or receipt',async t=>{
 const f=await setup(t);const cwd=path.join(f.root,'worktree');await fs.mkdir(cwd);
 const before=await fs.readdir(f.root,{recursive:true});
 await assert.rejects(main(['run','--config',f.configFile,'--route','worker','--cwd',cwd,'--file',f.orderFile,'--permissions','full'],f.deps),{code:'WORKSPACE_NOT_ALLOWED'});
 assert.equal(f.loads,0);assert.deepEqual(await fs.readdir(f.root,{recursive:true}),before);
});

// Exercise the independent promises exposed by the public runtime contract.
// No process is spawned: the base double provides lifecycle admission/exit.
async function controlled(t,kind) {
 const f=await fixture({timeoutMs:100});f.processEvidence=lifecycleEvidence(f.syntheticPid);t.after(f.cleanup);const api=fakeAcpx(),create=api.createAcpRuntime.bind(api);
 const began=deferred(),release=deferred();let cancels=0;let optionsSeen;
 api.createAcpRuntime=options=>{
  const runtime=create(options),close=runtime.close.bind(runtime),result=deferred(),stream=deferred(),sent=deferred();
  runtime.startTurn=input=>{
   optionsSeen=input;began.resolve();
   if(!['setup','slow-submit'].includes(kind))sent.resolve();
   if(kind==='abort')input.signal.addEventListener('abort',()=>{result.resolve({status:'completed',stopReason:'end_turn'});stream.resolve()},{once:true});
   if(kind==='slow-submit'){
    release.promise.then(()=>{sent.resolve();setTimeout(()=>{result.resolve({status:'completed',stopReason:'end_turn'});stream.resolve()},55)});
   }
   if(kind==='stream-error')result.resolve({status:'completed',stopReason:'end_turn'});
   if(kind==='stream-stuck')result.resolve({status:'completed',stopReason:'end_turn'});
   if(kind==='finalization')stream.resolve();
   return {promptStarted:sent.promise,result:result.promise,events:{async *[Symbol.asyncIterator](){
    yield {type:'text_delta',stream:'output',text:'Synthetic partial progress.'};
    if(kind==='stream-error')throw Object.assign(new Error('synthetic stream'),{code:'STREAM_ERROR'});
    if(kind==='recent-activity'){
     while(await Promise.race([stream.promise.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),10))]))
      yield {type:'tool_call',title:'PRIVATE_TOOL_TITLE',rawInput:{path:'/synthetic/private'},rawOutput:'PRIVATE_TOOL_OUTPUT'};
    }
    await stream.promise;
    if(kind==='late-stream')yield {type:'tool_call',title:'late cleanup event'};
   }},cancel:async()=>{cancels++;if(kind!=='unsettled')result.resolve({status:'completed',stopReason:'end_turn'})},closeStream:async()=>stream.resolve()};
  };
  runtime.close=async input=>{
    stream.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    await close(input);
    // The controlled double never enters the base startTurn path, so the
    // synthetic adapter remains observable unless this close explicitly
    // reports the exit. This mirrors the real public lifecycle event.
    if(f.processEvidence.state.rows.has(f.syntheticPid)) f.processEvidence.remove(f.syntheticPid);
  };
  return runtime;
 };
 return {...f,api,began,release,cancels:()=>cancels,input:()=>optionsSeen};
}
let journalSerial=0;
const engineRun=async(f,extra={})=>{
 const requestId=`00000000-0000-0000-0000-${String(++journalSerial).padStart(12,'0')}`;
 const workspaceKey=digest(f.cwd);
 const owner=await createAdmissionOwner({session:f.binding.id,requestId,cwd:f.cwd,route:'worker',permissions:'read',workspaceKey,processEvidence:f.processEvidence});
 await initializeLifecycleJournal({config:f.config,owner});
 const lifecycleJournal=createLifecycleJournal({config:f.config,owner});
 return executeTurn({config:f.config,selection:f.selection,binding:f.binding,text:'synthetic only',isNew:true,acpx:f.api,cleanupMs:80,requestId,
  lifecycleJournal,processEvidence:f.processEvidence,...extra});
};
test('deadline is monotonic across cooperative end_turn, late stream, and cleanup',async t=>{
 const f=await controlled(t,'late-stream');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(r.stop_reason,null);assert.equal(r.cleanup,'confirmed');
 assert.equal(f.cancels(),1);assert.equal(f.input().timeoutMs,0);assert.match(r.output_excerpt,/partial progress/);
 // Local deadlines stay in receipt.error_code, never misattributed to acpx.
 assert.equal(r.observations.coverage,'none');
 assert.equal(r.activity.last_event_type,'text_delta','cleanup events cannot replace the activity snapshot at failure');
 assert.equal(r.activity.event_count,1);
});
test('hard task deadline retains recent runtime activity without extending the budget or exposing tool payloads',async t=>{
 const f=await controlled(t,'recent-activity');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(f.cancels(),1);
 assert.equal(r.budget.task_ms,100);assert.equal(Date.parse(r.budget.task_deadline_at)-Date.parse(r.budget.prompt_started_at),100);
 assert.ok(r.budget.task_elapsed_ms>=90);assert.ok(r.budget.task_elapsed_ms<1000);
 assert.ok(r.activity.event_count>1);assert.equal(r.activity.last_event_type,'tool_call');
 assert.ok(r.activity.last_event_age_ms<r.budget.task_elapsed_ms/2);
 assert.ok(Date.parse(r.activity.last_event_at)>=Date.parse(r.activity.first_event_at));
 assert.ok(Date.parse(r.activity.observed_at)>=Date.parse(r.activity.last_event_at));
 for(const hidden of ['PRIVATE_TOOL_TITLE','PRIVATE_TOOL_OUTPUT','/synthetic/private'])assert.ok(!JSON.stringify(r).includes(hidden));
});
test('the same hard deadline reports a long event gap when only initial progress was observed',async t=>{
 const f=await controlled(t,'finalization');const r=await engineRun(f);
 assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(r.activity.event_count,1);
 assert.equal(r.activity.first_event_at,r.activity.last_event_at);assert.ok(r.activity.last_event_age_ms>=80);
 assert.ok(r.activity.last_event_age_ms>=r.budget.task_elapsed_ms*0.8);
});
test('operator abort cannot be relabelled completed by cooperative end_turn',async t=>{
 const f=await controlled(t,'abort'),controller=new AbortController();const promise=engineRun(f,{signal:controller.signal});
 await f.began.promise;controller.abort();const r=await promise;
 assert.equal(r.runtime_status,'cancelled');assert.equal(r.error_code,'CANCEL_REQUESTED');assert.equal(r.cleanup,'confirmed');
});
test('submission has a separate setup deadline and records no prompt timestamp when never written',async t=>{
 const f=await controlled(t,'setup');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'PROMPT_SETUP_TIMEOUT');assert.equal(r.budget.prompt_started_at,null);assert.equal(r.cleanup,'confirmed');
 assert.equal(r.budget.task_deadline_at,null);assert.equal(r.budget.task_elapsed_ms,null);
});
test('task budget begins at promptStarted instead of consuming submission time',async t=>{
 const f=await controlled(t,'slow-submit');const promise=engineRun(f);await f.began.promise;
 await new Promise(resolve=>setTimeout(resolve,65));f.release.resolve();const r=await promise;
 assert.equal(r.runtime_status,'completed');assert.equal(r.error_code,null);assert.ok(r.budget.prompt_started_at);
});
test('a stream failure wins even if a canonical success has already arrived',async t=>{
 const f=await controlled(t,'stream-error');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'STREAM_ERROR');assert.equal(r.cleanup,'confirmed');
});
test('unsettled timed-out turn never claims confirmed cleanup',async t=>{
 const f=await controlled(t,'unsettled');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(r.cleanup,'unconfirmed');
});
test('canonical result finalization is inside the task budget even after the event stream ends',async t=>{
 const f=await controlled(t,'finalization');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(r.cleanup,'confirmed');
});
test('a completed canonical result with a stuck stream gets a bounded stream error, not success',async t=>{
 const f=await controlled(t,'stream-stuck');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'STREAM_TIMEOUT');assert.equal(r.cleanup,'confirmed');assert.equal(f.cancels(),1);
});

// Build a same-boot postlaunch record. Absence from a process census is not
// complete stop proof because ordinary PTY tools can escape the CLI group.
async function stoppedLockPair(t,{retain='none',prelaunch=false}={}) {
 const f=await setup(t);
 f.processEvidence=syntheticEvidence({groupOwner:process.pid,alive:[{pid:process.pid}]});
 f.processEvidence.groupState.live.add(process.pid);
 const claimant=f.processEvidence;
 const ownerPid=f.syntheticPid-1,adapterPid=f.syntheticPid,childPid=f.syntheticPid+1;
 f.processEvidence.add(ownerPid,process.pid);
 f.processEvidence.add(adapterPid,ownerPid);
 f.processEvidence.add(childPid,adapterPid);
 const requestId=`10000000-0000-0000-0000-${String(++journalSerial).padStart(12,'0')}`;
 const workspaceKey=digest(f.cwd);
 const priorOwner=await createAdmissionOwner({session:f.binding.id,requestId,cwd:f.cwd,route:'worker',permissions:'read',workspaceKey,processEvidence:f.processEvidence,ownerPid});
 const p=paths(f.config.stateDir,f.binding.id);
 await atomicJSON(path.join(f.config.stateDir,'workspace-locks',workspaceKey,'owner.json'),priorOwner);
 await atomicJSON(path.join(p.lock,'owner.json'),priorOwner);
 await initializeLifecycleJournal({config:f.config,owner:priorOwner});
 const journal=createLifecycleJournal({config:f.config,owner:priorOwner});
 await journal.admitted('synthetic-launch');
 if(!prelaunch){
  await journal.spawned({launchId:'synthetic-launch',process:f.processEvidence.state.rows.get(adapterPid)});
 }
 // An observed descendant also records its current ancestry. This mirrors the
 // public lifecycle hook and lets a retained child remain identifiable after
 // its root exits.
 if(!prelaunch)
  await journal.descendants({launchId:'synthetic-launch',processes:[f.processEvidence.state.rows.get(adapterPid),f.processEvidence.state.rows.get(childPid)]});
 // Owner and adapter are gone; PID is absent, with no exit receipt. This is
 // deliberately stronger than relying on the lifecycle exit callback.
 // The synthetic CLI's lock-owner PID is gone; retaining only its adapter
 // child leaves no live owner identity but still blocks automatic recovery.
 const group=f.processEvidence.groupState;
 if(prelaunch)await journal.spawnFailed('synthetic-launch');
 group.live.add(ownerPid);
 f.processEvidence.remove(ownerPid);
 if(retain==='none'){f.processEvidence.remove(adapterPid);f.processEvidence.remove(childPid);group.live.delete(ownerPid)}
 else f.processEvidence.add(adapterPid,1,'adapter-root-retained');
 f.processEvidence=claimant;
 return {...f,priorOwner,workspaceKey,journal};
}

test('normal continue reaches one original-conversation launch after exact coordinator reconciliation',async t=>{
 const f=await setup(t);await f.run();const id=f.results.at(-1).session_id;
 // Restore the claimant's readable process identity after constructing the
 // synthetic stale owner/adapter record.
 const binding=(await loadBinding(f.config.stateDir,id)).handle;
 const receiptBefore=f.results.at(-1);
 const requestId='10000000-0000-0000-0000-000000000001',workspaceKey=digest(f.cwd);
 const normalizedEvidence=(f.processEvidence.state.rows.get(process.pid)?.start??'').startsWith('synthetic-')
  ? f.processEvidence : (await import('./helpers.mjs')).syntheticEvidence({alive:[{pid:process.pid}]});
 f.processEvidence=normalizedEvidence;
 const priorOwner=await createAdmissionOwner({session:id,requestId,cwd:f.cwd,route:'worker',permissions:'read',workspaceKey,processEvidence:f.processEvidence});
 const p=paths(f.config.stateDir,id);
 await atomicJSON(path.join(f.config.stateDir,'workspace-locks',workspaceKey,'owner.json'),priorOwner);
 await atomicJSON(path.join(p.lock,'owner.json'),priorOwner);
 await initializeLifecycleJournal({config:f.config,owner:priorOwner});
 const journal=createLifecycleJournal({config:f.config,owner:priorOwner});
 await journal.admitted('stopped-launch');
 await journal.spawned({launchId:'stopped-launch',process:f.processEvidence.state.rows.get(f.syntheticPid)});
 f.processEvidence.groupState.live.delete(process.pid);
 f.processEvidence.remove(f.syntheticPid);
 f.processEvidence.add(process.pid,null,'claimant');
 const startsBefore=f.starts().length;
 const inspected=[];
 const call=(args,deps)=>main(args,{...f.deps,...deps,output:r=>inspected.push(r)});
 assert.equal(await call(['recover','--config',f.configFile,'--session',id]),3);
 assert.equal(inspected.at(-1).condition,'same_boot_scope_uncertain');
 assert.equal(await call(['recover','--config',f.configFile,'--session',id,'--attest-stopped',
  '--confirm',inspected.at(-1).confirmation]),0);
 assert.equal(await f.cont(id),0);
 assert.equal(f.starts().length,startsBefore+1,'safe recovery must issue exactly one new turn');
 assert.equal(f.starts().at(-1)[1].handle.backendSessionId,binding.backendSessionId,'continuation stays in the original conversation');
 const records=await fs.readdir(path.join(f.config.stateDir,'recovery-records',id));
 assert.equal(records.length,1);
 const record=JSON.parse(await fs.readFile(path.join(f.config.stateDir,'recovery-records',id,records[0]),'utf8'));
 assert.equal(record.status,'quarantined');assert.equal(record.prior_task_outcome,'unknown');assert.equal(record.order_replayed,false);
 assert.ok(await fs.stat(record.quarantine.session));assert.ok(await fs.stat(record.quarantine.workspace));
 assert.equal((await loadBinding(f.config.stateDir,id)).handle.backendSessionId,binding.backendSessionId);
 assert.equal(JSON.parse(await fs.readFile(receiptBefore.receipt_path,'utf8')).runtime_status,receiptBefore.runtime_status);
});

test('normal run identifies the exact stale cwd lock, reconciles it, and issues one new responsibility prompt',async t=>{
 const f=await setup(t);await f.run();const prior=f.results.at(-1);
 const requestId='10000000-0000-0000-0000-000000000002',workspaceKey=digest(f.cwd);
 const owner=await createAdmissionOwner({session:prior.session_id,requestId,cwd:f.cwd,route:'worker',permissions:'read',workspaceKey,processEvidence:f.processEvidence});
 const p=paths(f.config.stateDir,prior.session_id);
 await atomicJSON(path.join(f.config.stateDir,'workspace-locks',workspaceKey,'owner.json'),owner);
 await atomicJSON(path.join(p.lock,'owner.json'),owner);
 await initializeLifecycleJournal({config:f.config,owner});
 const journal=createLifecycleJournal({config:f.config,owner});
 await journal.admitted('stopped-run');await journal.spawned({launchId:'stopped-run',process:f.processEvidence.state.rows.get(f.syntheticPid)});
 f.processEvidence.groupState.live.delete(process.pid);
 f.processEvidence.remove(f.syntheticPid);
 f.processEvidence.add(process.pid,null,'claimant');
 const startsBefore=f.starts().length;
 const inspected=[];
 const call=(args)=>main(args,{...f.deps,output:r=>inspected.push(r)});
 assert.equal(await call(['recover','--config',f.configFile,'--session',prior.session_id]),3);
 assert.equal(await call(['recover','--config',f.configFile,'--session',prior.session_id,'--attest-stopped',
  '--confirm',inspected.at(-1).confirmation]),0);
 assert.equal(await f.run(),0);
 assert.equal(f.starts().length,startsBefore+1);
 assert.notEqual(f.results.at(-1).session_id,prior.session_id,'new run must create a new responsibility, never replay');
 assert.ok((await fs.readdir(path.join(f.config.stateDir,'recovery-records'))).length>=1);
});

test('live adapter, PID reuse and changed-host boot evidence never become unsafe automatic recovery',async t=>{
 const scenarios=[];
 for(const variant of ['adapter-live','owner-live','pid-reuse','boot-changed']){
  const f=await stoppedLockPair(t);
  const p=paths(f.config.stateDir,f.binding.id);
  if(variant==='boot-changed')f.processEvidence.state.boot='synthetic-boot/2';
  const result=await main(['recover','--config',f.configFile,'--session',f.binding.id],f.deps);
  assert.equal(result,3);
  const view=f.results.at(-1);
  assert.equal(view.state,'uncertain',variant);
  assert.equal(view.automatic_recovery,false,variant);
  assert.equal(view.confirmation.length,64);
  assert.ok(await fs.stat(p.lock),'inspection never removes the lock');
  scenarios.push(variant);
 }
 assert.equal(scenarios.length,4);
});

test('prelaunch recovery requires a durable journal that cannot have admitted an adapter launch',async t=>{
 const f=await stoppedLockPair(t,{prelaunch:true});
 const first=await main(['recover','--config',f.configFile,'--session',f.binding.id],f.deps);
 assert.equal(first,0);
 const view=f.results.at(-1);
 assert.equal(view.state,'recoverable');
 assert.equal(view.condition,'prelaunch_interruption');
 assert.equal(view.automatic_recovery,true);
 assert.equal(view.evidence.scope,'all admitted launches failed before spawn and the verified owner stopped');
 // A second inspection remains read-only; it does not create a second
 // recovery record just because the first inspection was automatic.
 const records=await fs.readdir(path.join(f.config.stateDir,'recovery-records',f.binding.id)).catch(()=>[]);
 assert.equal(records.length,0);
 const again=await main(['recover','--config',f.configFile,'--session',f.binding.id],{...f.deps,output:r=>{f.results.push(r)}});
 assert.equal(again,0,'inspection remains readonly before explicit recovery');
 assert.equal(f.results.at(-1).state,'recoverable');
});

test('a retained descendant with a dead adapter root stays explicit and requires stopped attestation',async t=>{
 const f=await stoppedLockPair(t,{retain:'child'});
 const p=paths(f.config.stateDir,f.binding.id);
 let view;
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],
  {...f.deps,processEvidence:f.processEvidence,output:r=>{view=r}}),3);
 assert.equal(view.state,'uncertain');
 assert.ok(['adapter_live','same_boot_scope_uncertain'].includes(view.condition));
 if(view.condition==='adapter_live')
  assert.ok(view.evidence.observed_live_processes.some(x=>x.pid===f.syntheticPid+1));
 assert.ok(await fs.stat(p.lock));assert.ok(f.processEvidence.state.rows.has(f.syntheticPid+1),'recovery never kills processes');
 if(view.condition==='adapter_live'){
  await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id,'--attest-stopped','--confirm',view.confirmation],
   {...f.deps,processEvidence:f.processEvidence}),{code:'RECOVERY_BLOCKED'});
  assert.ok(await fs.stat(p.lock),'known-live evidence cannot be overridden by attestation');
 }
 assert.ok(f.processEvidence.state.rows.has(f.syntheticPid+1));
});

test('legacy evidence requires a fresh exact confirmation and cannot claim a completed outcome',async t=>{
 const f=await setup(t);const p=paths(f.config.stateDir,f.binding.id);
 const owner={nonce:'00000000-0000-0000-0000-000000000004',pid:f.syntheticPid-1,session:f.binding.id,startedAt:new Date().toISOString()};
 await atomicJSON(path.join(f.config.stateDir,'workspace-locks',digest(f.cwd),'owner.json'),owner);
 await atomicJSON(path.join(p.lock,'owner.json'),owner);
 let seen;
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],{...f.deps,output:r=>{seen=r}}),3);
 assert.equal(seen.condition,'legacy_evidence');assert.equal(seen.state,'uncertain');
 await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id,'--attest-stopped','--confirm','0'.repeat(64)],f.deps),{code:'RECOVERY_CONFIRMATION_MISMATCH'});
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id,'--attest-stopped','--confirm',seen.confirmation],{...f.deps,output:r=>{seen=r}}),0);
 assert.equal(seen.prior_task_outcome,'unknown');assert.equal(seen.execution_stop,'operator_reconciled');
 assert.equal(await fs.stat(p.lock).then(()=>true,()=>false),false);
});

test('immutable recovery claims reject a live contender before any lock move',async t=>{
 const f=await stoppedLockPair(t);
 f.processEvidence.state.uncertain=true;
 f.processEvidence.remove(process.pid);
 const p=paths(f.config.stateDir,f.binding.id),workspaceLock=path.join(f.config.stateDir,'workspace-locks',digest(f.cwd));
 // A live contender has a unique immutable claim path. Recovery must wait/refuse
 // without renaming, removing or reusing it.
 const claims=path.join(f.config.stateDir,'recovery-claims');
 const contender=path.join(claims,'00000000-0000-0000-0000-000000000005.json');
 const liveIdentity=await f.processEvidence.identity(process.pid);
 await atomicJSON(contender,{schema:'cwr.acp.recovery-claim/1',fence_id:'00000000-0000-0000-0000-000000000005',
  ticket:1,choosing:false,created_at:new Date().toISOString(),boot:f.processEvidence.state.boot,
  owner:{identity:liveIdentity}});
 await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id,'--attest-stopped','--confirm','0'.repeat(64)],{...f.deps,processEvidence:f.processEvidence}),{code:'RECOVERY_IN_PROGRESS'});
 assert.ok(await fs.stat(contender),'a live claim path is never stolen');
 assert.ok(await fs.stat(p.lock));assert.ok(await fs.stat(workspaceLock));
});

test('recover CLI idle inspection is read-only and malformed/unknown options fail before recovery',async t=>{
 const f=await setup(t);
 const before=await fs.readdir(f.config.stateDir,{recursive:true});
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],f.deps),0);
 assert.deepEqual(await fs.readdir(f.config.stateDir,{recursive:true}),before);
 assert.throws(()=>parseArgs(['recover','--config','c','--session','s','--attest-stopped']),{code:'USAGE'});
 assert.throws(()=>parseArgs(['recover','--config','c','--session','s','--confirm','x']),{code:'USAGE'});
 assert.throws(()=>parseArgs(['recover','--config','c','--session','s','--confirm','a'.repeat(64)]),{code:'USAGE'});
});

test('read-only inspection derives a stable evidence-bound confirmation, and changed evidence refuses mutation',async t=>{
 const f=await stoppedLockPair(t);
 f.processEvidence.state.uncertain=true;
 const p=paths(f.config.stateDir,f.binding.id);
 let view;
 // The synthetic census remains readable but has no live execution identity;
 // same-boot absence is still not stop proof.
 const before=await fs.readdir(f.config.stateDir,{recursive:true});
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],
  {...f.deps,processEvidence:f.processEvidence,output:r=>{view=r}}),3);
 assert.deepEqual(await fs.readdir(f.config.stateDir,{recursive:true}),before,
  'inspection creates no challenge, claim or other state');
 // Change the journal after inspection. The old confirmation must fail closed
 // even though the pair still exists.
 const lifecycle=JSON.parse(await fs.readFile(path.join(p.dir,'lifecycle',`${f.priorOwner.request_id}.json`),'utf8'));
 lifecycle.records.push({kind:'descendants',at:new Date().toISOString(),launch_id:'synthetic-launch',processes:[]});
 await atomicJSON(path.join(p.dir,'lifecycle',`${f.priorOwner.request_id}.json`),lifecycle);
 await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id,
  '--attest-stopped','--confirm',view.confirmation],f.deps),
  {code:'RECOVERY_BLOCKED'});
 assert.ok(await fs.stat(p.lock));
});


async function interruptedQuarantine(t) {
 const f=await stoppedLockPair(t,{prelaunch:true});
 const workspaceLock=path.join(f.config.stateDir,'workspace-locks',digest(f.cwd));
 const rename=fs.rename;
 fs.rename=async(from,to)=>{
  if(from===workspaceLock)throw Object.assign(new Error('synthetic second-rename interruption'),{code:'EIO'});
  return rename(from,to);
 };
 try {
  await assert.rejects(recoverExactLockPair({config:f.config,binding:f.binding,processEvidence:f.processEvidence}),{code:'QUARANTINE_FAILED'});
 } finally {fs.rename=rename}
 const recordsDir=path.join(f.config.stateDir,'recovery-records',f.binding.id);
 const recordFile=path.join(recordsDir,(await fs.readdir(recordsDir))[0]);
 const record=await readJSON(recordFile,{privateFile:true});
 assert.equal(record.status,'partial');
 assert.ok(record.partial.session_quarantined);
 return {...f,workspaceLock,recordFile,record};
}
test('partial quarantine resumes only the exact recorded second rename and preserves history',async t=>{
 const f=await interruptedQuarantine(t),p=paths(f.config.stateDir,f.binding.id);
 const history=await fs.readFile(p.binding,'utf8');
 let view;
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],
  {...f.deps,output:r=>{view=r}}),3);
 assert.equal(view.condition,'recovery_partial_resumable');
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id,'--attest-stopped','--confirm',view.confirmation],f.deps),0);
 assert.equal((await readJSON(f.recordFile,{privateFile:true})).status,'quarantined');
 assert.ok(await fs.stat(f.record.quarantine.workspace));
 assert.equal(await fs.readFile(p.binding,'utf8'),history);
 assert.equal(await main(['recover','--config',f.configFile,'--session',f.binding.id],{...f.deps,output:r=>{view=r}}),0);
 assert.equal(view.state,'idle');
});
test('a changed workspace owner blocks partial resume without rolling back',async t=>{
 const f=await interruptedQuarantine(t);
 const file=path.join(f.workspaceLock,'owner.json');
 const old=await readJSON(file,{privateFile:true});
 const changed={...old,nonce:'00000000-0000-0000-0000-000000000099'};
 await atomicJSON(file,changed);
 await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id],f.deps),{code:'LOCK_PAIR_MISMATCH'});
 assert.deepEqual(await readJSON(file,{privateFile:true}),changed);
 assert.ok(await fs.stat(f.record.quarantine.session));
});
test('changed durable partial target invalidates the old confirmation without moving a lock',async t=>{
 const f=await interruptedQuarantine(t);let view;
 await main(['recover','--config',f.configFile,'--session',f.binding.id],{...f.deps,output:r=>{view=r}});
 const record=await readJSON(f.recordFile,{privateFile:true});
 record.quarantine.workspace+='-changed';await atomicJSON(f.recordFile,record);
 await assert.rejects(main(['recover','--config',f.configFile,'--session',f.binding.id,
  '--attest-stopped','--confirm',view.confirmation],f.deps),{code:'RECOVERY_BLOCKED'});
 assert.ok(await fs.stat(f.workspaceLock));
 await assert.rejects(fs.stat(record.quarantine.workspace),{code:'ENOENT'});
});
test('a fresh partial inspection cannot bless a changed original binding',async t=>{
 const f=await interruptedQuarantine(t),p=paths(f.config.stateDir,f.binding.id);let view;
 await atomicJSON(p.binding,{...f.binding,handle:{backendSessionId:'changed-conversation'}});
 await main(['recover','--config',f.configFile,'--session',f.binding.id],{...f.deps,output:r=>{view=r}});
 assert.equal(view.state,'uncertain');assert.equal(view.attestation_allowed,false);
 assert.equal(view.confirmation,undefined);assert.ok(await fs.stat(f.workspaceLock));
});
