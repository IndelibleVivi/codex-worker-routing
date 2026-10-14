// SPDX-License-Identifier: SUL-1.0
// Finite batch runner for explicitly authorized, independent run/continue jobs.
//
// Each job runs as its own canonical CLI subprocess (`node src/cli.mjs ...`),
// never a second runtime instance inside this process. Admission is LOCAL to
// this batch only: exact-cwd locks (canonicalized), a shared worker-home policy,
// and declared shared resources serialize conflicting jobs. It is NOT a global
// guarantee across other CWR entry points. No job launches for an unknown route,
// a permission that is not explicit, or a resource conflict.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Fault, atomicJSON, privateDir, readJSON, loadBinding, paths, requestCancel, digest } from './state.mjs';
import { loadConfig, readAmbient } from './config.mjs';
import { deliveryFile, readDelivery, collectArtifactReference } from './delivery.mjs';

const MANIFEST_SCHEMA = 'cwr.acp.batch-manifest/1';
const BATCH_SCHEMA = 'cwr.acp.batch/1';
const INDEX_SCHEMA = 'cwr.acp.batch-index/1';
const HANDLE_SCHEMA = 'cwr.acp.start-handle/1';
const JOB_KEYS = ['id', 'verb', 'route', 'cwd', 'file', 'permissions', 'title', 'category', 'session', 'resources', 'deliver', 'sharedHomeValidation'];
const MAX_JOBS = 32;
const MAX_CONCURRENCY = 8;
const MAX_CHILD_OUTPUT = 256 * 1024;
const SETTLE_MS = 5000;
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESOURCE_RE = /^[A-Za-z0-9._:-]{1,120}$/;
// OS variables a launched CLI needs to start on each platform (no credentials).
const OS_ENV_POSIX = ['PATH', 'LANG'];
const OS_ENV_WIN = ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'windir'];

const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const noUnknown = (obj, allowed) => Object.keys(obj).every(k => allowed.includes(k));
const exact = (obj, where) => { if (!isPlain(obj)) throw new Fault('BAD_MANIFEST', `${where} must be an object.`); };

