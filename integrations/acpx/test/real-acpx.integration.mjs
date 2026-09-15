// This suite intentionally FAILS if the pinned package is missing. It never
// substitutes the contract double. Execute with `npm run test:acpx` after install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAcpx } from '../src/cli.mjs';
import { fixture } from './helpers.mjs';
const execute=promisify(execFile);
const cli=path.resolve('src/cli.mjs'),agent=path.resolve('test/fixture-acp-agent.mjs');
async function setup(t){await loadAcpx();const f=await fixture({argv:[process.execPath,agent],timeoutMs:5000});t.after(f.cleanup);return f}
async function command(f,verb,extra=[]){
 const args=[cli,verb,'--config',f.configFile,...extra];
 try{const r=await execute(process.execPath,args,{timeout:25000,maxBuffer:512*1024,env:{...process.env,CWR_PRIVATE_TEST_MARKER:'MUST_NOT_ARRIVE'}});return {code:0,...r,receipt:JSON.parse(r.stdout)}}
 catch(e){return {code:e.code,stdout:e.stdout,stderr:e.stderr,receipt:e.stdout?.trim()?JSON.parse(e.stdout):null}}
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
