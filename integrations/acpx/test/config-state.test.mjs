import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig,selectRoute,buildEnvironment,canonicalFuture,prepareHome } from '../src/config.mjs';
import { regular,atomicJSON,privateDir,lock,sessionId } from '../src/state.mjs';
import { fixture } from './helpers.mjs';
async function f(t){const v=await fixture();t.after(v.cleanup);return v}
async function rewrite(v,change){change(v.raw);await fs.writeFile(v.configFile,JSON.stringify(v.raw));return loadConfig(v.configFile)}

test('disabled route never becomes a native or ACP fallback',async t=>{const v=await f(t);const c=await rewrite(v,r=>r.routes.worker.enabled=false);await assert.rejects(selectRoute(c,'worker',v.cwd),{code:'ROUTE_DISABLED'});await assert.rejects(selectRoute(c,'missing',v.cwd),{code:'ROUTE_DISABLED'})});
test('read-only route rejects full permissions',async t=>{const v=await f(t);const c=await rewrite(v,r=>r.routes.worker.maxPermissions='read');await assert.rejects(selectRoute(c,'worker',v.cwd,'full'),{code:'PERMISSION_DENIED'})});
test('workspace authorization is exact, not a directory prefix',async t=>{const v=await f(t);const child=path.join(v.cwd,'child');await fs.mkdir(child);await assert.rejects(selectRoute(v.config,'worker',child),{code:'WORKSPACE_NOT_ALLOWED'})});
test('unknown config options are rejected instead of ignored',async t=>{const v=await f(t);await assert.rejects(rewrite(v,r=>r.routes.worker.approveAll=true),{code:'BAD_CONFIG'})});
test('a shell command string is not accepted as argv',async t=>{const v=await f(t);await assert.rejects(rewrite(v,r=>r.routes.worker.argv='node fake.js; echo unsafe'),{code:'BAD_CONFIG'})});
test('route context revision changes its fingerprint',async t=>{const v=await f(t);const c=await rewrite(v,r=>r.routes.worker.contextRevision='v2');const next=await selectRoute(c,'worker',v.cwd);assert.notEqual(next.fingerprint,v.selection.fingerprint)});
test('private main home cannot be reused',async t=>{const v=await f(t);await assert.rejects(rewrite(v,r=>r.routes.worker.workerHome=v.config.mainHome),{code:'PRIVATE_HOME_REUSE'})});
test('worker state cannot be put inside the granted workspace',async t=>{const v=await f(t);await assert.rejects(rewrite(v,r=>r.stateDir=path.join(v.cwd,'state')),{code:'STATE_IN_WORKSPACE'})});
test('overlapping worker homes across routes are rejected',async t=>{const v=await f(t);await assert.rejects(rewrite(v,r=>r.routes.other={...r.routes.worker,workerHome:path.join(r.routes.worker.workerHome,'nested')}),{code:'SHARED_WORKER_HOME'})});
test('process-injection env variables cannot be forwarded',async t=>{const v=await f(t);for(const key of ['NODE_OPTIONS','LD_PRELOAD','DYLD_INSERT_LIBRARIES','CODEX_HOME','HOME','BASH_ENV'])await assert.rejects(rewrite(v,r=>r.routes.worker.passEnv=[key]),{code:'UNSAFE_ENV'})});
test('environment allowlist drops unrelated credentials and context',async t=>{const v=await f(t);const route={...v.selection.route,passEnv:['TEST_WORKER_KEY']};const env=buildEnvironment(route,{PATH:'/bin',OPENAI_API_KEY:'private',TEST_WORKER_KEY:'authorized',NODE_OPTIONS:'bad',PERSONAL_MARKER:'private'});assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.PERSONAL_MARKER,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.TEST_WORKER_KEY,'authorized');assert.equal(env.HOME,route.workerHome);assert.notEqual(env.CODEX_HOME,process.env.CODEX_HOME)});
test('real child process scrubs its own environment without touching parent',async t=>{
 const module=pathToFileURL(path.resolve('src/config.mjs')).href;
 const script=`import {replaceOwnEnvironment} from ${JSON.stringify(module)}; replaceOwnEnvironment({HOME:'/tmp/synthetic-worker',PATH:'/bin'}); console.log(JSON.stringify(process.env));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PRIVATE_MARKER:'not-forwarded'}});
 const e=JSON.parse(stdout);assert.equal(e.PRIVATE_MARKER,undefined);assert.equal(e.HOME,'/tmp/synthetic-worker');assert.notEqual(process.env.HOME,e.HOME);
});
test('missing authorized credential is reported before launch',async t=>{const v=await f(t);const c=await rewrite(v,r=>r.routes.worker.passEnv=['ABSENT_SYNTHETIC_KEY']);await assert.rejects(selectRoute(c,'worker',v.cwd,'read',{}),{code:'MISSING_CREDENTIAL_ENV'})});
test('public config mode is rejected',async t=>{const v=await f(t);await fs.chmod(v.configFile,0o644);await assert.rejects(loadConfig(v.configFile),{code:'PUBLIC_STATE'})});
test('symlink config never follows its target',async t=>{const v=await f(t);const sym=path.join(v.root,'link.json');await fs.symlink(v.configFile,sym);await assert.rejects(loadConfig(sym),{code:'UNSAFE_FILE'})});
test('hardlinked input is rejected',async t=>{const v=await f(t);const copy=path.join(v.root,'hard.json');await fs.link(v.configFile,copy);await assert.rejects(regular(copy),{code:'UNSAFE_FILE'})});
test('FIFO input is rejected without blocking',async t=>{const v=await f(t);const fifo=path.join(v.root,'pipe');await promisify(execFile)('mkfifo',[fifo]);await assert.rejects(regular(fifo),{code:'UNSAFE_FILE'})});
test('managed root symlink is rejected',async t=>{const v=await f(t);const sym=path.join(v.root,'home-link');await fs.symlink(v.cwd,sym);await assert.rejects(canonicalFuture(sym),{code:'UNSAFE_DIRECTORY'})});
test('managed descendant symlink causes no target mutation',async t=>{const v=await f(t);const d=path.join(v.root,'private');await fs.mkdir(d,{mode:0o700});const sym=path.join(d,'link');await fs.symlink(v.cwd,sym);await assert.rejects(privateDir(path.join(sym,'new')),{code:'UNSAFE_DIRECTORY'});await assert.rejects(fs.stat(path.join(v.cwd,'new')),{code:'ENOENT'})});
test('atomic write refuses symlink and preserves external target',async t=>{const v=await f(t);const target=path.join(v.root,'target');await fs.writeFile(target,'original',{mode:0o600});const link=path.join(v.root,'state-link');await fs.symlink(target,link);await assert.rejects(atomicJSON(link,{}),{code:'UNSAFE_FILE'});assert.equal(await fs.readFile(target,'utf8'),'original')});
test('bounded reader rejects large files',async t=>{const v=await f(t);await fs.writeFile(v.orderFile,'x'.repeat(5000));await assert.rejects(regular(v.orderFile,{maxBytes:4096}),{code:'INPUT_TOO_LARGE'})});
test('mutex rejects a second owner, never automatically deletes a stale lock',async t=>{const v=await f(t);const p=path.join(v.root,'lock');const release=await lock(p,{nonce:'one',pid:2147483647});await assert.rejects(lock(p,{nonce:'two'}),{code:'BUSY_OR_UNRECONCILED'});await release();const release2=await lock(p,{nonce:'three'});await release2()});
test('session ids cannot escape the binding directory',()=>{for(const bad of ['../x','/tmp/x','x','deadbeef'])assert.throws(()=>sessionId(bad),{code:'BAD_SESSION_ID'})});
test('worker home creation produces private, separate CLI config locations',async t=>{const v=await f(t);await prepareHome(v.selection.route);for(const d of ['.codex','.claude','.config','tmp']){const s=await fs.stat(path.join(v.selection.route.workerHome,d));assert.equal(s.mode&0o077,0)}});