// Validate and normalize a manifest into a finite, immutable job list.
export function parseManifest(raw) {
  exact(raw, 'manifest');
  if (!noUnknown(raw, ['schema', 'maxConcurrency', 'capabilities', 'jobs'])) throw new Fault('BAD_MANIFEST', 'Unknown field in manifest.');
  if (raw.schema !== MANIFEST_SCHEMA) throw new Fault('BAD_MANIFEST', `schema must be "${MANIFEST_SCHEMA}".`);
  const caps = raw.capabilities ?? {};
  if (!isPlain(caps) || !noUnknown(caps, ['sharedWorkerHome'])) throw new Fault('BAD_MANIFEST', 'capabilities must only declare sharedWorkerHome.');
  if (caps.sharedWorkerHome !== undefined && !['validated', 'unvalidated'].includes(caps.sharedWorkerHome))
    throw new Fault('BAD_MANIFEST', 'capabilities.sharedWorkerHome must be validated or unvalidated.');
  const manifestValidated = caps.sharedWorkerHome === 'validated';
  const maxConcurrency = raw.maxConcurrency === undefined ? 2 : raw.maxConcurrency;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY)
    throw new Fault('BAD_MANIFEST', `maxConcurrency must be 1..${MAX_CONCURRENCY}.`);
  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0 || raw.jobs.length > MAX_JOBS)
    throw new Fault('BAD_MANIFEST', `jobs must be an array of 1..${MAX_JOBS} entries.`);
  const seen = new Set();
  const jobs = raw.jobs.map((j, i) => {
    exact(j, `jobs[${i}]`);
    if (!noUnknown(j, JOB_KEYS)) throw new Fault('BAD_MANIFEST', `Unknown field in jobs[${i}].`);
    if (typeof j.id !== 'string' || !ID_RE.test(j.id)) throw new Fault('BAD_MANIFEST', `jobs[${i}].id must be a short opaque id.`);
    if (seen.has(j.id)) throw new Fault('BAD_MANIFEST', `Duplicate job id ${j.id}.`);
    seen.add(j.id);
    if (!['run', 'continue'].includes(j.verb)) throw new Fault('BAD_MANIFEST', `jobs[${i}].verb must be run or continue.`);
    if (!['read', 'full'].includes(j.permissions)) throw new Fault('BAD_MANIFEST', `jobs[${i}].permissions must be read or full (explicit per job).`);
    if (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd)) throw new Fault('BAD_MANIFEST', `jobs[${i}].cwd must be absolute.`);
    if (typeof j.file !== 'string' || !path.isAbsolute(j.file)) throw new Fault('BAD_MANIFEST', `jobs[${i}].file must be absolute.`);
    if (j.deliver !== undefined && typeof j.deliver !== 'boolean') throw new Fault('BAD_MANIFEST', `jobs[${i}].deliver must be boolean.`);
    if (j.verb === 'continue') {
      if (typeof j.session !== 'string' || !UUID_RE.test(j.session)) throw new Fault('BAD_MANIFEST', `jobs[${i}].session must be a session UUID for continue.`);
      if (j.route !== undefined || j.title !== undefined || j.category !== undefined)
        throw new Fault('BAD_MANIFEST', `jobs[${i}] continue may not set route/title/category; they come from the bound session.`);
    } else if (typeof j.route !== 'string' || !j.route) {
      throw new Fault('BAD_MANIFEST', `jobs[${i}].route is required for a run job.`);
    } else if (j.session !== undefined) {
      throw new Fault('BAD_MANIFEST', `jobs[${i}] run may not set session; use verb continue.`);
    }
    if (j.resources !== undefined && (!Array.isArray(j.resources) || j.resources.length > 16 || j.resources.some(r => typeof r !== 'string' || !RESOURCE_RE.test(r))))
      throw new Fault('BAD_MANIFEST', `jobs[${i}].resources must be an array of short tokens.`);
    if (j.sharedHomeValidation !== undefined && j.sharedHomeValidation !== 'validated')
      throw new Fault('BAD_MANIFEST', `jobs[${i}].sharedHomeValidation may only be "validated".`);
    return {
      id: j.id, verb: j.verb, route: j.route ?? null, cwd: j.cwd, file: j.file,
      permissions: j.permissions, title: j.title ?? null, category: j.category ?? null,
      session: j.session ?? null, resources: [...(j.resources ?? [])],
      // Batch defaults to structured collection; a job may opt out with deliver:false.
      deliver: j.deliver ?? true,
      // A job is validated only if BOTH its manifest-level capability and its own
      // per-job declaration are validated. A shared home therefore stays
      // serialized unless EVERY overlapping job independently declares it.
      sharedHomeValidated: manifestValidated && j.sharedHomeValidation === 'validated',
    };
  });
  return { maxConcurrency, manifestValidated, jobs };
}

// Resolve the CANONICAL selected paths so a symlink alias cannot dodge the
// exact-cwd lock. Returns the canonical cwd and worker home.
async function jobTargets(config, job) {
  let routeName = job.route, cwd = job.cwd;
  if (job.verb === 'continue') {
    const binding = await loadBinding(config.stateDir, job.session);
    routeName = binding.route;
    cwd = binding.cwd;
  }
  const route = config.routes[routeName];
  if (!route || route.enabled !== true) throw new Fault('ROUTE_DISABLED', `Batch job ${job.id} references an unknown or disabled route.`);
  let realCwd;
  try { realCwd = await fs.realpath(cwd); }
  catch (e) { throw new Fault('BAD_WORKSPACE', `Batch job ${job.id} cwd is unavailable: ${e.code ?? 'STAT_ERROR'}.`); }
  const realHome = await fs.realpath(route.workerHome).catch(() => route.workerHome);
  return { routeName, route, cwd: realCwd, workerHome: realHome };
}

// Conflict keys for THIS batch. `cwd`/`home` are canonical. A shared home is
// serialized unless EVERY overlapping job is validated. Additional resource
// keys are declared in the coordinator-authored job manifest.
function conflictKeys(job, targets) {
  const keys = new Set([`cwd:${targets.cwd}`]);
  if (!targets.validated) keys.add(`home:${targets.workerHome}`);
  for (const r of job.resources) keys.add(`res:${r}`);
  return keys;
}

