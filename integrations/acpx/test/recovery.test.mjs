// Recovery contracts use synthetic local state and a runtime double only.
// Real public-API timer semantics are separately gated in real-acpx.integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { executeTurn } from '../src/engine.mjs';
import { loadConfig, selectRoute } from '../src/config.mjs';
import { atomicJSON, loadBinding, paths } from '../src/state.mjs';
import { createProjectionReader } from '../src/dispatch.mjs';
import { fixture, fakeAcpx, deferred } from './helpers.mjs';
async function setup(t) {
 const f=await fixture();t.after(f.cleanup);f.api=fakeAcpx();f.results=[];f.loads=0;
 f.deps={loadAcpx:async()=>{f.loads++;return f.api},replaceEnvironment:()=>{},output:r=>f.results.push(r),progress:()=>{}};
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
 const f=await fixture({timeoutMs:100});t.after(f.cleanup);const api=fakeAcpx(),create=api.createAcpRuntime.bind(api);
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
   return {promptStarted:sent.promise,result:result.promise,events:{async *[Symbol.asyncIterator](){yield {type:'text_delta',stream:'output',text:'Synthetic partial progress.'};if(kind==='stream-error')throw Object.assign(new Error('synthetic stream'),{code:'STREAM_ERROR'});await stream.promise}},cancel:async()=>{cancels++;if(kind!=='unsettled')result.resolve({status:'completed',stopReason:'end_turn'})},closeStream:async()=>stream.resolve()};
  };
  runtime.close=async input=>{stream.resolve();await new Promise(resolve=>setImmediate(resolve));await close(input)};
  return runtime;
 };
 return {...f,api,began,release,cancels:()=>cancels,input:()=>optionsSeen};
}
const engineRun=(f,extra={})=>executeTurn({config:f.config,selection:f.selection,binding:f.binding,text:'synthetic only',isNew:true,acpx:f.api,cleanupMs:80,...extra});
test('deadline is monotonic across cooperative end_turn, late stream, and cleanup',async t=>{
 const f=await controlled(t,'late-stream');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'TURN_TIMEOUT');assert.equal(r.stop_reason,null);assert.equal(r.cleanup,'confirmed');
 assert.equal(f.cancels(),1);assert.equal(f.input().timeoutMs,0);assert.match(r.output_excerpt,/partial progress/);
 // Local deadlines stay in receipt.error_code, never misattributed to acpx.
 assert.equal(r.observations.coverage,'none');
});
test('operator abort cannot be relabelled completed by cooperative end_turn',async t=>{
 const f=await controlled(t,'abort'),controller=new AbortController();const promise=engineRun(f,{signal:controller.signal});
 await f.began.promise;controller.abort();const r=await promise;
 assert.equal(r.runtime_status,'cancelled');assert.equal(r.error_code,'CANCEL_REQUESTED');assert.equal(r.cleanup,'confirmed');
});
test('submission has a separate setup deadline and records no prompt timestamp when never written',async t=>{
 const f=await controlled(t,'setup');const r=await engineRun(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'PROMPT_SETUP_TIMEOUT');assert.equal(r.budget.prompt_started_at,null);assert.equal(r.cleanup,'confirmed');
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
