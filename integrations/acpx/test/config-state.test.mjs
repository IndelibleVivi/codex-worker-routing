import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig,selectRoute,buildEnvironment,canonicalFuture,prepareHome,executableProblem,assertLocalManagedPath,assertSupportedPlatform } from '../src/config.mjs';
import { regular,atomicJSON,privateDir,lock,sessionId,ancestorPaths,assertPrivateMode,syncDirectory,exposesPosixModes } from '../src/state.mjs';
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
test('environment allowlist drops unrelated credentials and context',async t=>{const v=await f(t);const route={...v.selection.route,passEnv:['TEST_WORKER_KEY']};const env=buildEnvironment(route,{PATH:'/bin',OPENAI_API_KEY:'private',TEST_WORKER_KEY:'authorized',NODE_OPTIONS:'bad',PERSONAL_MARKER:'private'});assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.PERSONAL_MARKER,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.TEST_WORKER_KEY,'authorized');assert.equal(env.HOME,route.workerHome);assert.notEqual(env.CODEX_HOME,process.env.CODEX_HOME);assert.equal(buildEnvironment(route,{}).PATH,'/usr/local/bin:/usr/bin:/bin')});
test('real child process scrubs its own environment without touching parent',async t=>{
 const module=pathToFileURL(path.resolve('src/config.mjs')).href;
 const script=`import {replaceOwnEnvironment} from ${JSON.stringify(module)}; replaceOwnEnvironment({HOME:'/tmp/synthetic-worker',PATH:'/bin'}); console.log(JSON.stringify(process.env));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PRIVATE_MARKER:'not-forwarded'}});
 const e=JSON.parse(stdout);assert.equal(e.PRIVATE_MARKER,undefined);assert.equal(e.HOME,'/tmp/synthetic-worker');assert.notEqual(process.env.HOME,e.HOME);
});
test('missing authorized credential is reported before launch',async t=>{const v=await f(t);const c=await rewrite(v,r=>r.routes.worker.passEnv=['ABSENT_SYNTHETIC_KEY']);await assert.rejects(selectRoute(c,'worker',v.cwd,'read',{}),{code:'MISSING_CREDENTIAL_ENV'})});
test('public config mode is rejected wherever POSIX modes are evidence',async t=>{const v=await f(t);await fs.chmod(v.configFile,0o644);if(!exposesPosixModes()){const c=await loadConfig(v.configFile);assert.ok(c.routes.worker);return}await assert.rejects(loadConfig(v.configFile),{code:'PUBLIC_STATE'})});
test('symlink config never follows its target',async t=>{const v=await f(t);const sym=path.join(v.root,'link.json');await fs.symlink(v.configFile,sym);await assert.rejects(loadConfig(sym),{code:'UNSAFE_FILE'})});
test('hardlinked input is rejected',async t=>{const v=await f(t);const copy=path.join(v.root,'hard.json');await fs.link(v.configFile,copy);await assert.rejects(regular(copy),{code:'UNSAFE_FILE'})});
test('non-regular input is rejected without blocking',async t=>{const v=await f(t);if(process.platform==='win32'){await assert.rejects(regular(v.root),{code:'UNSAFE_FILE'});return}const fifo=path.join(v.root,'pipe');await promisify(execFile)('mkfifo',[fifo]);await assert.rejects(regular(fifo),{code:'UNSAFE_FILE'})});
test('managed root symlink is rejected',async t=>{const v=await f(t);const sym=path.join(v.root,'home-link');await fs.symlink(v.cwd,sym);await assert.rejects(canonicalFuture(sym),{code:'UNSAFE_DIRECTORY'})});
test('managed descendant symlink causes no target mutation',async t=>{const v=await f(t);const d=path.join(v.root,'private');await fs.mkdir(d,{mode:0o700});const sym=path.join(d,'link');await fs.symlink(v.cwd,sym);await assert.rejects(privateDir(path.join(sym,'new')),{code:'UNSAFE_DIRECTORY'});await assert.rejects(fs.stat(path.join(v.cwd,'new')),{code:'ENOENT'})});
test('atomic write refuses symlink and preserves external target',async t=>{const v=await f(t);const target=path.join(v.root,'target');await fs.writeFile(target,'original',{mode:0o600});const link=path.join(v.root,'state-link');await fs.symlink(target,link);await assert.rejects(atomicJSON(link,{}),{code:'UNSAFE_FILE'});assert.equal(await fs.readFile(target,'utf8'),'original')});
test('bounded reader rejects large files',async t=>{const v=await f(t);await fs.writeFile(v.orderFile,'x'.repeat(5000));await assert.rejects(regular(v.orderFile,{maxBytes:4096}),{code:'INPUT_TOO_LARGE'})});
test('mutex rejects a second owner, never automatically deletes a stale lock',async t=>{const v=await f(t);const p=path.join(v.root,'lock');const release=await lock(p,{nonce:'one',pid:2147483647});await assert.rejects(lock(p,{nonce:'two'}),{code:'BUSY_OR_UNRECONCILED'});await release();const release2=await lock(p,{nonce:'three'});await release2()});
test('session ids cannot escape the binding directory',()=>{for(const bad of ['../x','/tmp/x','x','deadbeef'])assert.throws(()=>sessionId(bad),{code:'BAD_SESSION_ID'})});
test('worker home creation produces private, separate CLI config locations',async t=>{const v=await f(t);await prepareHome(v.selection.route);for(const d of ['.codex','.claude','.config','tmp']){const s=await fs.stat(path.join(v.selection.route.workerHome,d));assert.ok(s.isDirectory());if(exposesPosixModes())assert.equal(s.mode&0o077,0)}});

// The previous walk split the raw absolute path, so a Windows drive letter or a
// UNC share was appended to its own root and every ancestor probe hit a bogus
// path such as "C:\C:". Walking relative to the parsed root is the fix.
test('managed-ancestor walk never repeats a drive or UNC root',()=>{
 const win=path.win32;
 assert.deepEqual(ancestorPaths('C:\\a\\b',win),{root:'C:\\',ancestors:['C:\\a','C:\\a\\b']});
 assert.deepEqual(ancestorPaths('C:\\',win),{root:'C:\\',ancestors:[]});
 assert.deepEqual(ancestorPaths('\\\\server\\share\\dir',win),{root:'\\\\server\\share\\',ancestors:['\\\\server\\share\\dir']});
 assert.deepEqual(ancestorPaths('/a/b',path.posix),{root:'/',ancestors:['/a','/a/b']});
 for(const impl of [win,path.posix])assert.throws(()=>ancestorPaths('relative/dir',impl),{code:'RELATIVE_STATE'});
});
test('private-mode enforcement follows platform capability, not assumed POSIX bits',()=>{
 assert.throws(()=>assertPrivateMode({mode:0o644},'file','linux'),{code:'PUBLIC_STATE'});
 assert.throws(()=>assertPrivateMode({mode:0o755},'directory','darwin'),{code:'PUBLIC_STATE'});
 assert.throws(()=>assertPrivateMode({mode:0o666},'file','linux'),{code:'PUBLIC_STATE'});
 assert.equal(assertPrivateMode({mode:0o666},'file','win32'),undefined);
 assert.equal(assertPrivateMode({mode:0o777},'directory','win32'),undefined);
});
test('state privacy checks accept platform-reported 0666/0755 only where Node exposes no POSIX evidence',async t=>{
 const v=await f(t);const d=path.join(v.root,'mode-target');
 await fs.mkdir(d,{mode:0o755});await fs.chmod(d,0o755);
 await privateDir(d,{create:false,platform:'win32'});
 await assert.rejects(privateDir(d,{create:false,platform:'linux'}),{code:'PUBLIC_STATE'});
 const file=path.join(d,'receipt.json');await fs.writeFile(file,'{}',{mode:0o644});await fs.chmod(file,0o644);
 assert.equal(await regular(file,{privateFile:true,platform:'win32'}),'{}');
 await assert.rejects(regular(file,{privateFile:true,platform:'linux'}),{code:'PUBLIC_STATE'});
 await atomicJSON(file,{ok:true},{platform:'win32'});
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{ok:true});
});
test('directory fsync is attempted only where Node exposes it',async t=>{
 const v=await f(t);const missing=path.join(v.root,'no-such-directory');
 assert.equal(await syncDirectory(missing,'win32'),undefined);
 await assert.rejects(syncDirectory(missing,'linux'),{code:'ENOENT'});
});
test('passEnv cannot reach isolation-critical names by case variation',async t=>{
 const v=await f(t);
 for(const key of ['home','Home','USERPROFILE','userprofile','path','Path','comspec','appdata','localappdata','temp','windir','systemroot','pathext','homedrive','systemdrive'])
  await assert.rejects(rewrite(v,r=>r.routes.worker.passEnv=[key]),{code:'UNSAFE_ENV'});
});
test('Windows worker environment relocates temp, profile and launcher variables',async t=>{
 const v=await f(t);const home='C:\\synthetic\\worker';
 const ambient={Path:'C:\\Windows\\System32',home:'C:\\Users\\attacker',USERPROFILE:'C:\\Users\\attacker',COMSPEC:'C:\\Windows\\System32\\cmd.exe',PATHEXT:'.EXE;.CMD',SystemRoot:'C:\\Windows',TEST_WORKER_KEY:'authorized',OPENAI_API_KEY:'private'};
 const env=buildEnvironment({...v.selection.route,workerHome:home,passEnv:['TEST_WORKER_KEY','USERPROFILE','home','Path','COMSPEC','PATHEXT']},ambient,'win32');
 assert.equal(env.HOME,home);assert.equal(env.USERPROFILE,home);
 assert.equal(env.TEMP,path.join(home,'tmp'));assert.equal(env.TMP,path.join(home,'tmp'));
 assert.equal(env.APPDATA,path.join(home,'AppData','Roaming'));
 assert.equal(env.LOCALAPPDATA,path.join(home,'AppData','Local'));
 assert.equal(env.PATH,ambient.Path);
 assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.windir,'C:\\Windows');
 assert.equal(env.COMSPEC,ambient.COMSPEC);assert.equal(env.PATHEXT,ambient.PATHEXT);
 assert.equal(env.TEST_WORKER_KEY,'authorized');assert.equal(env.OPENAI_API_KEY,undefined);
});
test('Windows temp and launcher variables fall back to defaults when the ambient copy is absent',async t=>{
 const v=await f(t);const home='C:\\synthetic\\worker';
 const env=buildEnvironment({...v.selection.route,workerHome:home,passEnv:[]},{},'win32');
 assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.windir,'C:\\Windows');
 assert.equal(env.COMSPEC,path.join('C:\\Windows','System32','cmd.exe'));
 assert.equal(env.PATHEXT,'.COM;.EXE;.BAT;.CMD');
 assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
});
test('Windows accepts only launchable entry extensions; POSIX still requires an execute bit',()=>{
 const file=mode=>({isFile:()=>true,mode});
 for(const ext of ['.exe','.EXE','.com','.cmd','.bat'])assert.equal(executableProblem(`C:\\opt\\agent${ext}`,file(0o666),'win32'),null);
 for(const ext of ['.ps1','.sh','.mjs',''])assert.match(executableProblem(`C:\\opt\\agent${ext}`,file(0o666),'win32'),/exe, \.com, \.cmd or \.bat/);
 assert.equal(executableProblem('/usr/bin/agent',file(0o755),'linux'),null);
 assert.match(executableProblem('/usr/bin/agent',file(0o644),'linux'),/executable/);
 assert.match(executableProblem('/usr/bin/agent',{isFile:()=>false,mode:0o755},'linux'),/regular file/);
});
test('managed roots reject Windows network, UNC and device paths before any use',()=>{
 for(const bad of ['\\\\server\\share\\state','\\\\?\\C:\\state','\\\\.\\PhysicalDrive0','//server/share/state'])
  assert.throws(()=>assertLocalManagedPath(bad,'stateDir','win32'),{code:'UNSUPPORTED_PATH_ROOT'});
 assert.equal(assertLocalManagedPath('C:\\state','stateDir','win32'),'C:\\state');
 assert.equal(assertLocalManagedPath('/tmp/state','stateDir','linux'),'/tmp/state');
 assert.equal(assertLocalManagedPath('//not-checked-on-posix','stateDir','linux'),'//not-checked-on-posix');
});
test('supported platforms are an explicit allowlist, not an implicit POSIX assumption',()=>{
 for(const p of ['darwin','linux','win32'])assert.equal(assertSupportedPlatform(p),p);
 for(const p of ['freebsd','aix','sunos',''])assert.throws(()=>assertSupportedPlatform(p),{code:'UNSUPPORTED_PLATFORM'});
});
test('packaging declares Windows and uses a shell-independent test file list',async()=>{
 const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.ok(pkg.os.includes('win32'),'npm ci must not fail closed on Windows with EBADPLATFORM');
 assert.ok(!pkg.scripts.test.includes('*'),'an unexpanded shell glob would be passed literally by cmd.exe');
 for(const f of ['cli','config-state','engine','fixture'])assert.ok(pkg.scripts.test.includes(`test/${f}.test.mjs`));
});

const windowsOnly=process.platform==='win32'?test:test.skip;
windowsOnly('windows: an existing drive-rooted state directory is accepted with create:false',async t=>{
 const v=await f(t);const deep=path.join(v.root,'state','bindings','synthetic');
 await privateDir(deep);await privateDir(deep,{create:false});
 assert.ok((await fs.lstat(deep)).isDirectory());
 await assert.rejects(privateDir(path.join(v.root,'absent','synthetic'),{create:false}),{code:'STATE_MISSING'});
});
windowsOnly('windows: a junction ancestor is rejected and never materializes the target',async t=>{
 const v=await f(t);const target=path.join(v.root,'junction-target');await fs.mkdir(target,{recursive:true});
 const junction=path.join(v.root,'junction');
 // No skip path: this regression is the evidence for Windows ancestor
 // no-follow handling, so an environment that cannot create a junction fails.
 await fs.symlink(target,junction,'junction');
 await assert.rejects(privateDir(path.join(junction,'state')),{code:'UNSAFE_DIRECTORY'});
 await assert.rejects(fs.stat(path.join(target,'state')),{code:'ENOENT'});
});
windowsOnly('windows: UNC managed roots are rejected during config load',async t=>{
 const v=await f(t);v.raw.stateDir='\\\\synthetic-server\\share\\state';
 await fs.writeFile(v.configFile,JSON.stringify(v.raw));
 await assert.rejects(loadConfig(v.configFile),{code:'UNSUPPORTED_PATH_ROOT'});
});