function buildChildEnv(route, cliHome) {
  const env = {};
  const names = process.platform === 'win32' ? OS_ENV_WIN : OS_ENV_POSIX;
  for (const name of names) {
    const value = readAmbient(process.env, name);
    if (value !== undefined) env[name] = value;
  }
  // Forward ONLY the route's registered passEnv (its authorized credentials),
  // never the coordinator's ambient environment.
  for (const key of route.passEnv) {
    const value = readAmbient(process.env, key);
    if (value !== undefined) env[key] = value;
  }
  // Relocate the CLI's OWN home to a dedicated batch scratch home: it must not
  // be the coordinator's HOME, and it must NOT be the route worker home (the CLI
  // rejects a worker home equal to its main home as PRIVATE_HOME_REUSE). The
  // adapter itself still receives the route worker home via the CLI's own
  // buildEnvironment. Registered passEnv values are forwarded but never logged.
  if (cliHome) { env.HOME = cliHome; env.USERPROFILE = cliHome; }
  return env;
}

function spawnJob({ cliPath, configFile, stateDir, expectedAdmission, job, handleFile, env }) {
  const base = [cliPath, job.verb, '--config', configFile];
  if (job.verb === 'continue') base.push('--session', job.session);
  else {
    base.push('--route', job.route, '--cwd', job.cwd);
    if (job.title !== null) base.push('--title', job.title);
    if (job.category !== null) base.push('--category', job.category);
  }
  base.push('--file', job.file, '--permissions', job.permissions, '--start-handle', handleFile, '--expected-admission', expectedAdmission);
  if (job.deliver) base.push('--deliver');
  const child = spawn(process.execPath, base, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true, detached: process.platform !== 'win32' });
  // stdout carries the machine receipt; stderr is diagnostic. Each stream keeps
  // its OWN bounded retention budget: flooded diagnostics may truncate stderr,
  // but can never starve a valid receipt out of stdout's budget. A truncated
  // stdout is refused downstream, never parsed as a receipt.
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false;
  const feed = (buf, which) => {
    const isOut = which === 'out';
    const remaining = MAX_CHILD_OUTPUT - (isOut ? stdoutBytes : stderrBytes);
    if (isOut) stdoutBytes += buf.length; else stderrBytes += buf.length;
    if (remaining <= 0) { if (isOut) stdoutTruncated = true; else stderrTruncated = true; return; }
    const text = buf.toString('utf8', 0, Math.min(buf.length, remaining));
    if (isOut) stdout += text; else stderr += text;
    if (buf.length > remaining) { if (isOut) stdoutTruncated = true; else stderrTruncated = true; }
  };
  child.stdout.on('data', d => feed(d, 'out'));
  child.stderr.on('data', d => feed(d, 'err'));
  const done = new Promise(resolve => {
    let spawnError = null;
    child.on('error', e => { spawnError = e.code ?? 'SPAWN_ERROR'; });
    child.on('close', (code, signal) => resolve({ code: code ?? spawnError ?? signal, signal, stdout, stderr, stdoutTruncated, stderrTruncated }));
  });
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // The canonical nonce mailbox works on every platform, including Windows
    // where process signals can terminate a CLI without running its JS handler.
    void (async () => {
      const h = await captureHandle(handleFile);
      if (!h) throw new Fault('HANDLE_MISSING', 'Owned start handle is unavailable.');
      const owner = await readJSON(path.join(paths(stateDir, h.session_id).lock, 'owner.json'), { privateFile: true, maxBytes: 4096 });
      if (owner.pid !== child.pid || owner.session !== h.session_id) throw new Fault('LOCK_CHANGED', 'The operation is no longer owned by this child.');
      await requestCancel({ stateDir }, { id: h.session_id });
    })().catch(() => {
      if (process.platform !== 'win32') try { child.kill('SIGTERM'); } catch { /* gone */ }
    });
  };
  const abandon = () => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); };
  return { child, done, stop, abandon };
}

function parseReceipt(stdout) {
  try { const r = JSON.parse(stdout.trim()); return r?.schema === 'cwr.acp.receipt/1' ? r : null; }
  catch { return null; }
}

