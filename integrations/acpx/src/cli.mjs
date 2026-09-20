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
import { EVENT_SCHEMA, REASON_VALUES, recordEvent, createProjectionReader, normalizeSince, captureParentMetadata, writeRequestOrder, listPendingSessions } from './dispatch.mjs';


// Property tables for the argument parser. `flags` take no value; `values` take
// exactly one. The legacy commands keep their exact option sets. `--json` is a
// bare flag so the parser never mistakes it for the value of a preceding option.
const FLAG = Object.freeze({
  stats: ['json'],
});
const VALUES = Object.freeze({
  run: ['config', 'route', 'cwd', 'file', 'permissions', 'title', 'category'],
  continue: ['config', 'session', 'file', 'permissions', 'revision-reason'],
  status: ['config', 'session'],
  cancel: ['config', 'session'],
  close: ['config', 'session'],
  stats: ['config', 'since', 'time-zone'],
  record: ['config', 'session', 'file'],
  pending: ['config'],
  dashboard: ['config', 'since', 'port'],
});
const REQUIRED = Object.freeze({
  run: ['config', 'route', 'cwd', 'file'],
  continue: ['config', 'session', 'file'],
  status: ['config', 'session'],
  cancel: ['config', 'session'],
  close: ['config', 'session'],
  stats: ['config'],
  record: ['config', 'session', 'file'],
  pending: ['config'],
  dashboard: ['config'],
});
export const COMMANDS = Object.freeze(Object.keys(VALUES));

