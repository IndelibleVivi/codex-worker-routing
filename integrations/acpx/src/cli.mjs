#!/usr/bin/env node
// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Fault, atomicJSON, privateDir, paths, lock, loadBinding, readJSON, digest, sessionId, requestCancel } from './state.mjs';
import { loadConfig, loadControlConfig, selectRoute, resolveRouteSelection, buildEnvironment, prepareHome, readOrder, replaceOwnEnvironment, assertSupportedPlatform, executionIdentity, assertBindingIdentity } from './config.mjs';
import { executeTurn, closeBinding } from './engine.mjs';
import { EVENT_SCHEMA, REASON_VALUES, recordEvent, createProjectionReader, normalizeSince, captureParentMetadata, writeRequestOrder, listPendingSessions } from './dispatch.mjs';
import { readDelivery } from './delivery.mjs';
import { runBatch, collectBatch, collectBatchCompact, collectBatchJob } from './batch.mjs';
import { runPrepare } from './prepare.mjs';
import { inventoryStorage, planStorage, applyStoragePlan, createScratch, loadScratch,
  newScratchLocation, scratchRenderEnvironment } from './storage.mjs';


// Property tables for the argument parser. `flags` take no value; `values` take
// exactly one. The legacy commands keep their exact option sets. `--json` is a
// bare flag so the parser never mistakes it for the value of a preceding option.
const FLAG = Object.freeze({
  stats: ['json'],
  storage: ['json'],
  delivery: ['json'],
  run: ['deliver'],
  continue: ['deliver'],
  collect: ['compact'],
  batch: ['compact'],
});
const VALUES = Object.freeze({
  run: ['config', 'route', 'cwd', 'file', 'permissions', 'title', 'category', 'start-handle', 'expected-admission'],
  continue: ['config', 'session', 'file', 'permissions', 'revision-reason', 'start-handle', 'expected-admission'],
  status: ['config', 'session'],
  cancel: ['config', 'session'],
  close: ['config', 'session'],
  stats: ['config', 'since', 'time-zone'],
  record: ['config', 'session', 'file'],
  pending: ['config'],
  dashboard: ['config', 'since', 'port'],
  storage: ['config', 'max-entries', 'max-depth', 'extra-home', 'older-than'],
  'storage-plan': ['config', 'target', 'older-than', 'max-entries', 'max-depth'],
  'storage-apply': ['config', 'plan', 'confirm'],
  batch: ['config', 'manifest', 'concurrency', 'start-handle', 'limit', 'max-bytes'],
  delivery: ['config', 'session', 'request'],
  prepare: ['config', 'spec', 'out'],
  collect: ['config', 'batch', 'job', 'cursor', 'limit', 'max-bytes'],
});
const REQUIRED = Object.freeze({
  // `route` is resolved separately: it is required only for configs without a
  // routing.default (or for continue, which always uses the bound route).
  run: ['config', 'cwd', 'file'],
  continue: ['config', 'session', 'file'],
  status: ['config', 'session'],
  cancel: ['config', 'session'],
  close: ['config', 'session'],
  stats: ['config'],
  record: ['config', 'session', 'file'],
  pending: ['config'],
  dashboard: ['config'],
  storage: ['config'],
  'storage-plan': ['config'],
  'storage-apply': ['config', 'plan', 'confirm'],
  batch: ['config', 'manifest'],
  delivery: ['config', 'session'],
  prepare: ['config', 'spec'],
  collect: ['config', 'batch'],
});
export const COMMANDS = Object.freeze(Object.keys(VALUES));
export function parseStorageAge(value) {
  if (value === 'all') return 0;
  const match = typeof value === 'string' ? /^(\d+)(m|h|d|w)$/.exec(value) : null;
  if (!match) throw new Fault('USAGE', '--older-than must be all or a positive duration such as 24h, 7d or 2w.');
  const amount = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  const ms = amount * unit;
  if (!Number.isSafeInteger(ms) || amount < 1) throw new Fault('USAGE', 'Invalid --older-than duration.');
  return ms;
}
// Absolute path to THIS CLI entry, used by `batch` to spawn canonical,
// independent subprocesses with the exact same module (never a copy).
const cli_path = () => fileURLToPath(import.meta.url);

