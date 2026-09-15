import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs,main,localStatus,requestCancel } from '../src/cli.mjs';
import { loadBinding,paths,privateDir,lock } from '../src/state.mjs';
import { fixture,fakeAcpx,sleep,deferred } from './helpers.mjs';
async function setup(t,behavior={}){const f=await fixture();t.after(f.cleanup);const api=fakeAcpx(behavior),results=[];return {...f,api,results,deps:{loadAcpx:async()=>api,replaceEnvironment:()=>{},output:r=>results.push(r),progress:()=>{}}}}
const args=f=>['run','--config',f.configFile,'--route','worker','--cwd',f.cwd,'--file',f.orderFile];

test('CLI parser refuses unknown/duplicate flags and unknown verbs',()=>{for(const a of [['forget'],['run','--route','x'],['status','--config','a','--session','b','--oops','x'],['status','--config','a','--config','b']])assert.throws(()=>parseArgs(a),{code:'USAGE'})});
test('CLI full lifecycle keeps native channel untouched',async t=>{
 const f=await setup(t);assert.equal(await main(args(f),f.deps),0);const r=f.results.at(-1);
 assert.equal(await main(['continue','--config',f.configFile,'--session',r.session_id,'--file',f.orderFile],f.deps),0);
 assert.equal(f.api.calls.filter(c=>c[0]==='ensure').length,1);
 assert.equal(await main(['status','--config',f.configFile,'--session',r.session_id],f.deps),0);assert.equal(f.results.at(-1).active,'idle');
 assert.equal(await main(['close','--config',f.configFile,'--session',r.session_id],f.deps),0);assert.equal(f.results.at(-1).history_deleted,false);
 await assert.rejects(main(['continue','--config',f.configFile,'--session',r.session_id,'--file',f.orderFile],f.deps),{code:'SESSION_CLOSED'});
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
 try { await assert.rejects(main(args(f),f.deps),{code:'BUSY_OR_UNRECONCILED'}); }
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
test('unconfirmed adapter cleanup preserves locks and returns failure',async t=>{
 const f=await setup(t,{cleanupError:true});assert.equal(await main(args(f),f.deps),1);const r=f.results.at(-1);
 await fs.stat(paths(f.config.stateDir,r.session_id).lock);
 await assert.rejects(main(args(f),f.deps),{code:'BUSY_OR_UNRECONCILED'});
});
test('nonce-bound cancel control requests cancellation without claiming stopped',async t=>{
 const f=await setup(t,{delay:1200});let id;
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
