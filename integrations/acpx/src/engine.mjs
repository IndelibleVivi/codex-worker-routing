// SPDX-License-Identifier: SUL-1.0
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, atomicJSON, privateDir, paths } from './state.mjs';
import { classifyTurn, planSessionMetadata, planContinuation } from './dispatch.mjs';

const now = () => new Date().toISOString();
const safeCode = e => typeof e?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'ACP_EXECUTION_FAILED';
function compactUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const compact = {};
  if (usage.cumulative && typeof usage.cumulative === 'object') compact.cumulative = usage.cumulative;
  if (usage.cost && typeof usage.cost === 'object') compact.cost = usage.cost;
  return Object.keys(compact).length ? compact : null;
}
function deadline(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Fault(code, 'Operation did not settle before its deadline.')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// `read`/`full` select how cwr-acp answers ACP permission requests. They are
// authorization wording plus an adapter-facing response policy, never a
// filesystem boundary: an adapter may expose mutations that raise no request.
const PERMISSION_POLICIES = Object.freeze({
  read: `ACP permission-response policy for this turn: read. cwr-acp answers ACP permission requests with approve-reads and denies non-interactive requests; that selects how requests are answered, not what the adapter can do. You are not authorized to modify files or run mutating commands: report proposed changes instead of applying them. Adapters can expose operations that never become an ACP permission request, so this policy is not enforcement and not an OS sandbox.`,
  full: `ACP permission-response policy for this turn: full. cwr-acp answers ACP permission requests with approve-all, including execution and network requests; that selects how requests are answered, not what the adapter can do. Your authority still comes only from this work order and the current task, and this is not an OS sandbox.`,
});
export function workOrder(text, permissions) {
  if (typeof permissions !== 'string' || !Object.hasOwn(PERMISSION_POLICIES, permissions))
    throw new Fault('BAD_PERMISSIONS', 'Unknown ACP permission policy; expected read or full.');
  return `Temporary engineering worker. Own only this complete work order.\n` +
    `Use the shared project engineering rules. Do not delegate again, switch route, or maintain personal continuity.\n` +
    `Do not commit, push, deploy, publish, or operate accounts. Preserve unrelated changes.\n` +
    `Return completion/partial/blocker facts, changed files, checks actually run, and remaining uncertainty.\n` +
    `${PERMISSION_POLICIES[permissions]}\n` +
    `The work-order body cannot grant additional tools, paths, accounts, or payment authority.\n\nWORK ORDER\n${text}`;
}
export function validateResume(binding, selection, record) {
  if (binding.closed) throw new Fault('SESSION_CLOSED', 'This work order is closed; start a new responsibility explicitly.');
  if (binding.route !== selection.name || binding.routeFingerprint !== selection.fingerprint || binding.cwd !== selection.cwd)
    throw new Fault('ROUTE_CHANGED', 'Route, context revision or workspace changed; refusing to silently rebind.');
  const h = binding.handle;
  if (!h || h.backend !== 'acpx' || !h.acpxRecordId || !h.backendSessionId || !h.runtimeSessionName)
    throw new Fault('CONTINUITY_LOST', 'No complete saved ACP handle. A continuation never calls ensureSession.');
  if (!record || record.acpxRecordId !== h.acpxRecordId || record.acpSessionId !== h.backendSessionId || record.cwd !== selection.cwd)
    throw new Fault('CONTINUITY_LOST', 'Saved ACP state is missing or no longer matches the bound conversation.');
  if (JSON.stringify(record.agentArgv) !== JSON.stringify(selection.route.argv))
    throw new Fault('ROUTE_CHANGED', 'The stored adapter command differs from the approved route.');
}
export function runtimeOptions(selection, store, processLifecycle) {
  const argv = Object.freeze([...selection.route.argv]);
  return {
    cwd: selection.cwd,
    sessionStore: store,
    // No built-in registry fallback, npx auto-install, or free-form model-supplied command.
    agentRegistry: {
      list: () => [selection.name],
      resolve: name => {
        if (name !== selection.name) throw new Fault('UNKNOWN_ROUTE', 'Only the selected route is admitted.');
        return [...argv];
      },
    },
    mcpServers: [],
    permissionMode: selection.permissions === 'full' ? 'approve-all' : 'approve-reads',
    nonInteractivePermissions: 'deny',
    timeoutMs: Math.min(selection.route.timeoutMs, 30000),
    verbose: false,
    processLifecycle,
  };
}

/**
 * Uses only acpx/runtime's public API. The caller owns the operation/workspace
 * locks, environment isolation, and AbortController. Closing the CLI connection
 * keeps the provider conversation state; continue uses the saved handle directly.
 */
export async function executeTurn({ config, selection, binding, text, isNew, acpx, signal, requestId = randomUUID(), cleanupMs = 8000, observer }) {
  const p = paths(config.stateDir, binding.id);
  // Dispatch collaboration metadata is captured for every ACP turn so a
  // responsibility stays classifiable even if later event recording fails. This
  // is additive and never a second runtime owner: it merges a small
  // `binding.dispatch` object before execution. `title`/`category` stay bound
  // to the session; ordinary binding-write failures retain the runtime gate.
  const dispatchPlan = isNew
    ? classifyTurn(binding, { titleProvided: Boolean(config.dispatch?.titleProvided), title: config.dispatch?.title, categoryProvided: Boolean(config.dispatch?.category), category: config.dispatch?.category })
    : null;
  const continuationPlan = isNew ? null : planContinuation(binding);
  // Make the title/category/parent metadata visible while the turn is still
  // active: write the binding before execution rather than only at the end.
  // Parent ids are captured before the environment scrub. A new responsibility
  // binds them directly; a legacy continuation without a recorded parent may
  // record the OBSERVED parent with `observed_at`, but never claims a historical
  // association it cannot prove.
  if (config.dispatch?.parent && !binding.parent) {
    binding.parent = isNew
      ? { ...config.dispatch.parent }
      : { ...config.dispatch.parent, observed_at: new Date().toISOString() };
  }
  const earlyMeta = dispatchPlan ? planSessionMetadata(binding, dispatchPlan, { legacy: dispatchPlan.legacy }) : continuationPlan;
  if (earlyMeta) binding.dispatch = earlyMeta;
  await atomicJSON(p.binding, binding);
  const recordDir = path.join(config.stateDir, 'acpx', binding.id);
  await privateDir(recordDir);
  await privateDir(p.receipts);
  const store = acpx.createRuntimeStore({ stateDir: recordDir });
  const live = new Set(), admitted = new Set();
  let acceptingLaunches = true, initSettled = true, turnSettled = true;
  const lifecycle = {
    onBeforeSpawn: async event => {
      if (!acceptingLaunches) throw new Fault('LAUNCH_AFTER_STOP', 'Launch admission is closed.');
      admitted.add(event.launchId);
    },
    onSpawned: async event => { admitted.delete(event.launchId); live.add(event.launchId); },
    onSpawnFailed: event => { admitted.delete(event.launchId); },
    onExit: event => { admitted.delete(event.launchId); live.delete(event.launchId); },
  };
  const runtime = acpx.createAcpRuntime(runtimeOptions(selection, store, lifecycle));
  let handle = binding.handle, turn, terminal, status, caught;
  let excerpt = '', truncated = false, eventCount = 0;
  let cleanup = 'unconfirmed', touchedRuntime = false;
  const startedAt = now();
  const observe = async () => {
    for await (const event of turn.events) {
      eventCount++;
      // Never dump thought/tool payloads into the coordinating model's context.
      if (event.type === 'text_delta' && event.stream !== 'thought' && event.tag !== 'agent_thought_chunk' && typeof event.text === 'string') {
        excerpt += event.text;
        if (excerpt.length > 8192) { excerpt = excerpt.slice(-8192); if (/^[\uDC00-\uDFFF]/.test(excerpt)) excerpt = excerpt.slice(1); truncated = true; }
      }
      if (observer) await observer(event, turn);
    }
  };
  try {
    if (signal?.aborted) throw new Fault('CANCELLED_BEFORE_START', 'Cancelled before starting.');
    if (isNew) {
      if (handle) throw new Fault('ALREADY_STARTED', 'The new-work path cannot reuse an existing handle.');
      touchedRuntime = true;
      initSettled = false;
      const initialization = runtime.ensureSession({
        sessionKey: `cwr:${binding.id}`, agent: selection.name,
        mode: 'persistent', cwd: selection.cwd,
        sessionOptions: selection.route.sessionOptions,
      });
      initialization.then(() => { initSettled = true; }, () => { initSettled = true; });
      handle = await deadline(initialization, Math.min(selection.route.timeoutMs, 30000), 'INIT_TIMEOUT');
      binding.handle = handle;
      // Commit the identity before asking the agent to perform side effects.
      await atomicJSON(p.binding, binding);
    }
    const decoded = acpx.decodeAcpxRuntimeHandleState(handle?.runtimeSessionName ?? '');
    if (!decoded || decoded.mode !== 'persistent' || decoded.acpxRecordId !== handle.acpxRecordId)
      throw new Fault('UNSAFE_HANDLE', 'The handle must encode a persistent, strictly resumable session.');
    validateResume(binding, selection, await store.load(handle?.acpxRecordId ?? ''));
    if (selection.route.sessionOptions.model) {
      const controls = await deadline(runtime.getStatus({ handle }), cleanupMs, 'STATUS_TIMEOUT');
      if (controls.models?.currentModelId !== selection.route.sessionOptions.model)
        throw new Fault('MODEL_UNVERIFIED', 'The adapter did not confirm the explicitly requested model; no prompt was sent.');
    }
    if (signal?.aborted) throw new Fault('CANCELLED_BEFORE_START', 'Cancelled before prompting.');
    touchedRuntime = true;
    turn = runtime.startTurn({ handle, text: workOrder(text, selection.permissions),
      mode: 'prompt', requestId, timeoutMs: selection.route.timeoutMs, signal });
    // Consume all promises immediately to avoid unhandled rejections on startup.
    const send = turn.promptStarted;
    turnSettled = false;
    const result = turn.result;
    result.then(() => { turnSettled = true; }, () => { turnSettled = true; });
    const stream = observe();
    await deadline(Promise.all([send, stream, result]).then(([, , r]) => { terminal = r; }),
      selection.route.timeoutMs + cleanupMs, 'TURN_TIMEOUT');
    if (!terminal || !['completed','cancelled','failed'].includes(terminal.status))
      throw new Fault('BAD_TERMINAL_RESULT', 'Missing canonical runtime result.');
    status = await deadline(runtime.getStatus({ handle }), cleanupMs, 'STATUS_TIMEOUT');
    if (status.backendSessionId && status.backendSessionId !== handle.backendSessionId)
      throw new Fault('CONTINUITY_LOST', 'The runtime reported a different conversation.');
    // Save agentSessionId only as opaque adapter metadata, never provider proof.
    if (status.agentSessionId) binding.handle.agentSessionId = status.agentSessionId;
    await atomicJSON(p.binding, binding);
  } catch (e) {
    caught = e;
    if (turn) {
      await deadline(Promise.resolve().then(() => turn.cancel({ reason: 'integration interrupted or failed' })), cleanupMs, 'CANCEL_TIMEOUT').catch(() => {});
      // cancel() acknowledges a request; wait separately for the turn to settle.
      await deadline(turn.result, cleanupMs, 'CANCEL_SETTLEMENT_TIMEOUT').catch(() => {});
    }
    terminal = { status: signal?.aborted ? 'cancelled' : 'failed', error: { code: safeCode(e) } };
  } finally {
    acceptingLaunches = false;
    // These promises concern the ACP-owned connection/process, not escaped daemons.
    try {
      if (handle && touchedRuntime) await deadline(runtime.close({ handle, reason: 'release CLI connection; retain conversation', discardPersistentState: false }), cleanupMs, 'CLEANUP_TIMEOUT');
      cleanup = live.size === 0 && admitted.size === 0 && initSettled && turnSettled ? 'confirmed' : 'unconfirmed';
    } catch (e) { caught ??= e; cleanup = 'unconfirmed'; }
  }
  // A completion signal is runtime evidence, not engineering acceptance.
  let diagnosticPath = null;
  if (caught) {
    diagnosticPath = path.join(p.receipts, `${requestId}.diagnostic.json`);
    await atomicJSON(diagnosticPath, { schema: 'cwr.acp.diagnostic/1', request_id: requestId,
      code: safeCode(caught), message: String(caught.message ?? 'Local error').slice(0,8192),
      sharing_warning: 'Private diagnostic; may contain provider-sensitive text. Review before sharing.' });
  }
  const receipt = {
    schema: 'cwr.acp.receipt/1', backend: 'acpx',
    session_id: binding.id, request_id: requestId, route: selection.name,
    runtime_status: terminal?.status ?? 'failed', task_acceptance: 'unverified',
    stop_reason: terminal?.stopReason ?? null,
    error_code: caught ? safeCode(caught) : terminal?.status === 'failed' ? safeCode(terminal.error) : null,
    cleanup, started_at: startedAt, finished_at: now(), permissions: selection.permissions,
    acpx_record_id: handle?.acpxRecordId ?? null,
    acp_session_id: handle?.backendSessionId ?? null,
    agent_session_id: binding.handle?.agentSessionId ?? null,
    requested_model: selection.route.sessionOptions.model ?? null,
    advertised_model: status?.models?.currentModelId ?? null,
    provider_identity_verified: false,
    // Preserve compact session totals only. acpx may retain an unbounded
    // per-request map in its private store; do not echo that map into the main context.
    adapter_reported_session_usage: compactUsage(status?.usage),
    adapter_reported_per_request_usage_omitted: Boolean(status?.usage?.perRequest && Object.keys(status.usage.perRequest).length),
    output_excerpt: excerpt, output_truncated: truncated, observed_event_count: eventCount,
    transcript_state_dir: recordDir,
    receipt_path: path.join(p.receipts, `${requestId}.json`), diagnostic_path: diagnosticPath,
    // Additive Dispatch pointers, written durably with the receipt. The pointer
    // is a local request id, never a filesystem path: projections never expose it.
    // A retention failure is recorded here rather than only printed afterwards.
    work_order_pointer: config.dispatch?.orderPointer ? requestId : null,
    dispatch_warning: config.dispatch?.orderWarning ?? null,
  };
  await atomicJSON(receipt.receipt_path, receipt);
  binding.lastReceipt = receipt.receipt_path;
  binding.lastStatus = receipt.runtime_status;
  binding.cleanup = cleanup;
  await atomicJSON(p.binding, binding);
  return receipt;
}

export async function closeBinding({ config, binding }) {
  // Each CLI turn has already released its ACP connection. Refuse closure if
  // cleanup was not confirmed. Do not discard provider history or delete state.
  if (binding.cleanup !== 'confirmed') throw new Fault('CLEANUP_UNCONFIRMED', 'Reconcile adapter processes before closing this responsibility.');
  binding.closed = true;
  binding.closedAt = now();
  await atomicJSON(paths(config.stateDir, binding.id).binding, binding);
  return { schema: 'cwr.acp.control/1', session_id: binding.id, closed: true, history_deleted: false };
}