const HELP = `cwr-acp (optional channel; does not replace native subagents)
  run      --config FILE --route NAME --cwd DIR --file ORDER [--permissions read|full]
           [--title TEXT] [--category investigation|implementation|review|other]
  continue --config FILE --session UUID --file INCREMENT [--permissions read|full]
           [--revision-reason REASON]
  status   --config FILE --session UUID
  cancel   --config FILE --session UUID
  close    --config FILE --session UUID
  record   --config FILE --session UUID --file EVENT_JSON
  pending  --config FILE
  stats    --config FILE [--since 7d|30d|all|ISO_DATE] [--time-zone IANA_ZONE] [--json]
  dashboard --config FILE [--since 7d|30d|all|ISO_DATE] [--port NUMBER]

run/continue block until a terminal result and connection cleanup. Ctrl+C/SIGTERM
request cancellation. cancel writes a nonce-bound local request; it does not
claim the worker has stopped. No automatic route fallback or background wakeup.

stats, record and pending read the private state root only; they never load,
import or scrub for an ACP adapter. dashboard dynamically imports ./dashboard.mjs.
record appends one collaboration event and never rewrites a runtime receipt.
Dashboard data is read-only; theme, language and time zone are local display preferences.

continue --revision-reason REASON is an OPTIONAL shortcut for a genuine
correction: it appends a revision_requested event (using the documented reason
enum) before the prompt, so the rework is attributed without a separate file. It
is not required for ordinary continuation, and a plain continue never records a
revision. If the annotation cannot be recorded, the interruption is surfaced as a
dispatch warning and the authorized task still runs exactly once. REASON is one
of requirement_missed, validation_failed, scope_changed, constraint_added,
environment_blocked, uncertain.

Review state is derived automatically from existing receipts and explicit review
events; ordinary completion or close without any annotation is normal and is not
an outstanding review obligation. pending is an on-demand read-only view of only
actionable records (awaiting_review, changes_requested, needs_attention); it is
not a backlog you must clear. Safe ids, state, status and title only.
`;
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') return { command: 'help' };
  const values = VALUES[command], flags = FLAG[command] ?? [];
  if (!values) throw new Fault('USAGE', 'Unknown command. Run --help.');
  const out = { command };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]?.startsWith('--')) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    const name = rest[i]?.slice(2);
    if (flags.includes(name)) {
      if (out[name] !== undefined) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
      out[name] = true;
      continue;
    }
    if (!values.includes(name) || out[name] !== undefined) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    out[name] = value; i++;
  }
  if (REQUIRED[command].some(k => !out[k])) throw new Fault('USAGE', 'Required option missing. Run --help.');
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
  const text = deps.text ?? (s => process.stdout.write(s));
  if (opt.command === 'help') { (deps.help ?? (s => process.stdout.write(s)))(HELP); return 0; }
  assertSupportedPlatform();
  if (opt.command === 'stats') {
    const config = await loadControlConfig(opt.config);
    const projection = await createProjectionReader(config.stateDir).read({ since: opt.since ?? 'all', timeZone:opt['time-zone'] ?? 'UTC' });
    if (opt.json) output(projection); else text(renderStatsText(projection));
    return 0;
  }
  if (opt.command === 'record') {
    const config = await loadControlConfig(opt.config);
    const event = JSON.parse(await readOrder(opt.file));
    output(await recordEvent(config.stateDir, opt.session, event));
    return 0;
  }
  if (opt.command === 'pending') {
    // Read-only: actionable tracked review records only, no legacy backlog and
    // no adapter. Never prints work-order text, output or a filesystem path.
    const config = await loadControlConfig(opt.config);
    output(await listPendingSessions(config.stateDir));
    return 0;
  }
  if (opt.command === 'dashboard') {
    const config = await loadControlConfig(opt.config);
    return startDashboardCommand(config, opt, { text, output, deps });
  }
  const controlOnly = opt.command === 'status' || opt.command === 'cancel' || opt.command === 'close';
  const config = controlOnly ? await loadControlConfig(opt.config) : await loadConfig(opt.config);
  if (opt.command === 'run' || opt.command === 'continue') {
    if (opt.title !== undefined) {
      if (typeof opt.title !== 'string' || !opt.title.trim() || [...opt.title].length > 160)
        throw new Fault('USAGE', '--title must be a non-empty string of at most 160 characters.');
    }
    if (opt.category !== undefined && !['investigation', 'implementation', 'review', 'other'].includes(opt.category))
      throw new Fault('USAGE', '--category must be investigation, implementation, review or other.');
    // Validated in NORMAL preflight, before any lock or prompt, so an invalid
    // reason never starts an adapter turn.
    if (opt['revision-reason'] !== undefined) {
      if (opt.command !== 'continue') throw new Fault('USAGE', '--revision-reason is only valid for continue.');
      if (!REASON_VALUES.includes(opt['revision-reason']))
        throw new Fault('USAGE', `--revision-reason must be one of ${REASON_VALUES.join(', ')}.`);
    }
    // The parent identifiers come from the coordinator's own process and must be
    // captured BEFORE buildEnvironment/replaceOwnEnvironment scrubs them. They
    // are identifiers only; nothing is taken from the child environment.
    config.dispatch = {
      parent: captureParentMetadata(process.env),
      titleProvided: opt.title !== undefined, title: opt.title,
      categoryProvided: opt.category !== undefined, category: opt.category,
    };
  }
  let binding;
  if (opt.command !== 'run') binding = await loadBinding(config.stateDir, opt.session);
  if (opt.command === 'status') { output(await localStatus(config,binding)); return 0; }
  if (opt.command === 'cancel') { output(await requestCancel(config,binding)); return 0; }
  if (opt.command === 'close') {
    const p = paths(config.stateDir,binding.id);
    const unlock = await lock(p.lock,{nonce:randomUUID(),pid:process.pid});
    try {
      // Reload under the held session lock so a concurrent change between the
      // initial read and lock acquisition cannot close stale state.
      const current = await loadBinding(config.stateDir, binding.id);
      output(await closeBinding({config,binding:current})); return 0;
    } finally { await unlock(); }
  }
  if (binding?.closed) throw new Fault('SESSION_CLOSED','The work order is closed.');
  const selection = await selectRoute(config, opt.route ?? binding.route, opt.cwd ?? binding.cwd, opt.permissions ?? 'read');
  if (binding && selection.fingerprint !== binding.routeFingerprint) throw new Fault('ROUTE_CHANGED','Route/context revision changed. Start an explicit new responsibility.');
  const order = await readOrder(opt.file);
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
  // One request id for this turn, and the exact submitted work-order text
  // retained in a separate private per-request file for EVERY new run/continue
  // invocation, so a continuation increment is preserved too. The receipt can
  // carry the pointer locally; a projection never sends a filesystem pointer.
  const requestId = randomUUID();
  let orderPointer = null, metadataWarning = null;
  config.dispatch = { ...(config.dispatch ?? {}), requestId, orderPointer: null, orderWarning: null };
  // Conservatively serialize all ACP operations for the exact workspace.
  // This lock does not govern native Codex writers. Coordinate them/worktrees upstream.
  const unlockWorkspace = await lock(path.join(config.stateDir,'workspace-locks',digest(selection.cwd)),owner);
  let unlockSession;
  try { unlockSession = await lock(p.lock,owner); }
  catch (e) { await unlockWorkspace(); throw e; }
  // Locks are held: retain the work order now, before the runtime is touched.
  // Retention failure is deliberately additive: it never changes runtime
  // behavior, but it is recorded durably in the receipt as a warning.
  try { orderPointer = await writeRequestOrder(config.stateDir, binding.id, requestId, order); }
  catch (e) { metadataWarning = 'ORDER_NOT_RETAINED'; }
  config.dispatch.orderPointer = orderPointer;
  config.dispatch.orderWarning = metadataWarning;
  let safeRelease = false, timer, receipt;
  let runtimeStarted = false;
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
    // Fresh read under BOTH held locks: a continue/run that read an open binding
    // before a concurrent close could otherwise execute its stale open binding.
    // Reload, recheck closure and route fingerprint, and use the current handle
    // so no review write or prompt proceeds against superseded state. Errors here
    // happen before the runtime is touched, so the finally block safely releases
    // every owned lock.
    if (binding && opt.command === 'continue') {
      const current = await loadBinding(config.stateDir, binding.id);
      if (current.closed === true) throw new Fault('SESSION_CLOSED', 'The work order is closed.');
      if (current.routeFingerprint !== selection.fingerprint)
        throw new Fault('ROUTE_CHANGED', 'Route/context revision changed. Start an explicit new responsibility.');
      binding = current;
    }
    if (opt.command === 'run') await atomicJSON(p.binding,binding);
    // OPTIONAL `continue --revision-reason REASON` records one revision_requested
    // event before the prompt. It is a shortcut for a genuine correction, not a
    // required annotation. The reason is validated during normal continuation
    // preflight above; an annotation WRITE failure never blocks the authorized
    // task: it is surfaced through the existing additive dispatch warning path
    // and execution proceeds exactly once.
    if (opt['revision-reason'] !== undefined) {
      try {
        await recordEvent(config.stateDir, binding.id, {
          schema: EVENT_SCHEMA, event_id: randomUUID(), session_id: binding.id,
          kind: 'revision_requested', reason: opt['revision-reason'],
          request_id: null, summary: null, evidence: [], supersedes: null,
        });
      } catch (e) {
        // Retain any earlier warning information instead of overwriting it.
        const prior = config.dispatch.orderWarning;
        config.dispatch.orderWarning = prior && prior !== 'REVIEW_NOT_RECORDED' && !String(prior).includes('REVIEW_NOT_RECORDED')
          ? `${prior}+REVIEW_NOT_RECORDED` : 'REVIEW_NOT_RECORDED';
        (deps.progress ?? (s => process.stderr.write(s)))(`[acp] revision annotation not recorded (${typeof e?.code === 'string' ? e.code : 'REVIEW_NOT_RECORDED'}); continuing.\n`);
      }
    }
    runtimeStarted = true;
    (deps.progress ?? (s => process.stderr.write(s)))(`[acp] session ${binding.id}; ${selection.permissions} permissions\n`);
    receipt = await executeTurn({config,selection,binding,text:order,isNew:opt.command==='run',acpx,signal:controller.signal,requestId});
    safeRelease = receipt.cleanup === 'confirmed';

  } finally {
    clearInterval(timer);
    process.off('SIGINT',interrupt); process.off('SIGTERM',interrupt);
    // A failure before the runtime was touched (for example a stale binding)
    // leaves no adapter process behind, so the owned locks
    // are safely releasable and are not retained for reconciliation.
    if (!runtimeStarted) safeRelease = true;
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

// Text rendering is a convenience view over the same projection object. It
// never adds a metric or an inference the JSON projection does not already
// contain, and it never prints a filesystem path.
export function renderStatsText(p) {
  const s = p.summary;
  const period = s ? (p.period.since ? `${p.period.since} .. ${p.period.until}` : `all .. ${p.period.until}`) : '';
  const lines = [
    `Dispatch (${p.period.since ? 'since ' + p.period.since : 'all time'}) observed ${p.observed_at}`,
    `period: ${period}`,
    `responsibilities ${s.responsibilities} | worker turns ${s.worker_turns} | runtime completed ${s.runtime_completed} | failed ${s.failed} | cancelled ${s.cancelled}`,
    `submitted ${s.submissions} | revisions ${s.revisions} | accepted ${s.accepted} | taken over ${s.taken_over}`,
    `external tokens ${s.external_tokens === null ? 'unknown' : s.external_tokens} across ${s.usage_sessions}/${s.usage_total_sessions} sessions with a complete snapshot`,
  ];
  if (s.review) {
    const actionable = s.review.awaiting_review + s.review.changes_requested + s.review.needs_attention;
    lines.push(`review actionable ${actionable} | ${Object.entries(s.review).map(([state, count]) => `${state} ${count}`).join('  ')}`);
  }
  if (p.routes.length) {
    lines.push('routes:');
    for (const r of p.routes) lines.push(`  ${r.name}  responsibilities ${r.responsibilities}  turns ${r.worker_turns}  tokens ${r.external_tokens === null ? 'unknown' : r.external_tokens}  sessions ${r.usage_sessions}  median ${r.median_elapsed_ms === null ? 'unknown' : r.median_elapsed_ms + 'ms'}`);
  }
  if (p.activity.length) lines.push(`activity: ${p.activity.map(a => `${a.date}=${a.turns}`).join('  ')}`);
  for (const sess of p.sessions) {
    lines.push(`  ${sess.id}  ${sess.category}  ${sess.route ?? 'unknown route'}  turns ${sess.turns}  acceptance ${sess.acceptance}  evidence ${sess.evidence_count}  ${sess.closed ? 'closed' : 'open'}${sess.title ? '  ' + sess.title : ''}`);
  }
  if (p.warnings.length) lines.push(`warnings: ${p.warnings.map(w => `${w.code}(${w.count})`).join(', ')}`);
  return lines.join('\n') + '\n';
}

// `dashboard` is wired by a dynamic import so the rest of the CLI never depends
// on the optional server module and never loads an ACP adapter for a read-only
// view.
export async function startDashboardCommand(config, opt, { text, output, deps = {} }) {
  const port = opt.port === undefined ? undefined : Number(opt.port);
  if (opt.port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535))
    throw new Fault('USAGE', '--port must be an integer between 0 and 65535.');
  const since = opt.since ?? 'all';
  normalizeSince(since);
  const load = deps.loadDashboard ?? (() => import('./dashboard.mjs'));
  let dashboard;
  try { dashboard = await load(); }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND')
      throw new Fault('DASHBOARD_UNAVAILABLE', 'The dashboard module ./dashboard.mjs is not installed in this checkout.');
    throw e;
  }
  if (typeof dashboard.startDashboard !== 'function')
    throw new Fault('DASHBOARD_UNAVAILABLE', 'The dashboard module does not export startDashboard.');
  const handle = await dashboard.startDashboard({ stateDir: config.stateDir, since, port });
  text(`Dispatch dashboard: ${handle.url}\n`);
  output({ schema: 'cwr.dispatch.dashboard/1', url: handle.url, since, port: handle.port ?? port ?? null });
  return new Promise(resolve => {
    let done = false;
    const cleanupHandlers = () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
    const finish = () => { if (done) return; done = true; cleanupHandlers(); resolve(0); };
    // The server owns its lifecycle: it closes on idle (no page heartbeat) and on
    // an authenticated UI close request. Resolving on that same 'close' event is
    // what stops this CLI from becoming a zombie; we do NOT call close() again.
    if (handle.server && typeof handle.server.once === 'function') handle.server.once('close', finish);
    const onSignal = () => { Promise.resolve().then(() => handle.close?.()).catch(() => {}).finally(finish); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    // A handle that exposes no server event cannot be awaited; resolve at once so
    // the CLI never hangs with nothing to observe.
    if (!handle.server || typeof handle.server.once !== 'function') finish();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => {
    const code = typeof e.code==='string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'INTEGRATION_ERROR';
    process.stderr.write(JSON.stringify({schema:'cwr.acp.error/1',code,message:e instanceof Fault?e.message:'Local operation failed. Inspect the private runtime state; no route fallback occurred.'})+'\n');
    process.exitCode=2;
  });
}
