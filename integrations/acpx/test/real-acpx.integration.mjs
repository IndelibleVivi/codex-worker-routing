// This suite intentionally FAILS if the pinned package is missing. It never
// substitutes the contract double. Execute with `npm run test:acpx` after install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAcpx } from '../src/cli.mjs';
import { fixture, sleep } from './helpers.mjs';
const execute=promisify(execFile);
const cli=path.resolve('src/cli.mjs'),agent=path.resolve('test/fixture-acp-agent.mjs');
async function setup(t,overrides={}){await loadAcpx();const f=await fixture({argv:[process.execPath,agent],timeoutMs:5000,...overrides});t.after(f.cleanup);return f}
// Containment, not a raw string prefix: "<home>-other" must not count as being
// under "<home>".
const contained=(root,candidate)=>{const rel=path.relative(root,candidate);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel)};
async function command(f,verb,extra=[]){
 const args=[cli,verb,'--config',f.configFile,...extra];
 try{const r=await execute(process.execPath,args,{timeout:25000,maxBuffer:512*1024,env:{...process.env,CWR_PRIVATE_TEST_MARKER:'MUST_NOT_ARRIVE'}});return {code:0,...r,receipt:JSON.parse(r.stdout)}}
 catch(e){return {code:e.code,stdout:e.stdout,stderr:e.stderr,receipt:e.stdout?.trim()?JSON.parse(e.stdout):null}}
}
// A blocking `run` must be started without awaiting it so a second control
// command can race it. Progress is detected by a real condition, never a fixed
// sleep.
function start(f,verb,extra=[]){
 const args=[cli,verb,'--config',f.configFile,...extra];
 const child=execFile(process.execPath,args,{timeout:25000,maxBuffer:512*1024,env:{...process.env,CWR_PRIVATE_TEST_MARKER:'MUST_NOT_ARRIVE'}});
 const done=new Promise(resolve=>{
  let stdout='',stderr='';
  child.stdout.on('data',d=>{stdout+=d});child.stderr.on('data',d=>{stderr+=d});
  const settle=code=>resolve({code,stdout,stderr,receipt:stdout.trim()?JSON.parse(stdout):null});
  child.on('error',e=>settle(e.code??'ERROR'));child.on('close',code=>settle(code));
 });
 return {child,done};
}
async function until(check,message,timeout=15000){
 const end=Date.now()+timeout;
 for(;;){const v=await check();if(v)return v;if(Date.now()>=end)throw new Error(message);await sleep(25)}
}
const initial=f=>['--route','worker','--cwd',f.cwd,'--file',f.orderFile];

test('REAL acpx plus spawned synthetic ACP process: restart, same session, clean env, preserved history',async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);assert.equal(a.receipt.cleanup,'confirmed');
 const text=JSON.parse(a.receipt.output_excerpt);assert.equal(text.turn,1);assert.equal(text.main_marker_present,false);assert.equal(text.home,f.selection.route.workerHome);
 const b=await command(f,'continue',['--session',a.receipt.session_id,'--file',f.orderFile]);assert.equal(b.code,0,b.stderr);assert.equal(b.receipt.acp_session_id,a.receipt.acp_session_id);assert.equal(JSON.parse(b.receipt.output_excerpt).turn,2);
 const c=await command(f,'close',['--session',a.receipt.session_id]);assert.equal(c.code,0,c.stderr);assert.equal(c.receipt.history_deleted,false);
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
// Runs only on windows-latest. The unit contract double cannot prove that the
// real spawn path and acpx's Windows command resolution see the relocated
// profile/temp/launcher variables, so this asserts them from the child itself.
test('REAL acpx on Windows: the adapter process sees relocated profile, temp and launcher variables',{skip:process.platform!=='win32'},async t=>{
 const f=await setup(t);const a=await command(f,'run',initial(f));assert.equal(a.code,0,a.stderr);
 const text=JSON.parse(a.receipt.output_excerpt),home=f.selection.route.workerHome;
 assert.equal(text.userprofile,home);
 for(const key of ['temp','tmp','appdata','localappdata'])assert.ok(text[key]&&contained(home,text[key]),`${key} must stay under the worker home, got ${text[key]}`);
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