const HELP = `cwr-acp (optional channel; does not replace native subagents)
  run      --config FILE [--route NAME] --cwd DIR --file ORDER --permissions read|full
           [--title TEXT] [--category investigation|implementation|review|other]
  continue --config FILE --session UUID --file INCREMENT --permissions read|full
           [--revision-reason REASON]
  status   --config FILE --session UUID
  cancel   --config FILE --session UUID
  close    --config FILE --session UUID
  record   --config FILE --session UUID --file EVENT_JSON
  pending  --config FILE
  stats    --config FILE [--since 7d|30d|all|ISO_DATE] [--time-zone IANA_ZONE] [--json]
  dashboard --config FILE [--since 7d|30d|all|ISO_DATE] [--port NUMBER]
  storage  --config FILE [--extra-home DIR ...] [--older-than 7d|24h|all]
           [--max-entries N] [--max-depth N] [--json]
  storage-plan --config FILE --target ID [--target ID ...]
           [--older-than 7d|24h|all] [--max-entries N] [--max-depth N]
  storage-apply --config FILE --plan UUID --confirm UUID
  batch    --config FILE --manifest FILE [--concurrency N]
           [--start-handle FILE]      (publishes {batch_id,index_path} before any launch)
           [--compact [--limit N] [--max-bytes N]]   (bounded paged terminal; default is full)
  delivery --config FILE --session UUID [--request REQUEST_ID] [--json]
  prepare  --config FILE --spec SPEC_FILE [--out DIR]
  collect  --config FILE --batch BATCH_ID
           [--compact [--limit N] [--max-bytes N] [--cursor TOKEN]]
           [--job JOB_ID]

run/continue block until a terminal result and connection cleanup. Ctrl+C/SIGTERM
request cancellation. cancel writes a nonce-bound local request; it does not
claim the worker has stopped. No background wakeup and no post-launch retry.

run/continue accept an OPTIONAL bare --deliver flag: it collects a bounded
cwr-delivery result block into a private per-request sidecar, separate from the
runtime receipt and the truncated output excerpt. Absent the flag, ordinary
run/continue behavior is unchanged. A missing/oversized/malformed block is
recorded as such and never re-runs the work or changes runtime status. No command
inside a delivery block is ever executed.

run/continue also accept an OPTIONAL --start-handle FILE: once the operation
holds its locks the CLI atomically writes a machine-readable start handle there
for a batch runner, instead of parsing human stderr text.

batch runs a finite, coordinator-authored manifest of run/continue jobs as
independent CLI subprocesses, with explicit per-job permissions, a maximum
concurrency, and safe local admission for an exact cwd and a shared worker home.
It reports partial when required results are missing. With --start-handle FILE it
writes a machine-readable batch handle (batch_id, index_path) immediately after
the initial index exists and before any child launches; a failed handle write
aborts the batch before launching anything. Its terminal stdout keeps the FULL
legacy receipt by default (including delivery_questions/artifact_references);
--compact instead emits a bounded, paged terminal within --max-bytes that carries
the batch metadata plus a first page, and the caller continues with
'collect --compact --cursor'. delivery is read-only and never loads an adapter.

prepare mechanically turns one coordinator-authored order spec (shared
background plus each item's task) into per-item order files and a standard
batch manifest. It validates the explicit per-item permissions, the current
route/workspace authorization and any continued session binding BEFORE anything
launches, fills an omitted run route from the config's CURRENT routing.default,
and never infers a permission from a category or a keyword. It launches nothing
and loads no adapter; batch admission re-validates every generated job.

collect is a read-only view of one batch's index. Plain collect returns the full
stored results (the compatibility view). --compact returns a bounded coordination
read: whole-response UTF-8 byte budget and item limit, an opaque change/paging
cursor, a recorded-handle/awaiting-handle/missing classification, and per-item short
evidence (source, summary, criteria, check name/state/detail, questions, clipped
with visible omission counts). No change since the cursor re-sends no results;
cross-batch, malformed, out-of-range or future cursors are rejected. --job JOB_ID
expands ONE settled result in full from the index and cannot be combined with
--compact/--cursor/--limit/--max-bytes; the full delivery block stays
readable with 'delivery --session/--request'. collect never loads an adapter,
never waits, provides no per-item wakeup, and a corrupted index is an explicit
error, never a fake pass.

run and continue require an explicit --permissions read|full on EVERY turn.
The category is metadata, never permission. A continuation does not inherit a
previous full grant. These modes answer ACP permission requests, not an OS sandbox.

run resolves its route fresh on every call. Omit --route when CONFIG declares a
top-level routing.default; the default is read from the current config, not from
memory. An explicit --route uses that exact enabled route and never falls back.
Optional routing.fallbacks are tried, in declared order and at most once each,
ONLY before any adapter launch, runtime import, or worker home/state write, and
only when the selected route's entry is missing/unlaunchable or its explicitly
required passEnv credential is absent. Fallback never bypasses a permission,
workspace or enabled:false denial, an unsafe config, a BUSY lock, an invalid
order or any runtime/dependency failure, and never retries post-launch. A
fallback launch is exactly one responsibility/prompt. The receipt reports the
requested route, the actual route and bounded skipped-route codes.

stats and pending read the private state root; record appends one collaboration
event and never rewrites a runtime receipt. These commands never load, import or
scrub for an ACP adapter. dashboard dynamically imports ./dashboard.mjs.
Dashboard data is read-only; the explicit Storage view saves private plans and applies
only after confirmation. Theme, language and time zone are local display preferences.

dashboard prints a private loopback URL (ephemeral port by default; use --port to fix
one), stays in the foreground and projects existing ACP receipts. Before the first ACP
task it opens an expected empty state. Share cards are reached from the dashboard
header. Open the printed URL yourself; the command never opens a browser.

storage is an adapter-free, read-only inventory of configured worker homes and the
private state root. storage-plan saves an immutable plan for explicitly selected
managed scratch IDs. storage-apply requires the same UUID twice and revalidates the
manifest, binding, cleanup, locks, cutoff, paths and full tree snapshot before a
file is removed. It never deletes persistent HOME/CODEX_HOME history, caches, legacy
tmp, logs, databases, CWR state, receipts, orders or unowned paths. Plans and apply
receipts live under the private state root's storage directory.

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
  // A known command's `--help` returns the shared help text instead of failing on
  // an unknown option. There is no per-command help framework; `help` short-circuits
  // before option validation, so `<known-command> --help` and bare `--help` agree.
  if (rest.length === 1 && rest[0] === '--help') return { command: 'help' };
  const out = { command };
  const repeatable = command === 'storage-plan' || command === 'storage';
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]?.startsWith('--')) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    const name = rest[i]?.slice(2);
    if (flags.includes(name)) {
      if (out[name] !== undefined) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
      out[name] = true;
      continue;
    }
    const repeatName = command === 'storage' ? 'extra-home' : 'target';
    if (!values.includes(name) || (out[name] !== undefined && !(repeatable && name === repeatName)))
      throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Fault('USAGE', 'Unknown, duplicate or missing option.');
    if (repeatable && name === 'target') (out.targets ??= []).push(value);
    else if (repeatable && name === 'extra-home') (out.extraHomes ??= []).push(value);
    else out[name] = value;
    i++;
  }
  if (REQUIRED[command].some(k => !out[k])) throw new Fault('USAGE', 'Required option missing. Run --help.');
  if (command === 'storage-plan' && !out.targets?.length)
    throw new Fault('USAGE', 'Required option missing. Run --help.');
  if ((command === 'run' || command === 'continue') && out.permissions === undefined)
    throw new Fault('PERMISSIONS_REQUIRED', 'Choose --permissions read or --permissions full explicitly for this turn; category and earlier turns do not grant permission.');
  return out;
}
// Restrictive batch ticket: bind actual child selection to the resource plan.
// It contains no credential values and cannot authorize a route or permission.
function assertAdmission(config, selection, opt) {
  if (opt['expected-admission'] === undefined) return;
  const actual = digest({ stateDir: config.stateDir, routeName: selection.name,
    route: selection.route, cwd: selection.cwd, permissions: selection.permissions });
  if (opt['expected-admission'] !== actual) throw new Fault('ADMISSION_CHANGED', 'Selected configuration changed after batch admission; no adapter launch.');
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
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
function receiptTiming(receipt) {
  const b = receipt.budget, a = receipt.activity;
  const budget = b && nonnegative(b.setup_ms) && nonnegative(b.task_ms) ? {
    setup_ms: b.setup_ms, task_ms: b.task_ms,
    prompt_started_at: isoTime(b.prompt_started_at) ? b.prompt_started_at : null,
    task_deadline_at: isoTime(b.task_deadline_at) ? b.task_deadline_at : null,
    task_elapsed_ms: nonnegative(b.task_elapsed_ms) ? b.task_elapsed_ms : null,
  } : null;
  const activity = a && isoTime(a.observed_at) && nonnegative(a.event_count) ? {
    observed_at: a.observed_at, event_count: a.event_count,
    first_event_at: isoTime(a.first_event_at) ? a.first_event_at : null,
    last_event_at: isoTime(a.last_event_at) ? a.last_event_at : null,
    last_event_type: ['text_delta','status','tool_call','done','error','other'].includes(a.last_event_type) ? a.last_event_type : null,
    last_event_age_ms: nonnegative(a.last_event_age_ms) ? a.last_event_age_ms : null,
  } : null;
  return { budget, activity };
}
async function statusReceipt(p, binding) {
  const candidates = [];
  const active = binding.active_turn;
  if (typeof active?.request_id === 'string' && UUID.test(active.request_id) && isoTime(active.started_at))
    candidates.push({ file: path.join(p.receipts, `${active.request_id}.json`), request: active.request_id, source: 'active_turn', started: active.started_at });
  if (typeof binding.lastReceipt === 'string' && path.dirname(binding.lastReceipt) === p.receipts) {
    const request = path.basename(binding.lastReceipt, '.json');
    if (UUID.test(request) && binding.lastReceipt === path.join(p.receipts, `${request}.json`) && !candidates.some(c => c.file === binding.lastReceipt))
      candidates.push({ file: binding.lastReceipt, request, source: 'binding' });
  }
  // No directory scan or "latest" guess. These reads cannot repair a binding,
  // confirm cleanup, reclaim a lock or authorize another writer.
  if (!candidates.length) return null;
  try { await privateDir(p.receipts, { create: false }); } catch { return null; }
  for (const candidate of candidates) {
    let r;
    try { r = await readJSON(candidate.file, { privateFile: true }); } catch { continue; }
    if (!r || r.schema !== 'cwr.acp.receipt/1' || r.backend !== 'acpx' || r.session_id !== binding.id ||
        r.request_id !== candidate.request || r.route !== binding.route || r.receipt_path !== candidate.file ||
        !['completed','failed','cancelled'].includes(r.runtime_status) || !['confirmed','unconfirmed'].includes(r.cleanup) ||
        !isoTime(r.started_at) || !isoTime(r.finished_at) || Date.parse(r.finished_at) < Date.parse(r.started_at) ||
        (candidate.started && r.started_at !== candidate.started) ||
        (binding.handle?.acpxRecordId && r.acpx_record_id !== binding.handle.acpxRecordId) ||
        (binding.handle?.backendSessionId && r.acp_session_id !== binding.handle.backendSessionId)) continue;
    return { receipt: r, evidence: { source: candidate.source, request_id: r.request_id,
      reported_cleanup: r.cleanup, ...receiptTiming(r) } };
  }
  return null;
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
  const saved = await statusReceipt(p, binding);
  const errorCode = typeof saved?.receipt.error_code === 'string' && /^[A-Z0-9_]{1,80}$/.test(saved.receipt.error_code) ? saved.receipt.error_code : null;
  const marker = binding.active_turn;
  const current = saved?.evidence.source === 'active_turn' ? saved.receipt : null;
  const activeRequest = typeof marker?.request_id === 'string' && UUID.test(marker.request_id) && isoTime(marker.started_at) ? {
    request_id: marker.request_id, started_at: marker.started_at,
    runtime_status: current?.runtime_status ?? null, error_code: current ? errorCode : null,
    receipt: current?.receipt_path ?? null,
  } : null;
  return { schema:'cwr.acp.status/1', session_id:binding.id, active,
    closed:binding.closed === true, last_runtime_status:saved?.receipt.runtime_status ?? null,
    last_error_code:errorCode, active_request:activeRequest,
    cleanup:binding.active_turn ? 'unconfirmed' : binding.cleanup ?? 'unknown',
    last_receipt:saved?.receipt.receipt_path ?? null, receipt_evidence:saved?.evidence ?? null };
}
export { requestCancel } from './state.mjs';

export async function main(args, deps = {}) {
  const opt = parseArgs(args);
  const output = deps.output ?? (r => process.stdout.write(`${JSON.stringify(r)}\n`));
  const text = deps.text ?? (s => process.stdout.write(s));
  if (opt.command === 'help') { (deps.help ?? (s => process.stdout.write(s)))(HELP); return 0; }
  assertSupportedPlatform();
  if (opt.command === 'storage' || opt.command === 'storage-plan') {
    const config = await loadConfig(opt.config);
    const olderThanMs = opt.command === 'storage'
      ? (opt['older-than'] === undefined ? undefined : parseStorageAge(opt['older-than']))
      : parseStorageAge(opt['older-than'] ?? '7d');
    const maxEntries = opt['max-entries'] === undefined ? undefined : Number(opt['max-entries']);
    const maxDepth = opt['max-depth'] === undefined ? undefined : Number(opt['max-depth']);
    if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 1))
      throw new Fault('USAGE', '--max-entries must be a positive integer.');
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 1))
      throw new Fault('USAGE', '--max-depth must be a positive integer.');
    if (opt.command === 'storage') {
      const inventory = await inventoryStorage(config, {
        maxEntries, maxDepth, extraHomes: opt.extraHomes, olderThanMs,
      });
      if (opt.json) output(inventory);
      else text(renderStorageText(inventory));
      return 0;
    }
    const plan = await planStorage(config, {
      targetIds: opt.targets, olderThanMs, maxEntries, maxDepth,
    });
    output(plan);
    return 0;
  }
  if (opt.command === 'storage-apply') {
    const config = await loadConfig(opt.config);
    let receipt;
    try { receipt = await applyStoragePlan(config, { planId: opt.plan, confirm: opt.confirm }); }
    catch (e) {
      if (e.code === 'PLAN_TAMPERED') throw new Fault('PLAN_TAMPERED', 'The saved plan UUID is invalid, tampered or belongs to another state root; nothing was removed.');
      throw e;
    }
    output(receipt);
    return receipt.status === 'applied' ? 0 : receipt.status === 'partial' ? 1 : 2;
  }
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
  if (opt.command === 'delivery') {
    // Read-only private view of one delivery sidecar. Never loads or scrubs for
    // an adapter, never executes anything from the block.
    const config = await loadControlConfig(opt.config);
    // Validate the integration UUID before constructing a managed read path.
    const id = sessionId(opt.session);
    const record = await readDelivery(config.stateDir, id, opt.request ?? null);
    if (opt.json) output(record ?? { schema: 'cwr.acp.delivery-sidecar/1', session_id: id, delivery: null });
    else text(renderDeliveryText(id, record));
    return 0;
  }
  if (opt.command === 'batch') {
    const config = await loadControlConfig(opt.config);
    if (!opt.compact && (opt.limit !== undefined || opt['max-bytes'] !== undefined))
      throw new Fault('USAGE', '--limit/--max-bytes require --compact on batch; the default terminal keeps the full legacy receipt.');
    return runBatch({ config, opt, deps, output, text, cliPath: cli_path() });
  }
  if (opt.command === 'prepare') {
    // Mechanical order/manifest preparation. The full config is needed for
    // route/workspace/permission validation, but nothing is launched and no
    // adapter is imported.
    const config = await loadConfig(opt.config);
    output(await runPrepare({ config, spec: await readJSON(path.resolve(opt.spec), { privateFile: false, maxBytes: 256 * 1024 }), out: opt.out ?? null }));
    return 0;
  }
  if (opt.command === 'collect') {
    // Read-only batch-index view; never loads an adapter, never waits.
    if (opt.job !== undefined && (opt.compact || opt.cursor !== undefined || opt.limit !== undefined || opt['max-bytes'] !== undefined))
      throw new Fault('USAGE', '--job expands a full result and cannot be combined with --compact/--cursor/--limit/--max-bytes.');
    const config = await loadControlConfig(opt.config);
    if (opt.job !== undefined) {
      // Expand ONE settled result in full by manifest job id.
      output(await collectBatchJob({ config, batchId: opt.batch, jobId: opt.job }));
    } else if (opt.compact) {
      const limit = opt.limit === undefined ? undefined : Number(opt.limit);
      const maxBytes = opt['max-bytes'] === undefined ? undefined : Number(opt['max-bytes']);
      output(await collectBatchCompact({ config, batchId: opt.batch, cursor: opt.cursor ?? null, limit, maxBytes }));
    } else if (opt.cursor !== undefined || opt.limit !== undefined || opt['max-bytes'] !== undefined) {
      throw new Fault('USAGE', '--cursor/--limit/--max-bytes require --compact (or use --job to expand one result).');
    } else {
      output(await collectBatch({ config, batchId: opt.batch }));
    }
    return 0;
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
  // Route resolution, freshly per call: explicit --route and continue stay pinned
  // to exactly one route (no fallback); run without --route resolves the current
  // routing.default and, only prelaunch, its authorized fallbacks.
  const resolveOne = name => selectRoute(config, name, opt.cwd ?? binding?.cwd, opt.permissions);
  let selection, routeNote;
  if (opt.route !== undefined) {
    selection = await resolveOne(opt.route); routeNote = opt.route;
  } else if (opt.command === 'continue') {
    selection = await resolveOne(binding.route); routeNote = binding.route;
  } else if (config.routing?.default) {
    const resolved = await resolveRouteSelection(config.routing, resolveOne);
    selection = resolved.selection;
    routeNote = resolved.fallback ? `${resolved.requestedRoute} -> ${resolved.fallback}` : resolved.requestedRoute;
    selection.selection = {
      schema: 'cwr.acp.selection/1', requested_route: resolved.requestedRoute,
      actual_route: selection.name, fallback: resolved.fallback,
      skipped_routes: resolved.skips.map(s => ({ route: s.route, code: s.code })),
    };
  } else {
    throw new Fault('ROUTE_REQUIRED', 'No --route was given and the config has no routing.default. Add --route NAME or register a default route.');
  }
  if (binding) assertBindingIdentity(binding, selection);
  const order = await readOrder(opt.file);
  // The child-only environment option in acpx is not assumed to be a scrubber.
  // Scrub this standalone CLI process BEFORE importing/executing that package.
  // This never changes the shell, Codex, or the native subagent environment.
  assertAdmission(config, selection, opt);
  // A FUTURE binding receives a compact state-root scratch directory. Existing
  // bindings resolve from their saved descriptor/marker; legacy no-manifest
  // bindings keep the route tmp path and can never be silently migrated.
  const newBinding = !binding;
  if (newBinding) {
    const id = randomUUID();
    binding = {
      schema: 'cwr.acp.binding/1', id, route: selection.name,
      executionIdentity: executionIdentity(selection), cwd: selection.cwd, closed: false,
      createdAt: new Date().toISOString(), handle: null,
    };
  }
  // Existing bindings without a manifest stay on the legacy shared tmp. The
  // marker alone never authorizes migration of temp references an adapter may
  // still hold in persistent conversation history.
  let scratchDescriptor, scratchPath;
  let legacyScratch = false;
  if (newBinding) {
    scratchDescriptor = newScratchLocation(config, selection.name, selection.route, binding.id);
    scratchPath = scratchRenderEnvironment(scratchDescriptor);
    binding.scratchDescriptor = scratchDescriptor;
  } else {
    try {
      const existing = await loadScratch(config, selection.name, selection.route, binding.id,
        binding.scratchDescriptor ?? null);
      scratchDescriptor = existing.descriptor;
      scratchPath = existing.scratch;
    } catch (e) {
      if (e.code !== 'SCRATCH_MISSING') throw e;
      if (binding.scratchDescriptor !== undefined)
        throw new Fault('KNOWN_SCRATCH_MISSING', 'The binding records managed scratch, but its manifest is missing.');
      scratchPath = path.join(selection.route.workerHome, 'tmp');
      legacyScratch = true;
    }
  }
  const env = buildEnvironment(selection.route, process.env, process.platform, scratchPath);
  await (deps.replaceEnvironment ?? replaceOwnEnvironment)(env);
  const acpx = await (deps.loadAcpx ?? loadAcpx)();
  await prepareHome(selection.route);
  await privateDir(config.stateDir);
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
  // Both operation locks are held before the ownership marker and new binding
  // become visible. A failed/crashed marker creation therefore stays
  // unreconciled and protected rather than becoming an orphan prune candidate.
  // Locks are held: retain the work order now, before the runtime is touched.
  // Retention failure is deliberately additive: it never changes runtime
  // behavior, but it is recorded durably in the receipt as a warning.
  try { orderPointer = await writeRequestOrder(config.stateDir, binding.id, requestId, order); }
  catch (e) { metadataWarning = 'ORDER_NOT_RETAINED'; }
  config.dispatch.orderPointer = orderPointer;
  config.dispatch.orderWarning = metadataWarning;
  // Machine-readable start handle for a batch runner: written ONLY after every
  // lock is held, before adapter/session setup. Prompt acknowledgement is separate. A batch consumer reads
  // this file instead of scraping human stderr text. Failure to write it is not
  // fatal to the turn (it is a coordination aid), but a batch reports the job
  // without a handle rather than inventing one.
  if (opt['start-handle'] !== undefined) {
    try {
      await atomicJSON(path.resolve(opt['start-handle']), {
        schema: 'cwr.acp.start-handle/1', session_id: binding.id, request_id: requestId,
        cwd: selection.cwd, route: selection.name, phase: 'locks_held', started_at: new Date().toISOString(),
      });
    } catch (e) {
      (deps.progress ?? (s => process.stderr.write(s)))(`[acp] start handle not written (${typeof e?.code === 'string' ? e.code : 'HANDLE_WRITE_FAILED'}); continuing.\n`);
    }
  }
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
  if (!newBinding && legacyScratch) {
    // Bindings created before scratch manifests existed retain the legacy shared
    // route tmp forever. They are inventory-only and never silently migrated.
    (deps.progress ?? (s => process.stderr.write(s)))('[acp] legacy binding uses inspect-only shared tmp\n');
  } else if (!newBinding) {
    const current = await loadBinding(config.stateDir, binding.id);
    const existing = await loadScratch(config, selection.name, selection.route, binding.id,
      current.scratchDescriptor ?? null);
    if (JSON.stringify(current.scratchDescriptor ?? null) !== JSON.stringify(existing.descriptor)) {
      current.scratchDescriptor = existing.descriptor;
      await atomicJSON(p.binding, current);
      binding = current;
    }
  }
    if (newBinding) {
      await (deps.createScratch ?? createScratch)(config, selection.name, selection.route, binding.id);
      // If binding publication fails, retain the manifest as inspect-only orphan
      // evidence. The existing guard releases locks without starting an adapter.
      await (deps.atomicJSON ?? atomicJSON)(p.binding, binding);
    }
    // Fresh read under BOTH held locks: a continue/run that read an open binding
    // before a concurrent close could otherwise execute its stale open binding.
    // Reload, recheck closure and route fingerprint, and use the current handle
    // so no review write or prompt proceeds against superseded state. Errors here
    // happen before the runtime is touched, so the finally block safely releases
    // every owned lock.
    if (binding && opt.command === 'continue') {
      const current = await loadBinding(config.stateDir, binding.id);
      if (current.closed === true) throw new Fault('SESSION_CLOSED', 'The work order is closed.');
      if (current.route !== binding.route || current.cwd !== binding.cwd)
        throw new Fault('ROUTE_CHANGED', 'The bound route/workspace changed while acquiring its locks; refusing to rebind.');
      assertBindingIdentity(current, selection);
      // Re-read current authorization under the locks too: revocation during
      // environment/import preparation must not launch one more continuation.
      const currentConfig = await loadConfig(opt.config, process.platform, { mainHome: config.mainHome });
      if (currentConfig.stateDir !== config.stateDir)
        throw new Fault('STATE_CHANGED', 'The configured state root changed during preflight; retry only after reconciling the original operation.');
      selection = await selectRoute(currentConfig, current.route, current.cwd, opt.permissions);
      const legacy = assertBindingIdentity(current, selection);
      if (legacy) {
        current.executionIdentity = executionIdentity(selection);
        delete current.routeFingerprint;
        await atomicJSON(p.binding, current);
      }
      binding = current;
    }
    assertAdmission(config, selection, opt);
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
    (deps.progress ?? (s => process.stderr.write(s)))(`[acp] session ${binding.id}; route ${routeNote}; ${selection.permissions} permissions\n`);
    receipt = await executeTurn({config,selection,binding,text:order,isNew:opt.command==='run',acpx,signal:controller.signal,requestId,deliver:Boolean(opt.deliver)});
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
// A private human view of the worker-declared summary and bounded counts.
// It is not a public/share projection.
export function renderDeliveryText(session, record) {
  if (!record) return `No delivery collected for session ${session}.\n`;
  const w = record.worker ?? {};
  const lines = [`Delivery for session ${session} request ${record.request_id}: ${w.status}${w.code ? ` (${w.code})` : ''}`];
  const block = w.block;
  if (block) {
    lines.push(`summary: ${block.summary}`);
    lines.push(`criteria ${block.criteria.length} | checks ${block.checks.length} (worker_reported) | artifacts ${block.artifacts.length} | questions ${block.questions.length}`);
  }
  if (record.observed?.runtime_status) lines.push(`runtime_status ${record.observed.runtime_status}; cleanup ${record.observed.cleanup ?? 'unknown'}`);
  if (record.collection_warnings?.invalid_sidecars) lines.push('invalid sidecars skipped: ' + record.collection_warnings.invalid_sidecars);
  return lines.join('\n') + '\n';
}
function storageSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 'B';
  for (const next of units) { if (value < 1024) break; value /= 1024; unit = next; }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
export function renderStorageText(inventory) {
  const t = inventory.totals, lines = [
    `Storage inventory observed ${inventory.observed_at}`,
    `logical ${storageSize(t.bytes)} | allocated estimate ${storageSize(t.allocated_bytes)} | entries ${t.entries} | homes ${t.homes}`,
    `managed scratch eligible ${t.candidate_targets} target(s), logical ${storageSize(t.candidate_bytes)} | allocated ${storageSize(t.candidate_allocated_bytes)}`,
  ];
  for (const home of inventory.homes) {
    lines.push(`\n${home.route ?? 'retired profile'} [${home.status}] ${home.path}`);
    for (const category of home.categories) {
      lines.push(`  ${category.category.padEnd(21)} ${storageSize(category.bytes)} logical / ${storageSize(category.allocated_bytes)} allocated  ${category.entries} entries  ${category.status}`);
    }
  }
  const inspect = inventory.targets.filter(x => x.eligibility !== 'candidate' && x.entries);
  if (inspect.length) {
    lines.push('\nInspect-only or incomplete targets:');
    for (const target of inspect.slice(0, 100))
      lines.push(`  ${target.id}  ${target.eligibility}  ${storageSize(target.bytes)}  ${target.path}  ${target.reasons.map(r => r.code).join(',') || 'no reason'}`);
    if (inspect.length > 100) lines.push(`  ... ${inspect.length - 100} more omitted`);
  }
  const candidates = inventory.targets.filter(x => x.eligibility === 'candidate');
  if (candidates.length) {
    lines.push('\nManaged scratch candidates:');
    for (const target of candidates) lines.push(`  ${target.id}  ${storageSize(target.bytes)}  ${target.path}`);
  }
  return lines.join('\n') + '\n';
}
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
  const handle = await dashboard.startDashboard({
    stateDir: config.stateDir, configPath: config.configPath, since, port,
  });
  text(`Dispatch dashboard: ${handle.url}\n`);
  text('Open this private URL in your browser and keep this process running (Ctrl+C to stop).\n');
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
    // A prelaunch failure may have skipped unavailable candidates before a later
    // fatal error (for example a BUSY lock after the default was skipped), so the
    // terminal message must not claim that no selection occurred. Fault messages
    // already stay bounded and path-free; the non-Fault fallback also avoids any
    // "no fallback" claim. The local receipt carries the exact selection evidence.
    const message = e instanceof Fault ? e.message : 'Local operation failed. Inspect the private runtime state; no post-launch route fallback occurred.';
    process.stderr.write(JSON.stringify({schema:'cwr.acp.error/1',code,message})+'\n');
    process.exitCode=2;
  });
}
