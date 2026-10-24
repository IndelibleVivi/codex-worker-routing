import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs,main,localStatus,requestCancel,renderDeliveryText } from '../src/cli.mjs';
import { loadBinding,paths,privateDir,lock,atomicJSON } from '../src/state.mjs';
import { fixture,fakeAcpx,sleep,deferred,lifecycleEvidence } from './helpers.mjs';
async function setup(t,behavior={}){const f=await fixture();f.processEvidence=lifecycleEvidence(f.syntheticPid);t.after(f.cleanup);const api=fakeAcpx(behavior),results=[];return {...f,api,results,deps:{loadAcpx:async()=>api,replaceEnvironment:()=>{},output:r=>results.push(r),progress:()=>{},processEvidence:f.processEvidence}}}
const args=f=>['run','--permissions', 'read', '--config',f.configFile,'--route','worker','--cwd',f.cwd,'--file',f.orderFile];

test('CLI parser refuses unknown/duplicate flags and unknown verbs',()=>{for(const a of [['forget'],['run','--route','x'],['status','--config','a','--session','b','--oops','x'],['status','--config','a','--config','b']])assert.throws(()=>parseArgs(a),{code:'USAGE'})});
test('bare --help and <known-command> --help both return help',()=>{
 for(const a of [[],['--help'],['help'],['dashboard','--help'],['run','--help'],['stats','--help'],['pending','--help'],['record','--help'],['continue','--help']])
  assert.deepEqual(parseArgs(a),{command:'help'},`${a.join(' ')} should resolve to help`);
 // Help short-circuits before option validation, so a trailing/extra token is still refused.
 for(const a of [['dashboard','--help','--config','x'],['dashboard','--config','x','--help']])
  assert.throws(()=>parseArgs(a),{code:'USAGE'},`${a.join(' ')} should not silently accept help mid-command`);
});
test('main prints help for a known command without loading config',async()=>{
 const written=[];assert.equal(await main(['dashboard','--help'],{help:s=>written.push(s),output:()=>{throw new Error('no output expected')}}),0);
 assert.equal(written.length,1);
 assert.match(written[0],/dashboard --config FILE/);
 assert.match(written[0],/private loopback URL/);
 assert.match(written[0],/share cards are reached from the dashboard\s+header/i);
});
test('dashboard startup prints the URL, foreground guidance and JSON handle',async t=>{
 const f=await setup(t);const text=[],output=[];
 let dashboardOptions;
 const stub={startDashboard:async value=>{dashboardOptions=value;return {url:'http://127.0.0.1:4317/#token=deadbeef&since=all',port:4317};}};
 assert.equal(await main(['dashboard','--config',f.configFile,'--port','4317'],{...f.deps,text:s=>text.push(s),output:r=>output.push(r),loadDashboard:async()=>stub}),0);
 const stdout=text.join('');
 assert.match(stdout,/Dispatch dashboard: http:\/\/127\.0\.0\.1:4317\/#token=deadbeef&since=all/);
 assert.match(stdout,/keep this process running \(Ctrl\+C to stop\)/);
 assert.match(stdout,/Open this private URL/);
 assert.equal(dashboardOptions.stateDir,f.config.stateDir);
 assert.equal(dashboardOptions.configPath,f.configFile);
 // The structured handle is preserved and unchanged by the extra guidance line.
 assert.deepEqual(output,[{schema:'cwr.dispatch.dashboard/1',url:'http://127.0.0.1:4317/#token=deadbeef&since=all',since:'all',port:4317}]);
});
test('CLI full lifecycle keeps native channel untouched',async t=>{
 const f=await setup(t);assert.equal(await main(args(f),f.deps),0);const r=f.results.at(-1);
 assert.equal(await main(['continue','--permissions', 'read', '--config',f.configFile,'--session',r.session_id,'--file',f.orderFile],f.deps),0);
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 assert.equal(await main(['status','--config',f.configFile,'--session',r.session_id],f.deps),0);assert.equal(f.results.at(-1).active,'idle');
 assert.equal(await main(['close','--config',f.configFile,'--session',r.session_id],f.deps),0);assert.equal(f.results.at(-1).history_deleted,false);
 await assert.rejects(main(['continue','--permissions', 'read', '--config',f.configFile,'--session',r.session_id,'--file',f.orderFile],f.deps),{code:'SESSION_CLOSED'});
});
test('route disabled is checked before importing/executing runtime',async t=>{
 const f=await setup(t);f.raw.routes.worker.enabled=false;await fs.writeFile(f.configFile,JSON.stringify(f.raw));let imported=false;
 await assert.rejects(main(args(f),{...f.deps,loadAcpx:async()=>{imported=true}}),{code:'ROUTE_DISABLED'});assert.equal(imported,false);
});
test('dependency failure does not alter native files or initialize worker home',async t=>{
 const f=await setup(t);await assert.rejects(main(args(f),{...f.deps,loadAcpx:async()=>{throw new Error('missing package')}}),/missing package/);
 await assert.rejects(fs.stat(f.selection.route.workerHome),{code:'ENOENT'});assert.equal(f.api.calls.length,0);
});
test('two commands cannot write the same workspace concurrently',async t=>{
 const gate=deferred();const f=await setup(t,{firstTurnGate:gate.promise});const p=main(args(f),f.deps);
 while(!f.api.calls.some(c=>c[0]==='start'))await sleep(5);
 // The first worker is provably holding both locks until the gate opens.
 try {
  await assert.rejects(main(args(f),f.deps),error=>{
   assert.equal(error.code,'RECOVERY_REQUIRED');
   assert.ok(error.message.includes(f.cwd));
   assert.match(error.message,/live or unresolved owned process/);
   assert.match(error.message,/recover --session [a-f0-9-]{36}/);
   return true;
  });
 }
 finally { gate.resolve(); }
 assert.equal(await p,0);
});
test('status and close remain available after a registered workspace disappears',async t=>{
 const f=await setup(t);assert.equal(await main(args(f),f.deps),0);const id=f.results.at(-1).session_id;
 await fs.rm(f.cwd,{recursive:true,force:true});
 // run still applies the full route/executable/workspace contract.
 await assert.rejects(main(args(f),f.deps),{code:'ENOENT'});
 assert.equal(await main(['status','--config',f.configFile,'--session',id],f.deps),0);
 assert.equal(f.results.at(-1).active,'idle');
 assert.equal(await main(['close','--config',f.configFile,'--session',id],f.deps),0);
});
test('an unrelated broken or disabled route cannot block status, cancel or close',async t=>{
 const f=await setup(t);assert.equal(await main(args(f),f.deps),0);const id=f.results.at(-1).session_id;
 const p=paths(f.config.stateDir,id);
 const unlock=await lock(p.lock,{nonce:'synthetic-hold',pid:process.pid});
 f.raw.routes.legacy={...f.raw.routes.worker,enabled:false,workerHome:path.join(f.root,'legacy-home'),workspaces:[path.join(f.root,'vanished')]};
 await fs.writeFile(f.configFile,JSON.stringify(f.raw));
 try {
  assert.equal(await main(['status','--config',f.configFile,'--session',id],f.deps),0);
  assert.equal(f.results.at(-1).active,'owner_process_present');
  assert.equal(await main(['cancel','--config',f.configFile,'--session',id],f.deps),0);
  assert.equal(f.results.at(-1).cancel_requested,true);
  await fs.unlink(path.join(p.lock,'cancel.json'));
 } finally { await unlock(); }
 assert.equal(await main(['close','--config',f.configFile,'--session',id],f.deps),0);
});
test('an ownerless lock is reported as unreconciled, never idle',async t=>{
 const f=await setup(t);const p=paths(f.config.stateDir,f.binding.id);
 await privateDir(p.lock);await fs.writeFile(path.join(p.lock,'cancel.json'),'{}',{mode:0o600});
 assert.equal((await localStatus(f.config,f.binding)).active,'unreconciled');
});
async function interruptedReceipt(t) {
 const f=await setup(t,{terminal:{status:'failed',error:{code:'TURN_TIMEOUT'}}});
 assert.equal(await main(args(f),f.deps),1);
 const receipt=f.results.at(-1),p=paths(f.config.stateDir,receipt.session_id);
 const binding=await loadBinding(f.config.stateDir,receipt.session_id);
 // Reproduce an exit after the receipt rename and before the final binding
 // rename. The previous turn's cleanup may still say confirmed in that binding.
 delete binding.lastReceipt;delete binding.lastStatus;binding.cleanup='confirmed';
 binding.active_turn={request_id:receipt.request_id,started_at:receipt.started_at};
 await atomicJSON(p.binding,binding);
 await lock(p.lock,{nonce:'interrupted-owner',pid:process.pid,session:binding.id});
 return {...f,receipt,binding,p};
}
test('status recovers an exactly matching persisted terminal receipt without repairing state or releasing locks',async t=>{
 const f=await interruptedReceipt(t);
 const files=[f.p.binding,f.receipt.receipt_path,path.join(f.p.lock,'owner.json')];
 const before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')));
 const tree=await fs.readdir(f.config.stateDir,{recursive:true});
 let loaded=false;const results=[];
 assert.equal(await main(['status','--config',f.configFile,'--session',f.binding.id],{...f.deps,loadAcpx:async()=>{loaded=true;throw new Error('status must stay local')},output:r=>results.push(r)}),0);
 const view=results.at(-1);
 assert.equal(view.last_runtime_status,'failed');assert.equal(view.last_receipt,f.receipt.receipt_path);
 assert.equal(view.last_error_code,'TURN_TIMEOUT');assert.equal(view.receipt_evidence.source,'active_turn');
 assert.equal(view.receipt_evidence.request_id,f.receipt.request_id);
 assert.equal(view.active_request.request_id,f.receipt.request_id);assert.equal(view.active_request.runtime_status,'failed');
 assert.equal(view.active_request.error_code,'TURN_TIMEOUT');assert.equal(view.active_request.receipt,f.receipt.receipt_path);
 assert.equal(view.cleanup,'unconfirmed','a recovered receipt cannot confirm a stale binding cleanup');
 assert.equal(view.active,'owner_process_present');assert.equal(loaded,false);
 assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before);
 assert.deepEqual(await fs.readdir(f.config.stateDir,{recursive:true}),tree);
});
test('status ignores foreign, stale and malformed active receipts instead of inferring a terminal result',async t=>{
 const f=await interruptedReceipt(t);
 const invalid=[
  {session_id:'00000000-0000-0000-0000-000000000000'},
  {request_id:'00000000-0000-0000-0000-000000000000'},
  {route:'another-route'}, {acpx_record_id:'another-record'}, {acp_session_id:'another-session'},
  {started_at:new Date(Date.parse(f.receipt.started_at)-1000).toISOString()},
  {finished_at:'not-a-date'}, {finished_at:new Date(Date.parse(f.receipt.started_at)-1).toISOString()},
  {schema:'foreign/1'}, {backend:'other'}, {runtime_status:'running'}, {cleanup:'probably'},
  {receipt_path:path.join(f.root,'foreign.json')},
 ];
 for(const fields of invalid){
  await atomicJSON(f.receipt.receipt_path,{...f.receipt,...fields});
  const view=await localStatus(f.config,f.binding);
  assert.equal(view.last_runtime_status,null,JSON.stringify(fields));assert.equal(view.last_receipt,null,JSON.stringify(fields));
  assert.equal(view.receipt_evidence,null);assert.equal(view.cleanup,'unconfirmed');
 }
 await fs.writeFile(f.receipt.receipt_path,'{malformed');
 assert.equal((await localStatus(f.config,f.binding)).receipt_evidence,null);
 // A symlink must not turn the exact local request filename into another file.
 await fs.unlink(f.receipt.receipt_path);
 const elsewhere=path.join(f.root,'foreign.json');await atomicJSON(elsewhere,f.receipt);
 await fs.symlink(elsewhere,f.receipt.receipt_path);
 assert.equal((await localStatus(f.config,f.binding)).receipt_evidence,null);
});
test('status prefers the interrupted active request over a stale binding pointer and sanitizes timing evidence',async t=>{
 const f=await interruptedReceipt(t);
 f.binding.lastReceipt=path.join(f.p.receipts,'00000000-0000-0000-0000-000000000000.json');f.binding.lastStatus='completed';
 const activity={observed_at:f.receipt.finished_at,event_count:2,first_event_at:f.receipt.started_at,last_event_at:f.receipt.finished_at,last_event_type:'tool_call',last_event_age_ms:0,payload:'PRIVATE_PAYLOAD'};
 const budget={...f.receipt.budget,task_deadline_at:f.receipt.finished_at,task_elapsed_ms:100,private_path:'/synthetic/private'};
 await atomicJSON(f.receipt.receipt_path,{...f.receipt,activity,budget});
 const view=await localStatus(f.config,f.binding);
 assert.equal(view.last_receipt,f.receipt.receipt_path);assert.equal(view.last_runtime_status,'failed');
 assert.equal(view.receipt_evidence.activity.last_event_type,'tool_call');assert.equal(view.receipt_evidence.budget.task_elapsed_ms,100);
 assert.ok(!JSON.stringify(view).includes('PRIVATE_PAYLOAD'));assert.ok(!JSON.stringify(view).includes('/synthetic/private'));
});
test('status rejects an out-of-directory binding receipt pointer and does not guess the latest receipt',async t=>{
 const f=await interruptedReceipt(t);
 delete f.binding.active_turn;f.binding.lastReceipt=path.join(f.root,'elsewhere.json');
 await atomicJSON(f.binding.lastReceipt,f.receipt);
 const view=await localStatus(f.config,f.binding);
 assert.equal(view.last_receipt,null);assert.equal(view.receipt_evidence,null);
});
test('a duplicate binding pointer cannot bypass active-request timestamp validation',async t=>{
 const f=await interruptedReceipt(t);
 f.binding.lastReceipt=f.receipt.receipt_path;f.binding.lastStatus='failed';
 f.binding.active_turn.started_at=new Date(Date.parse(f.receipt.started_at)+1000).toISOString();
 const view=await localStatus(f.config,f.binding);
 assert.equal(view.last_runtime_status,null);assert.equal(view.receipt_evidence,null);
});
test('a prior completed receipt never becomes the outcome of a newer active request without its own receipt',async t=>{
 const f=await interruptedReceipt(t);
 await atomicJSON(f.receipt.receipt_path,{...f.receipt,runtime_status:'completed',error_code:null});
 f.binding.lastReceipt=f.receipt.receipt_path;f.binding.lastStatus='completed';
 const marker={request_id:'00000000-0000-0000-0000-000000000000',started_at:new Date(Date.parse(f.receipt.finished_at)+1).toISOString()};
 f.binding.active_turn=marker;
 const view=await localStatus(f.config,f.binding);
 assert.equal(view.last_runtime_status,'completed');assert.equal(view.last_receipt,f.receipt.receipt_path);
 assert.equal(view.receipt_evidence.source,'binding');assert.equal(view.receipt_evidence.request_id,f.receipt.request_id);
 assert.deepEqual(view.active_request,{...marker,runtime_status:null,error_code:null,receipt:null});
 assert.equal(view.cleanup,'unconfirmed');assert.equal(view.active,'owner_process_present');
 await assert.rejects(fs.stat(path.join(f.p.receipts,`${marker.request_id}.json`)),{code:'ENOENT'});
});
test('unconfirmed adapter cleanup preserves locks and returns a precise recovery-required failure',async t=>{
 const f=await setup(t,{cleanupError:true});assert.equal(await main(args(f),f.deps),1);const r=f.results.at(-1);
 await fs.stat(paths(f.config.stateDir,r.session_id).lock);
 await assert.rejects(main(args(f),f.deps),error=>{
  assert.equal(error.code,'RECOVERY_REQUIRED');
  assert.ok(error.message.includes(f.cwd));
  assert.match(error.message,/live or unresolved owned process/);
  return true;
 });
});
test('nonce-bound cancel control requests cancellation without claiming stopped',async t=>{
 const gate=deferred();const f=await setup(t,{firstTurnGate:gate.promise});let id;
 t.after(()=>gate.resolve());
 const p=main(args(f),{...f.deps,progress:s=>{id=s.match(/session ([a-f0-9-]+)/)[1]}});
 while(!id||!f.api.calls.some(c=>c[0]==='start'))await sleep(5);
 const b=await loadBinding(f.config.stateDir,id);const request=await requestCancel(f.config,b);
 assert.equal(request.stopped,false);assert.equal(request.cancel_requested,true);
 assert.equal(await p,130);assert.equal(f.results.at(-1).runtime_status,'cancelled');
 assert.equal((await localStatus(f.config,b)).active,'idle');
});
test('cancel on an idle session does not recreate a lock',async t=>{
 const f=await setup(t);await main(args(f),f.deps);const r=f.results.at(-1),b=await loadBinding(f.config.stateDir,r.session_id);
 await assert.rejects(requestCancel(f.config,b),{code:'STATE_MISSING'});await assert.rejects(fs.stat(paths(f.config.stateDir,b.id).lock),{code:'ENOENT'});
});
test('environment preparation happens before runtime import',async t=>{
 const f=await setup(t);let clean=false;
 await main(args(f),{...f.deps,replaceEnvironment:env=>{assert.equal(env.HOME,f.selection.route.workerHome);assert.equal(env.OPENAI_API_KEY,undefined);clean=true},loadAcpx:async()=>{assert.equal(clean,true);return f.api}});
});
test('parser accepts --deliver and delivery/batch/start-handle verbs and refuses malformed options',()=>{
 assert.equal(parseArgs(['run','--config','c','--cwd','/w','--file','/o','--permissions','read','--deliver']).deliver,true);
 assert.equal(parseArgs(['continue','--config','c','--session','s','--file','/o','--permissions','full','--start-handle','/h'])['start-handle'],'/h');
 assert.equal(parseArgs(['delivery','--config','c','--session','s','--json']).json,true);
 assert.equal(parseArgs(['batch','--config','c','--manifest','/m']).manifest,'/m');
 const b=parseArgs(['batch','--config','c','--manifest','/m','--start-handle','/h','--compact','--limit','2','--max-bytes','8192']);
 assert.equal(b['start-handle'],'/h');assert.equal(b.compact,true);assert.equal(b.limit,'2');assert.equal(b['max-bytes'],'8192');
 const c=parseArgs(['collect','--config','c','--batch','b','--compact','--cursor','tok','--limit','1','--max-bytes','8192','--job','j']);
 assert.equal(c.compact,true);assert.equal(c.cursor,'tok');assert.equal(c.job,'j');
 const impacts=parseArgs(['collect','--config','c','--batch','b','--impacts','j']);
 assert.equal(impacts.impacts,'j');
 assert.throws(()=>parseArgs(['collect','--config','c','--batch','b','--job','j','--impacts','j']),{code:'USAGE'});
 for(const bad of [['delivery','--config','c'],['batch','--config','c'],['run','--config','c','--cwd','/w','--file','/o','--permissions','read','--deliver','x']])assert.throws(()=>parseArgs(bad),{code:'USAGE'});
});
test('--deliver collects a sidecar from the real CLI turn and delivery prints a path-free view',async t=>{
 // The block must carry the ACTUAL request/session ids the collector expects.
 const f=await setup(t,{events:input=>[{type:'text_delta',stream:'output',text:'```cwr-delivery\n'+JSON.stringify({schema:'cwr.acp.delivery/1',status:'ready',summary:'synthetic done',criteria:[],checks:[],artifacts:[],questions:[],request_id:input.requestId,session_id:(input.handle.sessionKey||'').replace(/^cwr:/,'')})+'\n```'}]});
 assert.equal(await main([...args(f),'--deliver'],f.deps),0);
 const id=f.results.at(-1).session_id;
 const jsonOut=[],textOut=[];
 assert.equal(await main(['delivery','--config',f.configFile,'--session',id,'--json'],{...f.deps,output:r=>jsonOut.push(r),text:()=>{}}),0);
 assert.equal(jsonOut.at(-1).worker.status,'ready');
 assert.equal(jsonOut.at(-1).observed.checks_source,'runner_observed');
 assert.equal(await main(['delivery','--config',f.configFile,'--session',id],{...f.deps,output:()=>{},text:s=>textOut.push(s)}),0);
 assert.match(textOut.join(''),/Delivery for session/);
 // The human view carries no filesystem path.
 assert.ok(!/\/private\/|\/tmp\/|\/Users\//.test(textOut.join('')));
});
test('a start handle is written only for an opted-in job with real session/request ids',async t=>{
 const f=await setup(t);const handle=path.join(f.root,'handle.json');
 assert.equal(await main([...args(f),'--start-handle',handle],f.deps),0);
 const h=JSON.parse(await fs.readFile(handle,'utf8'));
 assert.equal(h.schema,'cwr.acp.start-handle/1');assert.equal(h.session_id,f.results.at(-1).session_id);assert.equal(h.request_id,f.results.at(-1).request_id);
});
test('delivery on a session with no collected report returns an explicit null, not a fake pass',async t=>{
 const f=await setup(t);assert.equal(await main(args(f),f.deps),0);const id=f.results.at(-1).session_id;
 const out=[];assert.equal(await main(['delivery','--config',f.configFile,'--session',id,'--json'],{...f.deps,output:r=>out.push(r),text:()=>{}}),0);
 assert.deepEqual(out.at(-1),{schema:'cwr.acp.delivery-sidecar/1',session_id:id,delivery:null});
});

// The text view is a convenience over the stored sidecar. These synthetic records
// pin the boundaries: declarations stay declared, unsupplied or failed runtime
// facts stay honest, and a missing/malformed report is never dressed up as ready.
const readyRecord=()=>({schema:'cwr.acp.delivery-sidecar/1',session_id:'synthetic-session',request_id:'synthetic-request',
 worker:{checks_source:'worker_reported',status:'ready',code:null,block:{summary:'synthetic done',criteria:[],checks:[],artifacts:[],questions:[]}},
 observed:{checks_source:'runner_observed',runtime_status:'completed',cleanup:'confirmed'}});

test('delivery text keeps worker-declared check counts labelled worker_reported even with observed facts',()=>{
 const text=renderDeliveryText('synthetic-session',{...readyRecord(),
  worker:{status:'ready',code:null,block:{summary:'synthetic done',criteria:[{criterion:'c',state:'satisfied'}],checks:[{name:'a',state:'passed'},{name:'b',state:'passed'}],artifacts:[],questions:[]}},
  observed:{checks_source:'runner_observed',runtime_status:'completed',cleanup:'confirmed'}});
 assert.match(text,/checks 2 \(worker_reported\)/);
 assert.match(text,/runtime_status completed; cleanup confirmed/);
 assert.ok(!/runner_observed/.test(text),'a worker declaration must not be promoted to runner_observed');
 assert.ok(!/accepted|satisfied/.test(text),'the text view must not infer acceptance from the declaration');
});

test('delivery text omits absent observations and zero warnings but keeps failed runtime facts visible',()=>{
 for(const observed of [undefined,{checks_source:'runner_observed',runtime_status:null,cleanup:null}]){
  const quiet=renderDeliveryText('synthetic-session',{...readyRecord(),observed});
  assert.ok(!/runtime_status/.test(quiet),'absent observed runtime data stays absent');
  assert.ok(!/invalid sidecars/.test(quiet),'warnings are not printed when none were supplied');
 }
 const failed=renderDeliveryText('synthetic-session',{...readyRecord(),
  observed:{checks_source:'runner_observed',runtime_status:'failed',cleanup:'unconfirmed'},collection_warnings:{invalid_sidecars:2}});
 assert.match(failed,/runtime_status failed; cleanup unconfirmed/);
 assert.match(failed,/invalid sidecars skipped: 2/);
 const zero=renderDeliveryText('synthetic-session',{...readyRecord(),collection_warnings:{invalid_sidecars:0}});
 assert.ok(!/invalid sidecars/.test(zero),'a zero warning count is not printed');
});

test('delivery text keeps a missing report and a missing/malformed worker block distinct from ready',()=>{
 assert.equal(renderDeliveryText('synthetic-session',null),'No delivery collected for session synthetic-session.\n');
 const missing=renderDeliveryText('synthetic-session',{...readyRecord(),worker:{status:'missing',code:'NO_BLOCK',block:null}});
 assert.match(missing,/request synthetic-request: missing \(NO_BLOCK\)/);
 assert.ok(!/summary:|criteria /.test(missing),'a missing block invents no summary or check facts');
 const malformed=renderDeliveryText('synthetic-session',{...readyRecord(),worker:{status:'malformed',code:'BAD_JSON',block:null}});
 assert.match(malformed,/malformed \(BAD_JSON\)/);
 assert.ok(!/summary:|criteria /.test(malformed),'a malformed block invents no summary or check facts');
 const ready=renderDeliveryText('synthetic-session',readyRecord());
 assert.match(ready,/ready/);assert.match(ready,/summary: synthetic done/);
 assert.notEqual(missing,malformed);assert.notEqual(ready,missing);assert.notEqual(ready,malformed);
});

test('delivery text shows only the declared summary and counts, never nested detail',()=>{
 const text=renderDeliveryText('synthetic-session',{...readyRecord(),
  worker:{status:'partial',code:null,block:{summary:'SYNTHETIC_SUMMARY',criteria:[{criterion:'SYNTHETIC_CRITERION',state:'unsatisfied'}],
   checks:[{name:'SYNTHETIC_CHECK',state:'failed',detail:'SYNTHETIC_DETAIL'}],artifacts:[{kind:'file',ref:'src/SYNTHETIC_ARTIFACT.mjs',note:'SYNTHETIC_NOTE'}],questions:['SYNTHETIC_QUESTION']}}});
 assert.ok(text.includes('summary: SYNTHETIC_SUMMARY'),'a supplied summary appears verbatim');
 assert.match(text,/criteria 1 \| checks 1 \(worker_reported\) \| artifacts 1 \| questions 1/);
 for(const hidden of ['SYNTHETIC_CRITERION','SYNTHETIC_CHECK','SYNTHETIC_DETAIL','SYNTHETIC_ARTIFACT','SYNTHETIC_NOTE','SYNTHETIC_QUESTION'])
  assert.ok(!text.includes(hidden),`${hidden} should stay out of the summary/count view`);
});


test('a changed batch admission ticket refuses execution before environment/runtime preparation', async t => {
 const f=await setup(t);let imported=false,environment=false;
 await assert.rejects(main([...args(f),'--expected-admission','old-plan'],{...f.deps,
   loadAcpx:async()=>{imported=true;return f.api},replaceEnvironment:()=>{environment=true}}),{code:'ADMISSION_CHANGED'});
 assert.equal(imported,false);assert.equal(environment,false);
 assert.equal(f.api.calls.length,0);
 await assert.rejects(fs.stat(f.selection.route.workerHome),{code:'ENOENT'});
});