// A bounded excerpt of the worker-declared delivery block, so a batch overview
// can be read without opening every sidecar. It is a verbatim, clipped
// projection: the program adds no semantic judgment, and the source marker
// keeps worker declarations distinct from runner-observed facts.
const clipText = (s, n) => (typeof s === 'string' && s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s ?? '', truncated: false });
export function deliveryExcerpt(block) {
  if (!block) return null;
  const summary = clipText(block.summary, 400);
  const unsatisfied = (block.criteria ?? []).filter(c => c.state === 'unsatisfied');
  const byState = {};
  for (const c of block.checks ?? []) byState[c.state] = (byState[c.state] ?? 0) + 1;
  return {
    source: 'worker_reported',
    summary: summary.text, summary_truncated: summary.truncated,
    criteria: {
      total: (block.criteria ?? []).length, unsatisfied: unsatisfied.length,
      unsatisfied_list: unsatisfied.slice(0, 8).map(c => clipText(c.criterion, 160).text),
    },
    checks: {
      total: (block.checks ?? []).length, by_state: byState,
      failing: (block.checks ?? []).filter(c => c.state === 'failed' || c.state === 'blocked').slice(0, 8).map(c => clipText(c.name, 100).text),
    },
    questions: (block.questions ?? []).slice(0, 4).map(q => clipText(q, 300).text),
    questions_total: (block.questions ?? []).length,
  };
}

// Candidate next actions combine trusted runtime/handle facts with attributed
// worker-reported delivery status. They are a fixed vocabulary of hints for
// the coordinator — never commands, never worker text, never auto-executed.
// A continue-class hint additionally requires a known session whose runtime is
// terminal with confirmed cleanup and a matching handle.
function nextActions({ receipt, startHandle, handleMatches, delivery, deliveryProblem, job }) {
  const actions = [];
  const session = receipt?.session_id ?? startHandle?.session_id ?? job.session ?? null;
  const runtime = receipt?.runtime_status ?? null;
  const cleanup = receipt?.cleanup ?? null;
  if (!receipt) {
    actions.push({ action: 'reconcile_session', session_id: session, reason: startHandle && !handleMatches ? 'start handle identity does not match this job' : 'no runtime receipt was collected' });
    return actions;
  }
  if (runtime === 'failed' || runtime === 'cancelled')
    actions.push({ action: 'inspect_receipt', session_id: session, receipt_path: receipt?.receipt_path ?? null, reason: `runtime ${runtime}` });
  const continuable = Boolean(session) && runtime === 'completed' && cleanup === 'confirmed' && handleMatches;
  // A report-format or absent-report problem calls for same-session report
  // consolidation, never a replay of the completed work. Local collection
  // faults (corrupt/unreadable sidecar) get no automatic hint: reconcile the
  // state directory first.
  const consolidatable = ['DELIVERY_MISSING', 'DELIVERY_MISSING_BLOCK', 'DELIVERY_MALFORMED', 'DELIVERY_OVERSIZED', 'DELIVERY_WRONG_IDENTITY'];
  if (continuable && deliveryProblem && consolidatable.includes(deliveryProblem))
    actions.push({ action: 'consolidate_report', session_id: session, reason: `turn completed but ${deliveryProblem.toLowerCase().replaceAll('_', ' ')}` });
  if (continuable && delivery?.worker?.status === 'needs_input' && (delivery.worker.block?.questions ?? []).length)
    actions.push({ action: 'answer_questions', session_id: session, reason: 'worker returned precise questions or a blocker' });
  return actions;
}

// Durably record the observed start handle as soon as it appears (not only at
// batch end), so an interruption retains real handles for recovery.
async function captureHandle(handleFile) {
  try {
    const h = JSON.parse(await fs.readFile(handleFile, 'utf8'));
    if (h?.schema !== HANDLE_SCHEMA || !UUID_RE.test(h.session_id ?? '') || !UUID_RE.test(h.request_id ?? '') || typeof h.cwd !== 'string' || typeof h.route !== 'string') return null;
    return h;
  } catch { return null; }
}

/**
 * Run a finite batch. `deps` may override `spawnJob`/`loadConfig`/`loadBinding`
 * for tests. Returns an exit code; prints the batch JSON via `output`.
 */
