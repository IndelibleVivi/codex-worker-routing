import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTurn, closeBinding, validateResume, workOrder, runtimeOptions } from '../src/engine.mjs';
import { readJSON, paths } from '../src/state.mjs';
import { fixture, fakeAcpx } from './helpers.mjs';
async function setup(t,behavior={}){const f=await fixture();t.after(f.cleanup);return {...f,api:fakeAcpx(behavior)}}
const run=(f,extra={})=>executeTurn({config:f.config,selection:f.selection,binding:f.binding,text:'Fix the fixture.',isNew:true,acpx:f.api,...extra});

test('new work creates one persistent session; canonical result and cleanup are separate',async t=>{
 const f=await setup(t);const r=await run(f);
 assert.equal(r.runtime_status,'completed');assert.equal(r.cleanup,'confirmed');assert.equal(r.task_acceptance,'unverified');
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 assert.equal(f.api.calls.find(c=>c[0]==='ensure')[1].mode,'persistent');
 assert.equal(r.adapter_reported_session_usage,null);assert.equal(r.adapter_reported_per_request_usage_omitted,false);assert.equal(r.provider_identity_verified,false);
 assert.equal((await readJSON(r.receipt_path,{privateFile:true})).request_id,r.request_id);
});
test('continue does not call ensure/new and uses the exact stored handle',async t=>{
 const f=await setup(t);await run(f);const id=f.binding.handle.backendSessionId;
 await run(f,{isNew:false,text:'Keep legacy behavior too.'});
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 assert.equal(f.api.calls.filter(c=>c[0]==='start').length,2);
 assert.equal(f.binding.handle.backendSessionId,id);
});
test('read-to-full increment reuses the same conversation but new permissions',async t=>{
 const f=await setup(t);await run(f);
 const r=await run(f,{isNew:false,selection:{...f.selection,permissions:'full'}});
 assert.equal(r.permissions,'full');assert.equal(f.api.calls.at(-2)?.[0],'start');
 assert.equal(f.api.calls.filter(c=>c[0]==='start').at(-1)[2].permissionMode,'approve-all');
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
});
test('missing saved ACP state fails before a prompt and never creates a replacement',async t=>{
 const f=await setup(t);await run(f);f.api.records.clear();
 const r=await run(f,{isNew:false});assert.equal(r.error_code,'CONTINUITY_LOST');assert.equal(r.runtime_status,'failed');
 assert.equal(f.api.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
});
test('mutated record command is rejected before execution',async t=>{
 const f=await setup(t);await run(f);f.api.records.get(f.binding.handle.acpxRecordId).agentArgv=['/different'];
 const r=await run(f,{isNew:false});assert.equal(r.error_code,'ROUTE_CHANGED');assert.equal(f.api.calls.filter(c=>c[0]==='start').length,1);
});
test('oneshot handle corruption cannot enable allow-new fallback',async t=>{
 const f=await setup(t);await run(f);f.binding.handle.runtimeSessionName=JSON.stringify({mode:'oneshot',acpxRecordId:f.binding.handle.acpxRecordId});
 const r=await run(f,{isNew:false});assert.equal(r.error_code,'UNSAFE_HANDLE');assert.equal(f.api.calls.filter(c=>c[0]==='start').length,1);
});
test('route fingerprint change rejects continuation',async t=>{
 const f=await setup(t);await run(f);
 const r=await run(f,{isNew:false,selection:{...f.selection,fingerprint:'changed'}});assert.equal(r.error_code,'ROUTE_CHANGED');
});
test('raw thought and tool output are excluded; output excerpt is bounded',async t=>{
 const f=await setup(t,{events:[{type:'text_delta',stream:'thought',text:'DO_NOT_RETURN'},{type:'tool_call',text:'RAW_SECRET'},{type:'text_delta',text:'x'.repeat(20000)}]});
 const r=await run(f);assert.equal(r.output_excerpt.length,8192);assert.equal(r.output_truncated,true);assert.ok(!JSON.stringify(r).includes('DO_NOT_RETURN'));assert.ok(!JSON.stringify(r).includes('RAW_SECRET'));
});
test('closing observation does not call cancel and still awaits the canonical result',async t=>{
 const f=await setup(t,{delay:30});const start=Date.now();
 const r=await run(f,{observer:async(e,turn)=>{await turn.closeStream()}});
 assert.equal(r.runtime_status,'completed');assert.equal(f.api.calls.filter(c=>c[0]==='cancel').length,0);assert.ok(Date.now()-start>=20);
});
test('stream failure cannot be masked by an eventual successful result',async t=>{
 const f=await setup(t,{streamError:true});const r=await run(f);assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'STREAM_ERROR');assert.ok(f.api.calls.some(c=>c[0]==='cancel'));
});
test('cancellation returns a cancelled terminal, not successful acceptance',async t=>{
 const f=await setup(t,{delay:200});const c=new AbortController();setTimeout(()=>c.abort(),25);
 const r=await run(f,{signal:c.signal});assert.equal(r.runtime_status,'cancelled');assert.equal(r.task_acceptance,'unverified');assert.equal(r.cleanup,'confirmed');
});
test('pre-aborted request does not initialize or prompt',async t=>{
 const f=await setup(t);const c=new AbortController();c.abort();const r=await run(f,{signal:c.signal});
 assert.equal(r.runtime_status,'cancelled');assert.equal(f.api.calls.length,0);
});
test('cleanup failure is explicit and cannot be claimed complete',async t=>{
 const f=await setup(t,{cleanupError:true});const r=await run(f);assert.equal(r.cleanup,'unconfirmed');assert.ok(r.error_code);
 await assert.rejects(closeBinding({config:f.config,binding:f.binding}),{code:'CLEANUP_UNCONFIRMED'});
});
test('a live adapter observed after close keeps cleanup unconfirmed',async t=>{
 const f=await setup(t,{leakedProcess:true});const r=await run(f);assert.equal(r.cleanup,'unconfirmed');
});
test('session identity drift in final status invalidates completion',async t=>{
 const f=await setup(t,{changedSession:'someone-else'});const r=await run(f);assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'CONTINUITY_LOST');
});
test('agent-reported usage stays compact and never fabricates billing proof',async t=>{
 const usage={cumulative:{inputTokens:9},cost:{amount:0,currency:'USD'},perRequest:Object.fromEntries(Array.from({length:1000},(_,i)=>[`request-${i}`,{inputTokens:i}]))};
 const f=await setup(t,{usage});const r=await run(f);
 assert.deepEqual(r.adapter_reported_session_usage,{cumulative:usage.cumulative,cost:usage.cost});
 assert.equal(r.adapter_reported_per_request_usage_omitted,true);assert.equal(r.advertised_model,null);
 assert.ok(Buffer.byteLength(JSON.stringify(r))<20000);
});
test('usage reported only per request keeps totals unknown instead of fabricated',async t=>{
 const f=await setup(t,{usage:{perRequest:{'request-1':{inputTokens:3}}}});const r=await run(f);
 assert.equal(r.adapter_reported_session_usage,null);assert.equal(r.adapter_reported_per_request_usage_omitted,true);
});
test('logical close retains history and disallows later continuation',async t=>{
 const f=await setup(t);const r=await run(f);await closeBinding({config:f.config,binding:f.binding});
 assert.equal((await readJSON(r.receipt_path,{privateFile:true})).runtime_status,'completed');
 const next=await run(f,{isNew:false});assert.equal(next.error_code,'SESSION_CLOSED');
});
test('registry admits only the selected named route',async t=>{
 const f=await setup(t);await run(f);const options=f.api.calls.find(c=>c[0]==='ensure')[2];
 assert.throws(()=>options.agentRegistry.resolve('claude'),{code:'UNKNOWN_ROUTE'});assert.deepEqual(options.mcpServers,[]);assert.equal(options.nonInteractivePermissions,'deny');
});
// These assertions cover the generated authorization wording and the option
// mapping. They are not evidence that read mode enforces a filesystem boundary.
test('generated work order states distinct read and full permission-response rules',()=>{
 const read=workOrder('Fix the synthetic importer.','read'),full=workOrder('Fix the synthetic importer.','full');
 assert.match(read,/approve-reads/);assert.match(read,/not authorized to modify files or run mutating commands/);
 assert.match(read,/report proposed changes/);assert.match(read,/not enforcement and not an OS sandbox/);
 assert.ok(!/not authorized to modify files/.test(full));
 assert.match(full,/approve-all/);assert.match(full,/authority still comes only from this work order and the current task/);
 assert.match(full,/not an OS sandbox/);
 // The handed-over work order itself is never dropped.
 assert.match(read,/Fix the synthetic importer\./);assert.match(full,/Fix the synthetic importer\./);
});
test('an unknown permission policy is rejected instead of producing vague wording',()=>{
 for(const bad of ['write','READ','',undefined,null,Object.create(null)])assert.throws(()=>workOrder('x',bad),{code:'BAD_PERMISSIONS'});
});
test('runtimeOptions maps read and full to ACP permission-response modes only',async t=>{
 const f=await setup(t);const store={load:async()=>null};
 assert.equal(runtimeOptions(f.selection,store,{}).permissionMode,'approve-reads');
 assert.equal(runtimeOptions({...f.selection,permissions:'full'},store,{}).permissionMode,'approve-all');
 assert.equal(runtimeOptions(f.selection,store,{}).nonInteractivePermissions,'deny');
});
test('timed-out initialization retains uncertainty and blocks late launch admission',async t=>{
 const f=await setup(t,{initHang:true});
 const r=await run(f,{selection:{...f.selection,route:{...f.selection.route,timeoutMs:100}},cleanupMs:50});
 assert.equal(r.error_code,'INIT_TIMEOUT');assert.equal(r.cleanup,'unconfirmed');
 const life=f.api.calls.find(c=>c[0]==='ensure')[2].processLifecycle;
 await assert.rejects(life.onBeforeSpawn({launchId:'late'}),{code:'LAUNCH_AFTER_STOP'});
 assert.equal(f.api.calls.filter(c=>c[0]==='start').length,0);
});
test('failed runtime return does not automatically retry a potentially effectful work order',async t=>{
 const f=await setup(t,{terminal:{status:'failed',error:{code:'REMOTE_FAILURE'}}});const r=await run(f);
 assert.equal(r.runtime_status,'failed');assert.equal(r.error_code,'REMOTE_FAILURE');assert.equal(f.api.calls.filter(c=>c[0]==='start').length,1);
});
test('preflight rejection does not manufacture a cleanup failure or reopen an old connection',async t=>{
 const f=await setup(t);await run(f);f.api.records.clear();const closes=f.api.calls.filter(c=>c[0]==='close').length;
 const r=await run(f,{isNew:false});assert.equal(r.cleanup,'confirmed');assert.equal(r.runtime_status,'failed');assert.equal(f.api.calls.filter(c=>c[0]==='close').length,closes);
});
test('an explicitly requested model must be advertised before any prompt',async t=>{
 const f=await setup(t);const selection={...f.selection,route:{...f.selection.route,sessionOptions:{model:'synthetic-required-model'}}};
 const r=await run(f,{selection});assert.equal(r.error_code,'MODEL_UNVERIFIED');assert.equal(f.api.calls.filter(c=>c[0]==='start').length,0);
});
test('matching advertised model allows execution without claiming provider verification',async t=>{
 const f=await setup(t,{models:{currentModelId:'synthetic-required-model'}});const selection={...f.selection,route:{...f.selection.route,sessionOptions:{model:'synthetic-required-model'}}};
 const r=await run(f,{selection});assert.equal(r.runtime_status,'completed');assert.equal(r.advertised_model,'synthetic-required-model');assert.equal(r.provider_identity_verified,false);
});
test('private diagnostics retain error detail but receipts do not expose raw error text',async t=>{
 const f=await setup(t,{cleanupError:true});const r=await run(f);assert.ok(r.diagnostic_path);assert.ok(!JSON.stringify(r).includes('synthetic cleanup failure'));assert.equal((await readJSON(r.diagnostic_path,{privateFile:true})).message,'synthetic cleanup failure');
});
