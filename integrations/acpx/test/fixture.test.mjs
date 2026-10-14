// Tests the synthetic server itself. Passing these does not verify acpx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { once } from 'node:events';
import { fixture } from './helpers.mjs';
async function setup(t){
 const f=await fixture();await fs.mkdir(f.selection.route.workerHome,{mode:0o700});
 const p=spawn(process.execPath,[path.resolve('test/fixture-acp-agent.mjs')],{env:{HOME:f.selection.route.workerHome,PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
 let seq=0;const pending=new Map(),events=[];let permission='reject-once';
 const send=x=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
 readline.createInterface({input:p.stdout}).on('line',line=>{const q=JSON.parse(line);if(q.method==='session/request_permission'){send({id:q.id,result:{outcome:{outcome:'selected',optionId:permission}}})}else if(q.method)events.push(q);else{pending.get(q.id)?.(q);pending.delete(q.id)}});
 const request=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);send({id,method,params})});
 t.after(async()=>{try{if(p.exitCode===null&&p.signalCode===null){const exited=once(p,'close');p.kill('SIGTERM');await exited}}finally{await f.cleanup()}});
 const init=await request('initialize',{protocolVersion:1});assert.equal(init.result.protocolVersion,1);
 const created=await request('session/new',{cwd:f.cwd,mcpServers:[]});
 return {...f,p,request,events,id:created.result.sessionId,setPermission:v=>{permission=v}};
}
test('synthetic ACP server self-test: stdio conversation and persisted session', {timeout:10000},async t=>{
 const f=await setup(t);const r=await f.request('session/prompt',{sessionId:f.id,prompt:[{type:'text',text:'fixture'}]});assert.equal(r.result.stopReason,'end_turn');
 const saved=JSON.parse(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-sessions.json'),'utf8'));assert.equal(saved[f.id].turn,1);assert.ok(f.events.some(e=>e.method==='session/update'));
});
test('synthetic ACP server self-test: permission denial has no write; allow creates only fixture', {timeout:10000},async t=>{
 const f=await setup(t);const prompt={sessionId:f.id,prompt:[{type:'text',text:'FIXTURE_WRITE'}]};await f.request('session/prompt',prompt);await assert.rejects(fs.stat(path.join(f.cwd,'fixture-result.txt')),{code:'ENOENT'});
 f.setPermission('allow-once');await f.request('session/prompt',prompt);assert.equal(await fs.readFile(path.join(f.cwd,'fixture-result.txt'),'utf8'),'fixture only\n');
});
test('synthetic ACP server self-test: cooperative cancel settles the original prompt', {timeout:10000},async t=>{
 const f=await setup(t);const prompt=f.request('session/prompt',{sessionId:f.id,prompt:[{type:'text',text:'FIXTURE_WAIT'}]});
 // Wait for the persisted turn marker, not an arbitrary sleep before cancelling.
 while(JSON.parse(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-sessions.json'),'utf8'))[f.id].turn===0)await new Promise(r=>setTimeout(r,5));
 await f.request('session/cancel',{sessionId:f.id});assert.equal((await prompt).result.stopReason,'cancelled');
});
test('synthetic ACP server self-test: cancellation during parked-prompt preparation is retained', {timeout:10000},async t=>{
 const f=await setup(t);
 const prompt=f.request('session/prompt',{sessionId:f.id,prompt:[{type:'text',text:'FIXTURE_WAIT'}]});
 // Back-to-back RPCs reach the handler before its awaited audit/store writes.
 // Cancellation must not disappear while the parked turn is being prepared.
 await f.request('session/cancel',{sessionId:f.id});
 assert.equal((await prompt).result.stopReason,'cancelled');
});
test('synthetic ACP server self-test: CLI pipe EOF clears a parked prompt timer', {timeout:10000},async t=>{
 const f=await setup(t);
 void f.request('session/prompt',{sessionId:f.id,prompt:[{type:'text',text:'FIXTURE_WAIT'}]});
 while(JSON.parse(await fs.readFile(path.join(f.selection.route.workerHome,'fixture-sessions.json'),'utf8'))[f.id].turn===0)await new Promise(r=>setTimeout(r,5));
 const closed=once(f.p,'close');f.p.stdin.end();
 const [code,signal]=await closed;
 assert.equal(code,0);assert.equal(signal,null);
});

// Regression for the shared-HOME stale-snapshot overwrite. The audited probe
// (CWR_fixture_concurrency_probe.py) failed on the old whole-file save; this
// test pins the fixture-side fix in the normal suite. Fixture-only: it proves
// nothing about a real adapter, only that concurrent synthetic sessions survive.
async function spawnAgent(home){
 const p=spawn(process.execPath,[path.resolve('test/fixture-acp-agent.mjs')],{env:{HOME:home,PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
 let seq=0;const pending=new Map();
 const send=x=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
 readline.createInterface({input:p.stdout}).on('line',line=>{const q=JSON.parse(line);if(!q.method)pending.get(q.id)?.(q)});
 const request=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);send({id,method,params})});
 return {p,request,close:async()=>{try{if(p.exitCode===null&&p.signalCode===null){const exited=once(p,'close');p.kill('SIGTERM');await exited}}catch{}}};
}
test('synthetic ACP server self-test: two overlapping processes sharing one HOME keep both sessions', {timeout:15000},async t=>{
 const f=await fixture();t.after(f.cleanup);
 const home=f.selection.route.workerHome;await fs.mkdir(home,{mode:0o700});
 const cwdA=path.join(f.root,'ws-a'),cwdB=path.join(f.root,'ws-b');await fs.mkdir(cwdA);await fs.mkdir(cwdB);
 const a=await spawnAgent(home),b=await spawnAgent(home);
 t.after(async()=>{await a.close();await b.close()});
 await a.request('initialize',{protocolVersion:1});await b.request('initialize',{protocolVersion:1});
 const aId=(await a.request('session/new',{cwd:cwdA})).result.sessionId;
 const bId=(await b.request('session/new',{cwd:cwdB})).result.sessionId;
 await a.close();
 // A fresh process must observe BOTH durable sessions, not the last snapshot.
 const reload=await spawnAgent(home);t.after(()=>reload.close());
 await reload.request('initialize',{protocolVersion:1});
 const aLoad=await reload.request('session/load',{sessionId:aId});const bLoad=await reload.request('session/load',{sessionId:bId});
 assert.ok(!aLoad.error,`session A must reload: ${JSON.stringify(aLoad.error)}`);
 assert.ok(!bLoad.error,`session B must reload: ${JSON.stringify(bLoad.error)}`);
 const saved=JSON.parse(await fs.readFile(path.join(home,'fixture-sessions.json'),'utf8'));
 assert.equal(saved[aId].cwd,cwdA);assert.equal(saved[bId].cwd,cwdB);
});