export async function runBatch({ config, opt, deps = {}, output, text, cliPath }) {
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const full = await loadConfigImpl(config.configPath);
  const rawManifest = await readJSON(path.resolve(opt.manifest), { privateFile: false, maxBytes: 256 * 1024 });
  const manifest = parseManifest(rawManifest);
  const concurrency = opt.concurrency === undefined ? manifest.maxConcurrency : Number(opt.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY)
    throw new Fault('USAGE', `--concurrency must be an integer 1..${MAX_CONCURRENCY}.`);

  const batchId = randomUUID();
  const indexDir = path.join(full.stateDir, 'batches', batchId);
  await privateDir(indexDir);
  // A dedicated CLI scratch home, disjoint from the state dir and every worker
  // home, so the launched CLI never sees the coordinator HOME and never collides
  // with a route worker home.
  const cliHome = path.join(indexDir, 'cli-home');
  await privateDir(cliHome);

  // Canonicalize targets up front so admission cannot be dodged by an alias, and
  // a continue manifest cwd that disagrees with the binding fails closed.
  const prepared = [];
  for (const job of manifest.jobs) {
    const targets = await jobTargets(full, job);
    if (job.verb === 'continue' && await fs.realpath(job.cwd) !== targets.cwd)
      throw new Fault('BAD_MANIFEST', `Batch job ${job.id} cwd does not match the bound session workspace.`);
    // Every overlapping same-home job must independently accept the shared home.
    targets.validated = job.sharedHomeValidated;
    prepared.push({ job, targets, keys: conflictKeys(job, targets, full) });
  }
  // a shared home may only run concurrently when EVERY job on it is validated.
  const homeValidated = new Map();
  for (const p of prepared) {
    const prev = homeValidated.get(p.targets.workerHome) ?? true;
    homeValidated.set(p.targets.workerHome, prev && p.targets.validated);
  }
  for (const p of prepared) {
    if (homeValidated.get(p.targets.workerHome)) p.keys.delete(`home:${p.targets.workerHome}`);
    else p.keys.add(`home:${p.targets.workerHome}`);
  }

  const running = new Map();
  const results = new Map();
  const handles = new Map();
  const heldKeys = new Set();
  const order = [...prepared];
  const spawn = deps.spawnJob ?? spawnJob;
  let cancelled = false;
  // A mid-batch admission failure (config reload throws, spawn refuses) closes
  // admission for the rest of THIS batch: nothing new launches, outstanding work
  // settles, and the batch still reports every result it already owns.
  let admissionError = null;
  let indexWarning = null, indexQueue = Promise.resolve(), indexStatus = 'running';
  const writeIndex = status => {
    if (status !== 'running') indexStatus = status;
    const next = indexQueue.then(() => atomicJSON(path.join(indexDir, 'index.json'), {
      schema: INDEX_SCHEMA, batch_id: batchId, status: indexStatus, total: prepared.length,
      jobs: [...handles.entries()].map(([id, start_handle]) => ({ id, start_handle })),
      results: [...results.values()],
    }));
    indexQueue = next.catch(e => { indexWarning = e.code ?? 'INDEX_WRITE_FAILED'; cancelled = true; });
    return next;
  };
  await writeIndex('running');
  let interrupt;
  const interrupted = new Promise(resolve => { interrupt = resolve; });
  const stopped = Symbol('batch interrupted');
  const onSignal = () => { cancelled = true; interrupt(stopped); for (const r of running.values()) r.record.handle.stop(); };
  const collectResult = async (out, record) => {
      const startHandle = handles.get(record.id) ?? await captureHandle(record.handleFile);
      if (startHandle && !handles.has(record.id)) { handles.set(record.id, startHandle); await writeIndex('running').catch(() => {}); }
      // A truncated stdout is NEVER a receipt, even if the retained prefix
      // happens to parse as a complete JSON document.
      const receipt = out.stdoutTruncated ? null : parseReceipt(out.stdout);
      // Validate the handle against the receipt identity (or the manifest for a
      // continue); a mismatch is a partial, never a trusted handle.
      const expectedCwd = record.entry.targets.cwd;
      const expectedRoute = record.entry.targets.routeName;
      let handleMatches = Boolean(startHandle);
      if (startHandle) {
        if (receipt) handleMatches = startHandle.request_id === receipt.request_id && startHandle.session_id === receipt.session_id;
        if (startHandle.cwd !== expectedCwd) handleMatches = false;
        if (startHandle.route !== expectedRoute) handleMatches = false;
      }
      // Optional structured delivery: read the sidecar written by --deliver.
      let delivery = null, deliveryProblem = null;
      if (record.entry.job.deliver && receipt?.session_id && receipt?.request_id) {
        try {
          delivery = await readDelivery(full.stateDir, receipt.session_id, receipt.request_id);
          if (!delivery) deliveryProblem = 'DELIVERY_MISSING';
          else if (delivery.worker?.status === 'malformed' || delivery.worker?.status === 'wrong_identity' || delivery.worker?.status === 'oversized') deliveryProblem = `DELIVERY_${delivery.worker.status.toUpperCase()}`;
          else if (delivery.worker?.status === 'missing') deliveryProblem = 'DELIVERY_MISSING_BLOCK';
        } catch (e) { deliveryProblem = e.code === 'CORRUPT_DELIVERY' ? 'DELIVERY_CORRUPT' : 'DELIVERY_UNREADABLE'; }
      }
      results.set(record.id, {
        id: record.id,
        session_id: receipt?.session_id ?? startHandle?.session_id ?? record.entry.job.session ?? null,
        request_id: receipt?.request_id ?? startHandle?.request_id ?? null,
        route: expectedRoute,
        start_handle: handleMatches ? startHandle : null,
        handle_mismatch: Boolean(startHandle) && !handleMatches,
        runtime_status: receipt?.runtime_status ?? null,
        cleanup: receipt?.cleanup ?? null,
        receipt_path: receipt?.receipt_path ?? null,
        exit_code: out.code ?? null,
        output_received: Boolean(receipt),
        output_truncated: Boolean(out.stdoutTruncated),
        stderr_truncated: Boolean(out.stderrTruncated),
        error_code: receipt?.error_code ?? null,
        // Collection coverage is separate from engineering acceptance.
        delivery_path: delivery ? deliveryFile(full.stateDir, receipt.session_id, receipt.request_id) : null,
        artifact_references: await Promise.all((delivery?.worker?.block?.artifacts ?? []).map(async a => ({ ...a, observed: !['file', 'dir'].includes(a.kind) ? { status: 'unsupported', reason: 'NON_FILE_REFERENCE' } : !a.ref.trim() ? { status: 'unknown', reason: 'EMPTY' } : await collectArtifactReference(/^[a-z][a-z0-9+.-]*:\/\//i.test(a.ref) ? a.ref : path.resolve(expectedCwd, a.ref), { roots: [expectedCwd] }) }))),
        delivery_status: delivery?.worker?.status ?? null,
        delivery_questions: delivery?.worker?.block?.questions ?? null,
        delivery_problem: deliveryProblem,
        // Bounded worker-declared overview + trusted candidate next actions.
        delivery_excerpt: deliveryExcerpt(delivery?.worker?.block ?? null),
        next_actions: nextActions({ receipt, startHandle, handleMatches, delivery, deliveryProblem, job: record.entry.job }),
      });
      // Publish every settled result into the durable index immediately, so a
      // mid-batch `collect` sees it without waiting for the batch to settle.
      // Index failures already close admission via the shared indexWarning path.
      await writeIndex('running').catch(() => {});
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    while (order.length || running.size) {
      // `cancelled` is read LIVE here and re-checked after every admission await:
      // it is the irreversible admission-closed state for this batch, whether set
      // by a parent signal or by an index publication failure. A `drainOnly`
      // snapshot taken at the top of the iteration would let an admission that
      // yielded the event loop launch a child AFTER cancellation took effect.
      for (let i = 0; !cancelled && !admissionError && i < order.length;) {
        if (running.size >= concurrency) break;
        const entry = order[i];
        let conflict = false;
        for (const k of entry.keys) if (heldKeys.has(k)) { conflict = true; break; }
        if (conflict) { i++; continue; }
        order.splice(i, 1);
        const handleFile = path.join(indexDir, `${entry.job.id}.handle.json`);
        let fresh;
        try {
          fresh = await loadConfigImpl(config.configPath);
        } catch (e) {
          // The batch has already started: a failing config reload is a runtime
          // error for this admission, not a pre-launch validation failure. Record
          // it, close admission, and settle what is already running below.
          admissionError = { job: entry.job.id, code: e.code ?? 'CONFIG_RELOAD_FAILED' };
          results.set(entry.job.id, { id: entry.job.id, output_received: false, error_code: admissionError.code, cleanup: null });
          break;
        }
        // Cancellation or an index publication failure may have landed during the
        // await above. Re-check BEFORE spawn: a cancelled batch launches nothing.
        // The unlaunched job keeps no fabricated result, so it lands in `missing`.
        if (cancelled) break;
        if (fresh.stateDir !== full.stateDir || JSON.stringify(fresh.routes[entry.targets.routeName]) !== JSON.stringify(entry.targets.route)) {
          results.set(entry.job.id, { id: entry.job.id, output_received: false, error_code: 'CONFIG_CHANGED', cleanup: null });
          continue;
        }
        const expectedAdmission = digest({ stateDir: full.stateDir, routeName: entry.targets.routeName, route: entry.targets.route, cwd: entry.targets.cwd, permissions: entry.job.permissions });
        const env = buildChildEnv(entry.targets.route, cliHome);
        let handle;
        try {
          handle = spawn({ cliPath, configFile: config.configPath, stateDir: full.stateDir, expectedAdmission, job: entry.job, handleFile, env });
        } catch (e) {
          admissionError = { job: entry.job.id, code: e.code ?? 'SPAWN_FAILED' };
          results.set(entry.job.id, { id: entry.job.id, output_received: false, error_code: admissionError.code, cleanup: null });
          break;
        }
        const record = { id: entry.job.id, entry, handleFile, keys: entry.keys, handle };
        for (const k of entry.keys) heldKeys.add(k);
        running.set(entry.job.id, { record });
        // Poll for the machine-readable handle while the job runs and record it
        // durably as soon as it exists.
        const poll = record.poll = setInterval(async () => {
          if (handles.has(entry.job.id)) { clearInterval(poll); return; }
          const h = await captureHandle(handleFile);
          if (h) { handles.set(entry.job.id, h); await writeIndex('running').catch(() => {}); }
        }, 50);
        handle.done.then(() => clearInterval(poll));
        record.promise = handle.done.then(out => { record.settled = out; return { out, record }; });
      }
      if (!running.size) break;
      const finisher = await Promise.race([...running.values()].map(r => r.record.promise).concat(interrupted));
      if (finisher === stopped) break;
      const { out, record } = finisher;
      for (const k of record.keys) heldKeys.delete(k);
      running.delete(record.id);
      await collectResult(out, record);
    }
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    // Stop any still-running children and wait (bounded) for them to settle.
    // A drain iteration already removed finished jobs; these are genuinely
    // outstanding (e.g. the parent was interrupted). Never claim cancel-by-handle
    // unless the child actually exits within the bounded wait.
    const outstanding = [...running.values()];
    const settle = outstanding.map(r => r.record.handle.done.catch(() => {}));
    for (const r of outstanding) { clearInterval(r.record.poll); r.record.handle.stop(); }
    let settleTimer;
    await Promise.race([Promise.all(settle), new Promise(res => { settleTimer = setTimeout(res, SETTLE_MS); })]);
    clearTimeout(settleTimer);
    for (const r of outstanding) {
      if (r.record.settled) await collectResult(r.record.settled, r.record);
      else {
        r.record.handle.abandon?.();
        // One FINAL handle read at the end of the bounded wait: a child that was
        // launched before cancellation may publish its start handle only after
        // the last poll (e.g. it acquired its locks during settlement). Persist
        // what is observed so recovery can find it; trust it in the result only
        // when it matches this job's identity. cleanup stays unconfirmed either
        // way — holding a handle never upgrades to a confirmed stop.
        if (!handles.has(r.record.id)) {
          const late = await captureHandle(r.record.handleFile);
          if (late) handles.set(r.record.id, late);
        }
      }
      if (!results.has(r.record.id)) {
        const observed = handles.get(r.record.id) ?? null;
        const trusted = Boolean(observed) && observed.cwd === r.record.entry.targets.cwd && observed.route === r.record.entry.targets.routeName;
        results.set(r.record.id, {
          id: r.record.id,
          session_id: (trusted ? observed.session_id : null) ?? r.record.entry.job.session ?? null,
          request_id: trusted ? observed.request_id : null,
          route: r.record.entry.targets.routeName, start_handle: trusted ? observed : null,
          handle_mismatch: Boolean(observed) && !trusted, runtime_status: null, cleanup: 'unconfirmed', receipt_path: null,
          exit_code: null, output_received: false, output_truncated: false, stderr_truncated: false, error_code: null,
          // Locatable recovery clue when no handle could be captured at all.
          handle_file: r.record.handleFile,
          delivery_status: null, delivery_questions: null, delivery_problem: null,
          delivery_excerpt: null,
          next_actions: [{ action: 'reconcile_session', session_id: (trusted ? observed.session_id : null) ?? r.record.entry.job.session ?? null,
            reason: trusted ? 'the turn did not settle within the batch wait; reconcile the recorded session before any overlapping work' : 'no start handle was captured; the retained handle_file is the recovery clue' }],
        });
      }
    }
  }

  const jobs = [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  // A missing REQUIRED result: no receipt, a handle mismatch, or a required
  // delivery problem. A failed/cancelled turn still produced an honest record.
  const missing = [];
  for (const p of prepared) {
    const id = p.job.id;
    const r = results.get(id);
    if (!r || !r.output_received || !r.start_handle || r.handle_mismatch || (p.job.deliver && r.delivery_problem)) missing.push(id);
  }
  const status = cancelled || missing.length || indexWarning || admissionError ? 'partial' : 'complete';
  const batch = {
    schema: BATCH_SCHEMA, batch_id: batchId, status, cancelled, concurrency,
    shared_home_validated: manifest.manifestValidated,
    job_count: prepared.length, missing, jobs,
    admission_scope: 'batch_local_only',
    index_path: path.join(indexDir, 'index.json'), index_warning: indexWarning,
    admission_error: admissionError,
  };
  await writeIndex(status).catch(() => {});
  if (indexWarning) { batch.status = 'partial'; batch.index_warning = indexWarning; }
  output(batch);
  return batch.status === 'complete' ? 0 : 1;
}

export { MANIFEST_SCHEMA, BATCH_SCHEMA, INDEX_SCHEMA, HANDLE_SCHEMA };

/**
 * Read-only view of one batch's durable index: the results settled SO FAR,
 * each already carrying its bounded delivery excerpt and candidate next
 * actions. It never loads an adapter, never waits, and never infers progress
 * beyond the recorded handles/results; there is no per-item wakeup — the
 * coordinator reads this between its host's own waits. A corrupted or foreign
 * index is an explicit error, never a fake pass.
 */
export async function collectBatch({ config, batchId }) {
  if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) throw new Fault('BAD_BATCH_ID', 'Expected a batch UUID returned by batch.');
  const file = path.join(config.stateDir, 'batches', batchId, 'index.json');
  let raw;
  try { raw = await readJSON(file, { privateFile: true, maxBytes: 16 * 1024 * 1024 }); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') throw new Fault('BATCH_NOT_FOUND', 'No batch index with that id exists in the state root.');
    throw e;
  }
  if (!isPlain(raw) || raw.schema !== INDEX_SCHEMA || raw.batch_id !== batchId
    || !['running', 'complete', 'partial'].includes(raw.status)
    || !Array.isArray(raw.jobs) || !Array.isArray(raw.results)
    || raw.jobs.some(j => !isPlain(j) || typeof j.id !== 'string')
    || raw.results.some(r => !isPlain(r) || typeof r.id !== 'string'))
    throw new Fault('CORRUPT_INDEX', 'The stored batch index is invalid.');
  const total = Number.isSafeInteger(raw.total) ? raw.total : null;
  return {
    schema: 'cwr.acp.batch-collect/1', batch_id: batchId, status: raw.status, total,
    handles: raw.jobs.length, settled: raw.results.length,
    outstanding: total === null ? null : Math.max(0, total - raw.results.length),
    results: raw.results,
  };
}
