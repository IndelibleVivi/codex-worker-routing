#!/usr/bin/env node
// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Fault, atomicJSON, privateDir, paths, lock, loadBinding, readJSON, digest } from './state.mjs';
import { loadConfig, loadControlConfig, selectRoute, buildEnvironment, prepareHome, readOrder, replaceOwnEnvironment, assertSupportedPlatform } from './config.mjs';
import { executeTurn, closeBinding } from './engine.mjs';

const HELP = `cwr-acp (optional channel; does not replace native subagents)
  run      --config FILE --route NAME --cwd DIR --file ORDER [--permissions read|full]
  continue --config FILE --session UUID --file INCREMENT [--permissions read|full]
  status   --config FILE --session UUID
  cancel   --config FILE --session UUID
  close    --config FILE --session UUID

run/continue block until a terminal result and connection cleanup. Ctrl+C/SIGTERM
request cancellation. cancel writes a nonce-bound local request; it does not
claim the worker has stopped. No automatic route fallback or background wakeup.
`;
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') return { command: 'help' };
  const allowed = {
    run: ['config','route','cwd','file','permissions'], continue: ['config','session','file','permissions'],
    status: ['config','session'], cancel: ['config','session'], close: ['config','session'],
  };
  if (!allowed[command]) throw new Fault('USAGE', 'Unknown command. Run --help.');
  const out = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.slice(2);
    if (!rest[i]?.startsWith('--') || !allowed[command].includes(name) || out[name] !== undefined || !rest[i+1] || rest[i+1].startsWith('--'))
      throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    out[name] = rest[i+1];
  }
  const required = command === 'run' ? ['config','route','cwd','file'] : command === 'continue' ? ['config','session','file'] : ['config','session'];
  if (required.some(k => !out[k])) throw new Fault('USAGE', 'Required option missing. Run --help.');
  return out;
}
export async function loadAcpx() {
  try {
    const require = createRequire(import.meta.url);
    const version = require('acpx/package.json').version;
    if (version !== '0.15.1') throw new Fault('UNTESTED_ACPX_VERSION', 'This integration targets acpx 0.15.1. Revalidate before changing versions.');
    const api = await import('acpx/runtime');
    if (typeof api.createAcpRuntime !== 'function' || typeof api.createRuntimeStore !== 'function' || typeof api.decodeAcpxRuntimeHandleState !== 'function')
      throw new Fault('ACP_API_MISMATCH', 'Expected runtime exports are unavailable.');
    return api;
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND')
      throw new Fault('ACPX_NOT_INSTALLED', 'Install the optional integration dependency in integrations/acpx; native routing remains available.');
    throw e;
  }
}
export async function localStatus(config, binding) {
  const p = paths(config.stateDir, binding.id);
  let lockPresent = false;
  try { await privateDir(p.lock, { create: false }); lockPresent = true; }
  catch (e) { if (e.code !== 'STATE_MISSING') throw e; }
  let owner = null;
  if (lockPresent) {
    try { owner = await readJSON(path.join(p.lock, 'owner.json'), { privateFile: true }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // An ownerless lock is still unreconciled: a new operation will reject it.
  let active = lockPresent ? 'unreconciled' : 'idle';
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); active = 'owner_process_present'; }
    catch { /* PID is a hint only. Never auto-reclaim. */ }
  }
  return { schema:'cwr.acp.status/1', session_id:binding.id, active,
    closed:binding.closed === true, last_runtime_status:binding.lastStatus ?? null,
    cleanup:binding.cleanup ?? 'unknown', last_receipt:binding.lastReceipt ?? null };
}
export async function requestCancel(config, binding) {
  const p = paths(config.stateDir, binding.id);
  await privateDir(p.lock, { create:false });
  const owner = await readJSON(path.join(p.lock, 'owner.json'), { privateFile:true });
  if (typeof owner.nonce !== 'string') throw new Fault('BAD_LOCK', 'Invalid owner token.');
  // Do not use atomicJSON here: a concurrent terminal cleanup must not recreate
  // a deleted lock directory. Exclusive creation has no mkdir side effects.
  let h;
  try { h = await fs.open(path.join(p.lock, 'cancel.json'), 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = await readJSON(path.join(p.lock,'cancel.json'), {privateFile:true});
    if (old.nonce !== owner.nonce) throw new Fault('LOCK_CHANGED','Cancellation belongs to a different operation.');
  }
  if (h) try { await h.writeFile(JSON.stringify({nonce:owner.nonce})); await h.sync(); } finally { await h.close(); }
  return { schema:'cwr.acp.control/1', session_id:binding.id, cancel_requested:true, stopped:false };
}

export async function main(args, deps = {}) {
  const opt = parseArgs(args);
  const output = deps.output ?? (r => process.stdout.write(`${JSON.stringify(r)}\n`));
  if (opt.command === 'help') { (deps.help ?? (s => process.stdout.write(s)))(HELP); return 0; }
  assertSupportedPlatform();
  const controlOnly = opt.command === 'status' || opt.command === 'cancel' || opt.command === 'close';
  const config = controlOnly ? await loadControlConfig(opt.config) : await loadConfig(opt.config);
  let binding;
  if (opt.command !== 'run') binding = await loadBinding(config.stateDir, opt.session);
  if (opt.command === 'status') { output(await localStatus(config,binding)); return 0; }
  if (opt.command === 'cancel') { output(await requestCancel(config,binding)); return 0; }
  if (opt.command === 'close') {
    const p = paths(config.stateDir,binding.id);
    const unlock = await lock(p.lock,{nonce:randomUUID(),pid:process.pid});
    try { output(await closeBinding({config,binding})); return 0; } finally { await unlock(); }
  }
  if (binding?.closed) throw new Fault('SESSION_CLOSED','The work order is closed.');
  const selection = await selectRoute(config, opt.route ?? binding.route, opt.cwd ?? binding.cwd, opt.permissions ?? 'read');
  if (binding && selection.fingerprint !== binding.routeFingerprint) throw new Fault('ROUTE_CHANGED','Route/context revision changed. Start an explicit new responsibility.');
  const text = await readOrder(opt.file);
  // The child-only environment option in acpx is not assumed to be a scrubber.
  // Scrub this standalone CLI process BEFORE importing/executing that package.
  // This never changes the shell, Codex, or the native subagent environment.
  const env = buildEnvironment(selection.route);
  await (deps.replaceEnvironment ?? replaceOwnEnvironment)(env);
  const acpx = await (deps.loadAcpx ?? loadAcpx)();
  await prepareHome(selection.route);
  await privateDir(config.stateDir);
  if (!binding) binding = {
    schema:'cwr.acp.binding/1',id:randomUUID(),route:selection.name,
    routeFingerprint:selection.fingerprint,cwd:selection.cwd,closed:false,
    createdAt:new Date().toISOString(),handle:null,
  };
  const p = paths(config.stateDir,binding.id);
  const owner = {nonce:randomUUID(),pid:process.pid,session:binding.id,startedAt:new Date().toISOString()};
  // Conservatively serialize all ACP operations for the exact workspace.
  // This lock does not govern native Codex writers. Coordinate them/worktrees upstream.
  const unlockWorkspace = await lock(path.join(config.stateDir,'workspace-locks',digest(selection.cwd)),owner);
  let unlockSession;
  try { unlockSession = await lock(p.lock,owner); }
  catch (e) { await unlockWorkspace(); throw e; }
  let safeRelease = false, timer, receipt;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Fault('CANCEL_REQUESTED','Cancellation requested.'));
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
  // A bounded local control-mailbox check, not model polling/status inference.
  let checking = false;
  timer = setInterval(async () => {
    if (checking) return; checking = true;
    try {
      const request = await readJSON(path.join(p.lock,'cancel.json'),{privateFile:true,maxBytes:4096});
      if (request.nonce === owner.nonce) interrupt();
    } catch (e) { if (e.code !== 'ENOENT') interrupt(); }
    finally { checking = false; }
  },200);
  try {
    if (opt.command === 'run') await atomicJSON(p.binding,binding);
    (deps.progress ?? (s => process.stderr.write(s)))(`[acp] session ${binding.id}; ${selection.permissions} permissions\n`);
    receipt = await executeTurn({config,selection,binding,text,isNew:opt.command==='run',acpx,signal:controller.signal});
    safeRelease = receipt.cleanup === 'confirmed';

  } finally {
    clearInterval(timer);
    process.off('SIGINT',interrupt); process.off('SIGTERM',interrupt);
    if (safeRelease) {
      try {
        const c = await readJSON(path.join(p.lock,'cancel.json'),{privateFile:true});
        if (c.nonce !== owner.nonce) throw new Fault('LOCK_CHANGED','Unexpected cancellation token.');
        await fs.unlink(path.join(p.lock,'cancel.json'));
      } catch(e) { if(e.code!=='ENOENT') throw e; }
      await unlockSession(); await unlockWorkspace();
    }
    // Unconfirmed cleanup/crashes retain locks. A second writer may not start.
  }
  output(receipt);
  return receipt.runtime_status==='completed' && safeRelease ? 0 : receipt.runtime_status==='cancelled' ? 130 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => {
    const code = typeof e.code==='string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'INTEGRATION_ERROR';
    process.stderr.write(JSON.stringify({schema:'cwr.acp.error/1',code,message:e instanceof Fault?e.message:'Local operation failed. Inspect the private runtime state; no route fallback occurred.'})+'\n');
    process.exitCode=2;
  });
}
