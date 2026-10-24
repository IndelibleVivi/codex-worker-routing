// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Fault, atomicJSON, digest, loadBinding, lock, paths, privateDir, readJSON, sessionId } from './state.mjs';
import {
  defaultProcessEvidence, descendantsOf, identityKey,
} from './process-evidence.mjs';

export const OWNER_SCHEMA = 'cwr.acp.lock-owner/2';
export const JOURNAL_SCHEMA = 'cwr.acp.lifecycle/1';
export const RECOVERY_SCHEMA = 'cwr.acp.recovery/1';
const SAFE_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SAFE_DIGEST = /^[a-f0-9]{64}$/;
const JOURNAL_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const CLAIM_WAIT_MS = 5000;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const clone = value => value === undefined ? undefined : structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processUnavailable = error => ['PROCESS_IDENTITY_UNAVAILABLE', 'EPERM', 'ENOENT', 'EACCES'].includes(error?.code);

function fail(code, message) { throw new Fault(code, message); }
function usableProcessEvidence(processEvidence) {
  if (!processEvidence || typeof processEvidence.boot !== 'function' ||
      typeof processEvidence.snapshot !== 'function' || typeof processEvidence.identity !== 'function')
    return defaultProcessEvidence;
  return processEvidence;
}
function processIdentity(value, { allowUnverified = false } = {}) {
  if (!value || value.schema !== 'cwr.acp.process-identity/1' ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.start !== 'string' || !value.start ||
      (!allowUnverified && value.start.startsWith('unverified:'))) return null;
  return value;
}
function unverifiedIdentity(pid, reason) {
  return {
    schema: 'cwr.acp.process-identity/1', pid,
    parent_pid: null, process_group: null,
    start: `unverified:${reason}`.slice(0, 160), executable_hint: null,
  };
}
function journalPath(config, id, name) {
  if (typeof name !== 'string' || !JOURNAL_NAME.test(name))
    fail('LOCK_EVIDENCE_INCOMPLETE', 'The task lock owner has no valid lifecycle journal pointer.');
  return path.join(config.stateDir, 'bindings', id, 'lifecycle', name);
}
function bindingPaths(config, id) {
  return paths(config.stateDir, id);
}
async function currentBinding(config, expected) {
  const current = await loadBinding(config.stateDir, expected.id);
  if (digest(current) !== digest(expected))
    fail('RECOVERY_BINDING_CHANGED', 'The durable binding changed; inspect the current session again before recovery.');
  return current;
}
async function directoryPresent(dir) {
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory())
      fail('LOCK_EVIDENCE_INCOMPLETE', 'A task lock path is not a real directory.');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function evidenceSnapshot(processEvidence) {
  processEvidence = usableProcessEvidence(processEvidence);
  try {
    const [boot, rows] = await Promise.all([processEvidence.boot(), processEvidence.snapshot()]);
    return { boot, rows };
  } catch (error) {
    if (processUnavailable(error)) return { unavailable: true };
    throw error;
  }
}
export function contractFingerprint() {
  return digest({ schema: 'cwr.acp.recovery-contract/2' });
}

/**
 * Host identity is persisted only as a private digest. A present process group
 * remains useful positive-liveness evidence, but is never complete stop proof:
 * ordinary PTY tools can leave both the CLI group and session.
 */
export async function createAdmissionOwner({
  session, requestId, cwd, route, permissions, workspaceKey,
  processEvidence = defaultProcessEvidence,
  ownerPid = process.pid,
}) {
  processEvidence = usableProcessEvidence(processEvidence);
  sessionId(session);
  if (!SAFE_UUID.test(requestId ?? ''))
    fail('BAD_REQUEST_ID', 'Expected the integration request UUID.');
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !path.isAbsolute(cwd))
    fail('BAD_LOCK_OWNER', 'Could not construct the operation owner identity.');
  let boot = `unavailable:${process.platform}:${randomUUID()}`;
  let identity = unverifiedIdentity(ownerPid, 'owner-identity-unavailable');
  let host = null;
  try {
    const [observedBoot, observed, observedHost] = await Promise.all([
      processEvidence.boot(), processEvidence.identity(ownerPid),
      typeof processEvidence.host === 'function' ? processEvidence.host() : Promise.resolve(null),
    ]);
    if (observed) {
      boot = observedBoot;
      identity = observed;
      if (observedHost) host = { schema: 'cwr.acp.host-identity/1', digest: observedHost };
    }
  } catch (error) {
    if (!processUnavailable(error)) throw error;
  }
  return {
    schema: OWNER_SCHEMA, nonce: randomUUID(), pid: ownerPid, session,
    request_id: requestId, cwd, route, permissions, workspace_key: workspaceKey,
    started_at: new Date().toISOString(), boot, host, process: clone(identity),
    journal: `${requestId}.json`, contract: contractFingerprint(),
  };
}

function assertNewOwner(owner, expected) {
  if (!owner || owner.schema !== OWNER_SCHEMA || !SAFE_UUID.test(owner.nonce ?? '') ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      !SAFE_UUID.test(owner.session ?? '') || !SAFE_UUID.test(owner.request_id ?? '') ||
      !iso(owner.started_at) || typeof owner.boot !== 'string' || !owner.boot ||
      owner.contract !== contractFingerprint() || !JOURNAL_NAME.test(owner.journal ?? '') ||
      typeof owner.cwd !== 'string' || !path.isAbsolute(owner.cwd) ||
      !SAFE_DIGEST.test(owner.workspace_key ?? '') ||
      !processIdentity(owner.process, { allowUnverified: true }) ||
      owner.process.pid !== owner.pid)
    fail('LOCK_EVIDENCE_INCOMPLETE', 'The task lock owner evidence is missing or malformed.');
  if (owner.host !== null && owner.host !== undefined &&
      (owner.host?.schema !== 'cwr.acp.host-identity/1' || !SAFE_DIGEST.test(owner.host.digest ?? '')))
    fail('LOCK_EVIDENCE_INCOMPLETE', 'The task host identity is malformed.');
  if ((expected.session !== undefined && owner.session !== expected.session) ||
      (expected.cwd !== undefined && owner.cwd !== expected.cwd) ||
      (expected.workspaceKey !== undefined && owner.workspace_key !== expected.workspaceKey))
    fail('LOCK_PAIR_MISMATCH', 'The task lock owner identifies another session, workspace or lock pair.');
  return owner;
}

function assertLegacyOwner(owner, expected) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
      !SAFE_UUID.test(owner.nonce ?? '') ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      !SAFE_UUID.test(owner.session ?? '') ||
      !iso(owner.startedAt ?? owner.started_at))
    fail('LOCK_EVIDENCE_INCOMPLETE', 'The legacy task lock owner evidence is missing or malformed.');
  if (owner.session !== expected.session ||
      (owner.cwd !== undefined && owner.cwd !== expected.cwd) ||
      (owner.workspace_key !== undefined && owner.workspace_key !== expected.workspaceKey))
    fail('LOCK_PAIR_MISMATCH', 'The legacy task lock owner identifies another session or workspace.');
  return owner;
}

function assertJournal(journal, owner) {
  if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.version !== 1 ||
      journal.session_id !== owner.session || journal.request_id !== owner.request_id ||
      journal.owner_nonce !== owner.nonce || journal.cwd !== owner.cwd ||
      journal.boot !== owner.boot || !iso(journal.created_at) ||
      journal.contract_fingerprint !== owner.contract || !Array.isArray(journal.records))
    fail('LOCK_EVIDENCE_INCOMPLETE',
      `Lifecycle evidence for workspace ${owner.cwd} and session ${owner.session} is missing, malformed or changed.`);
  const launches = new Map(), observed = new Map();
  let complete = true;
  for (const record of journal.records) {
    if (!record || typeof record.kind !== 'string' || !iso(record.at) ||
        (record.launch_id !== undefined && typeof record.launch_id !== 'string'))
      fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence contains an invalid record.');
    if (record.kind === 'admitted') {
      if (typeof record.launch_id !== 'string' || launches.has(record.launch_id))
        fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence contains an invalid admission.');
      launches.set(record.launch_id, { spawned: null, failed: false });
    }
    if (record.kind === 'spawn_failed') {
      const launch = launches.get(record.launch_id);
      if (!launch || launch.spawned || launch.failed)
        fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence has a contradictory spawn failure.');
      launch.failed = true;
    }
    if (record.kind === 'spawned') {
      const launch = launches.get(record.launch_id);
      const identity = processIdentity(record.process, { allowUnverified: true });
      if (!launch || launch.spawned || launch.failed || !identity)
        fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence has an invalid spawned process identity.');
      launch.spawned = identity;
      if (identity.start.startsWith('unverified:')) complete = false;
    }
    if (record.kind === 'descendants') {
      if (!Array.isArray(record.processes) || record.processes.length > 4096)
        fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence has invalid descendants.');
      for (const value of record.processes) {
        const identity = processIdentity(value, { allowUnverified: true });
        if (!identity)
          fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence has an invalid observed descendant.');
        observed.set(identityKey(identity) ?? `${identity.pid}:${identity.start}`, identity);
        if (identity.start.startsWith('unverified:')) complete = false;
      }
    }
  }
  for (const launch of launches.values()) {
    if (!launch.spawned && !launch.failed) complete = false;
  }
  return {
    complete,
    roots: [...launches.values()].flatMap(value => value.spawned ? [value.spawned] : []),
    observed: [...observed.values()],
  };
}

export async function initializeLifecycleJournal({ config, owner }) {
  const file = journalPath(config, owner.session, owner.journal);
  await atomicJSON(file, {
    schema: JOURNAL_SCHEMA, version: 1, session_id: owner.session,
    request_id: owner.request_id, owner_nonce: owner.nonce, cwd: owner.cwd,
    boot: owner.boot, contract_fingerprint: owner.contract,
    created_at: new Date().toISOString(), records: [],
  });
  return file;
}

export function createLifecycleJournal({ config, owner }) {
  const file = journalPath(config, owner.session, owner.journal);
  let serial = Promise.resolve(), closed = false;
  const append = record => {
    serial = serial.then(async () => {
      if (closed) return;
      let journal;
      try {
        journal = await readJSON(file, { privateFile: true, maxBytes: 4 * 1024 * 1024 });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fail('LOCK_EVIDENCE_INCOMPLETE', 'Lifecycle evidence was removed while the operation owned its locks.');
      }
      assertJournal(journal, owner);
      journal.records.push({ ...record, at: new Date().toISOString() });
      await atomicJSON(file, journal);
    }).catch(error => {
      if (error instanceof Fault) throw error;
      fail('RECOVERY_EVIDENCE_WRITE_FAILED',
        `Could not persist lifecycle evidence for workspace ${owner.cwd} and session ${owner.session}.`);
    });
    return serial;
  };
  return Object.freeze({
    path: file,
    admitted: launchId => append({ kind: 'admitted', launch_id: launchId }),
    spawned: ({ launchId, process: identity }) => {
      const value = processIdentity(identity, { allowUnverified: true });
      if (!value) fail('PROCESS_IDENTITY_UNAVAILABLE', 'The runtime did not expose a process identity.');
      return append({ kind: 'spawned', launch_id: launchId, process: clone(value) });
    },
    descendants: ({ launchId, processes }) => append({
      kind: 'descendants', launch_id: launchId, processes: processes.map(clone),
    }),
    spawnFailed: launchId => append({ kind: 'spawn_failed', launch_id: launchId }),
    exited: launchId => {
      // Adapter exit arrives asynchronously after runtime.close(). Await this
      // write explicitly before deciding cleanup, rather than letting finish()
      // overtake an exit notification that is already in flight.
      return append({ kind: 'exited', launch_id: launchId });
    },
    async close() {
      await serial;
    },
    async finish() {
      if (closed) return;
      await serial;
      closed = true;
    },
  });
}

/**
 * Lifecycle observations belong to cleanup evidence. They are intentionally not
 * used as a recovery absence oracle because ordinary children can reparent.
 */
export function createLifecycleHooks(journal, processEvidence = defaultProcessEvidence) {
  processEvidence = usableProcessEvidence(processEvidence);
  const live = new Map(), admitted = new Set(), pendingExits = new Set();
  let accepting = true;
  const observeEach = async () => {
    let rows;
    try { rows = await processEvidence.snapshot(); } catch { return; }
    for (const [launchId, root] of live) {
      try {
        const current = rows.find(row => row.pid === root.pid);
        const base = current && identityKey(current) === identityKey(root) ? current : root;
        const descendants = descendantsOf(base, rows);
        if (descendants.length) {
          await journal.descendants({ launchId, processes: descendants });
        }
      } catch { /* Observation failure never manufactures absence. */ }
    }
  };
  return Object.freeze({
    accepting: () => accepting,
    stopAdmission() { accepting = false; },
    liveSize: () => live.size,
    admittedSize: () => admitted.size,
    async onBeforeSpawn(event) {
      if (!accepting) fail('LAUNCH_AFTER_STOP', 'Launch admission is closed.');
      await journal.admitted(event.launchId);
      admitted.add(event.launchId);
    },
    async onSpawned(event) {
      let identity;
      try { identity = await processEvidence.identity(event.pid); }
      catch (error) {
        if (!processUnavailable(error)) { accepting = false; throw error; }
      }
      identity ??= unverifiedIdentity(event.pid, 'spawn-identity-unavailable');
      await journal.spawned({ launchId: event.launchId, process: identity });
      live.set(event.launchId, identity);
      admitted.delete(event.launchId);
    },
    async onSpawnFailed(event) {
      await journal.spawnFailed(event.launchId);
      admitted.delete(event.launchId);
    },
    onExit(event) {
      const identity = live.get(event.launchId);
      // acpx does not await this callback. Consume its positive exit notification
      // synchronously, then explicitly flush the durable write before cleanup.
      live.delete(event.launchId);
      admitted.delete(event.launchId);
      if (!identity) return;
      const pending = journal.exited(event.launchId);
      pendingExits.add(pending);
      pending.finally(() => pendingExits.delete(pending)).catch(() => {});
      return pending;
    },
    observe: observeEach,
    async closeAdmission() {
      accepting = false;
      await observeEach();
      await Promise.all([...pendingExits]);
      await journal.finish();
    },
  });
}

async function readExactPair(p, workspaceLock, expected) {
  let sessionOwner, workspaceOwner;
  try {
    sessionOwner = await readJSON(path.join(p.lock, 'owner.json'), { privateFile: true });
    workspaceOwner = await readJSON(path.join(workspaceLock, 'owner.json'), { privateFile: true });
  } catch (error) {
    if (error.code === 'ENOENT')
      fail('LOCK_EVIDENCE_INCOMPLETE', 'A task lock is missing its owner evidence.');
    throw error;
  }
  if (sessionOwner?.nonce !== workspaceOwner?.nonce ||
      digest(sessionOwner) !== digest(workspaceOwner))
    fail('LOCK_PAIR_MISMATCH', 'The session and workspace locks do not belong to the same exact owner.');
  if (sessionOwner?.schema === OWNER_SCHEMA) assertNewOwner(sessionOwner, expected);
  else assertLegacyOwner(sessionOwner, expected);
  return sessionOwner;
}

function inspectionSignature(owner, workspaceKey, binding, journalDigest) {
  return digest({
    contract: contractFingerprint(), binding: digest(binding),
    workspace_key: workspaceKey, pair: digest(owner), journal: journalDigest,
  });
}
async function latestRecoveryRecord(config, id) {
  const dir = path.join(config.stateDir, 'recovery-records', id);
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const records = [];
  for (const name of names.filter(value => value.endsWith('.json'))) {
    try {
      const value = await readJSON(path.join(dir, name), { privateFile: true, maxBytes: 128 * 1024 });
      if (value?.schema === RECOVERY_SCHEMA && value.session_id === id) records.push(value);
    } catch (error) {
      if (error.code !== 'ENOENT')
        fail('RECOVERY_RECORD_INVALID', 'A durable recovery record for this session is malformed; admission stays blocked.');
    }
  }
  return records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1) ?? null;
}
async function inspectPartialRecovery({ config, id, binding, workspaceKey, sessionPresent, workspacePresent }) {
  const record = await latestRecoveryRecord(config, id);
  const base = {
    schema: 'cwr.acp.recovery-inspection/1', session_id: id, cwd: binding.cwd,
    workspace_key: workspaceKey, session_lock_present: sessionPresent,
    workspace_lock_present: workspacePresent, automatic_recovery: false,
    attestation_allowed: false,
  };
  if (!record || !['planned', 'partial'].includes(record.status) ||
      record.workspace_key !== workspaceKey || record.cwd !== binding.cwd ||
      record.binding_fingerprint !== digest(binding) ||
      !SAFE_UUID.test(record.recovery_id ?? '') ||
      typeof record.quarantine?.session !== 'string' ||
      typeof record.quarantine?.workspace !== 'string' ||
      record.quarantine.session !== path.join(config.stateDir, 'recovery-quarantine', id, `${record.recovery_id}-session`) ||
      record.quarantine.workspace !== path.join(config.stateDir, 'recovery-quarantine', id, `${record.recovery_id}-workspace`))
    return {
      ...base, state: 'uncertain', condition: 'lock_pair_incomplete',
      message: `Workspace ${binding.cwd} and session ${id} have only part of the exact lock pair and no resumable planned recovery record; admission stays blocked.`,
    };
  const sessionTargetPresent = await directoryPresent(record.quarantine.session);
  const workspaceTargetPresent = await directoryPresent(record.quarantine.workspace);
  if (!sessionTargetPresent || workspaceTargetPresent || sessionPresent)
    return {
      ...base, state: 'uncertain', condition: 'recovery_partial_changed',
      recovery_id: record.recovery_id, recovery_status: record.status,
      message: `Recovery for workspace ${binding.cwd} and session ${id} is partial or its exact quarantine targets changed; admission stays blocked.`,
    };
  const owner = await readJSON(path.join(record.quarantine.session, 'owner.json'), { privateFile: true });
  if (owner.nonce !== record.owner_nonce || digest(owner) !== record.pair_fingerprint)
    fail('RECOVERY_RECORD_INVALID', 'The quarantined session owner does not match its recovery record.');
  const workspaceLock = path.join(config.stateDir, 'workspace-locks', workspaceKey);
  const workspaceOwner = await readJSON(path.join(workspaceLock, 'owner.json'), { privateFile: true });
  if (workspaceOwner.nonce !== owner.nonce || digest(workspaceOwner) !== digest(owner))
    fail('LOCK_PAIR_MISMATCH', 'The remaining workspace lock does not match the quarantined session lock.');
  const confirmation = digest({
    contract: contractFingerprint(), binding: digest(binding), workspace_key: workspaceKey,
    recovery_id: record.recovery_id, pair: digest(owner), record: digest(record),
  });
  return {
    ...base, state: 'uncertain', condition: 'recovery_partial_resumable',
    owner_nonce: owner.nonce, request_id: owner.request_id ?? null,
    recovery_id: record.recovery_id, recovery_status: record.status, confirmation,
    attestation_allowed: true,
    evidence: {
      original_confirmation: record.inspection_confirmation,
      record_fingerprint: digest(record),
      quarantine: record.quarantine, process_inspection: 'not_needed_for_exact_partial_resume',
      limitation: 'Only the exact second rename of a recorded partial recovery can be completed.',
    },
    message: `Session ${id} in workspace ${binding.cwd} has an exact resumable partial recovery; the workspace lock can be moved only if its owner still matches.`,
  };
}
function concreteLive(owner, parsed, snapshot) {
  const evidence = [];
  for (const identity of [owner.process, ...parsed.roots, ...parsed.observed]) {
    const current = snapshot.rows.find(row => row.pid === identity.pid);
    if (current && (identity.start.startsWith('unverified:') || identityKey(current) === identityKey(identity)) &&
        !evidence.some(item => identityKey(item) === identityKey(current)))
      evidence.push({
        kind: identity === owner.process ? 'owner'
          : parsed.roots.some(root => identityKey(root) === identityKey(current)) ? 'adapter_root' : 'observed_child',
        pid: current.pid, start: current.start, process_group: current.process_group,
      });
  }
  return evidence;
}
async function legacyLive(config, binding, owner, snapshot) {
  const evidence = [];
  const check = (pid, kind) => {
    const current = snapshot.rows.find(row => row.pid === pid);
    if (current) evidence.push({ kind, pid, start: current.start, identity: 'historical_start_unrecorded' });
  };
  check(owner.pid, 'legacy_owner_pid_present');
  // Read only the exact pinned FileSessionStore record, without loading acpx
  // (whose load() creates directories) or trusting a historical PID as absence.
  const handle = binding.handle;
  if (handle?.acpxRecordId) {
    if (handle.backend !== 'acpx' || typeof handle.acpxRecordId !== 'string' || handle.acpxRecordId.length > 256)
      fail('LOCK_EVIDENCE_INCOMPLETE', 'The legacy binding has an invalid adapter record identity.');
    const recordRoot = path.join(config.stateDir, 'acpx', binding.id);
    await privateDir(recordRoot, { create: false });
    const sessionDir = path.join(recordRoot, 'sessions');
    const directory = await fs.lstat(sessionDir);
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid()))
      fail('LOCK_EVIDENCE_INCOMPLETE', 'The legacy adapter store directory is unsafe.');
    const file = path.join(sessionDir, `${encodeURIComponent(handle.acpxRecordId)}.json`);
    const st = await fs.lstat(file);
    if (process.getuid && st.uid !== process.getuid())
      fail('FOREIGN_OWNER', 'The legacy adapter record belongs to another user.');
    // Pinned acpx writes 0644 records below our private 0700 record root. Its
    // store is adapter-owned; require that enclosing privacy boundary and the
    // regular-file identity checks, without rewriting historical file modes.
    const record = await readJSON(file, { maxBytes: 32 * 1024 * 1024 });
    if (record.schema !== 'acpx.session.v1' || record.acpx_record_id !== handle.acpxRecordId ||
        record.acp_session_id !== handle.backendSessionId || record.cwd !== binding.cwd)
      fail('LOCK_EVIDENCE_INCOMPLETE', 'The legacy adapter record does not match its binding.');
    if (Number.isSafeInteger(record.pid) && record.pid > 0) check(record.pid, 'legacy_adapter_pid_present');
  }
  return evidence;
}
async function inspectPair({ config, id, binding, workspaceKey, processEvidence }) {
  const p = bindingPaths(config, id);
  const workspaceLock = path.join(config.stateDir, 'workspace-locks', workspaceKey);
  const [sessionPresent, workspacePresent] = await Promise.all([
    directoryPresent(p.lock), directoryPresent(workspaceLock),
  ]);
  if (!sessionPresent && !workspacePresent)
    return { state: 'idle', session_id: id, cwd: binding.cwd };
  const base = {
    schema: 'cwr.acp.recovery-inspection/1', session_id: id, cwd: binding.cwd,
    workspace_key: workspaceKey, session_lock_present: sessionPresent,
    workspace_lock_present: workspacePresent, automatic_recovery: false,
    attestation_allowed: false,
  };
  if (!sessionPresent || !workspacePresent)
    return inspectPartialRecovery({
      config, id, binding, workspaceKey, sessionPresent, workspacePresent,
    });
  const owner = await readExactPair(p, workspaceLock, {
    session: id, cwd: binding.cwd, workspaceKey,
  });
  const snapshot = await evidenceSnapshot(processEvidence);
  if (owner.schema !== OWNER_SCHEMA) {
    const live = snapshot.unavailable ? [] : await legacyLive(config, binding, owner, snapshot);
    return {
      ...base, state: 'uncertain', condition: snapshot.unavailable ? 'process_inspection_unavailable'
        : live.length ? 'legacy_process_present' : 'legacy_evidence', owner_nonce: owner.nonce,
      confirmation: inspectionSignature(owner, workspaceKey, binding, null),
      attestation_allowed: !snapshot.unavailable && live.length === 0,
      evidence: {
        legacy: true, process_inspection: snapshot.unavailable ? 'unavailable' : 'available',
        observed_live_processes: live,
        limitation: 'Historical host/boot and process start identities were not recorded; a present recorded PID remains unresolved.',
      },
      message: `Session ${id} in workspace ${binding.cwd} has legacy evidence. Reconcile the exact old writer and artifacts before attestation; present processes or unavailable current inspection block recovery.`,
    };
  }
  let journal = null;
  try {
    journal = await readJSON(journalPath(config, id, owner.journal), {
      privateFile: true, maxBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parsed = journal ? assertJournal(journal, owner) : { complete: false, roots: [], observed: [] };
  const journalDigest = journal ? digest(journal) : null;
  const confirmation = inspectionSignature(owner, workspaceKey, binding, journalDigest);
  const detail = { owner_nonce: owner.nonce, request_id: owner.request_id, confirmation };
  if (snapshot.unavailable)
    return {
      ...base, ...detail, state: 'uncertain', condition: 'process_inspection_unavailable',
      evidence: { lifecycle_fingerprint: journalDigest, process_inspection: 'unavailable' },
      message: `Current process inspection for session ${id} in workspace ${binding.cwd} is unavailable; retry inspection after resolving that boundary.`,
    };
  const currentHost = typeof processEvidence.host === 'function'
    ? await processEvidence.host().catch(() => null) : null;
  const sameHost = owner.host && currentHost && owner.host.digest === currentHost;
  const priorBoot = sameHost && !owner.boot.startsWith('unavailable:') && snapshot.boot !== owner.boot;
  if (priorBoot)
    return {
      ...base, ...detail, state: 'recoverable', condition: 'prior_verified_boot', automatic_recovery: true,
      evidence: {
        lifecycle_fingerprint: journalDigest, original_boot: owner.boot,
        current_boot: snapshot.boot, host_identity_matched: true,
        scope: 'same verified host, different recorded boot',
      },
      message: `Session ${id} in workspace ${binding.cwd} belongs to a prior verified boot on this host; exact lock-pair recovery is available.`,
    };
  const live = snapshot.boot === owner.boot || owner.boot.startsWith('unavailable:')
    ? concreteLive(owner, parsed, snapshot) : [];
  if (live.length)
    return {
      ...base, ...detail, state: 'uncertain', condition: live.some(item => item.kind === 'owner') ? 'owner_live' : 'adapter_live',
      evidence: { lifecycle_fingerprint: journalDigest, process_inspection: 'available', observed_live_processes: live },
      message: `Session ${id} in workspace ${binding.cwd} has a live or unresolved owned process; stopped attestation cannot override it.`,
    };
  const hostChanged = owner.host && currentHost && owner.host.digest !== currentHost;
  // An admission without its spawn outcome is pending, not prelaunch proof.
  // Only complete failed admissions plus the verified owner's death can qualify.
  const ownerVerifiedStopped = snapshot.boot === owner.boot && processIdentity(owner.process) &&
    !snapshot.rows.some(row => row.pid === owner.pid && identityKey(row) === identityKey(owner.process));
  const prelaunch = sameHost && ownerVerifiedStopped && parsed.complete &&
    parsed.roots.length === 0 && journal?.records.length > 0 &&
    journal.records.every(record => ['admitted', 'spawn_failed'].includes(record.kind));
  if (prelaunch)
    return {
      ...base, ...detail, state: 'recoverable', condition: 'prelaunch_interruption', automatic_recovery: true,
      evidence: {
        lifecycle_fingerprint: journalDigest, records: journal.records.map(record => record.kind),
        scope: 'all admitted launches failed before spawn and the verified owner stopped',
      },
      message: `Session ${id} in workspace ${binding.cwd} has complete failed-spawn evidence and a stopped owner; exact lock-pair recovery is available.`,
    };
  return {
    ...base, ...detail, state: 'uncertain', condition: hostChanged ? 'host_identity_changed'
      : !journal ? 'lifecycle_missing' : !parsed.complete ? 'lifecycle_incomplete' : 'same_boot_scope_uncertain',
    attestation_allowed: !hostChanged,
    evidence: {
      lifecycle_fingerprint: journalDigest, process_inspection: 'available',
      original_boot: owner.boot, current_boot: snapshot.boot,
      host_identity: sameHost ? 'matched' : 'unavailable_or_changed', positive_liveness: false,
      limitation: 'An absent owner/group/census cannot prove ordinary Codex PTY tool processes stopped on the same boot.',
    },
    message: `Session ${id} in workspace ${binding.cwd} has unproven execution scope. The coordinator must reconcile the exact old writer and artifacts before admission; a changed host identity remains blocked.`,
  };
}

async function writeRecoveryRecord(config, value) {
  const file = path.join(config.stateDir, 'recovery-records', value.session_id, `${value.recovery_id}.json`);
  await atomicJSON(file, value);
  return file;
}
async function resumePartialRecovery({ config, binding, workspaceKey, inspection }) {
  binding = await currentBinding(config, binding);
  const sessionLock = inspection.evidence.quarantine.session;
  const workspaceTarget = inspection.evidence.quarantine.workspace;
  const owner = await readJSON(path.join(sessionLock, 'owner.json'), { privateFile: true });
  const workspaceLock = path.join(config.stateDir, 'workspace-locks', workspaceKey);
  const workspaceOwner = await readJSON(path.join(workspaceLock, 'owner.json'), { privateFile: true });
  const recordPath = path.join(config.stateDir, 'recovery-records', binding.id,
    `${inspection.recovery_id}.json`);
  const record = await readJSON(recordPath, { privateFile: true, maxBytes: 128 * 1024 });
  const expected = digest({
    contract: contractFingerprint(), binding: digest(binding), workspace_key: workspaceKey,
    recovery_id: inspection.recovery_id, pair: digest(owner), record: digest(record),
  });
  if (expected !== inspection.confirmation || workspaceOwner.nonce !== owner.nonce ||
      digest(workspaceOwner) !== digest(owner))
    fail('RECOVERY_CONFIRMATION_MISMATCH',
      'The exact recovery owner, workspace pair or binding changed; inspect again.');
  await fs.rename(workspaceLock, workspaceTarget);
  record.status = 'quarantined';
  record.completed_at = new Date().toISOString();
  delete record.partial;
  delete record.error_code;
  await atomicJSON(recordPath, record);
  await atomicJSON(path.join(sessionLock, 'recovery.json'), record);
  return { ...record, record_path: recordPath, resumed: true };
}
async function quarantinePair({ config, id, binding, workspaceKey, inspection, mode }) {
  binding = await currentBinding(config, binding);
  const p = bindingPaths(config, id);
  const workspaceLock = path.join(config.stateDir, 'workspace-locks', workspaceKey);
  const owner = await readExactPair(p, workspaceLock, {
    session: id, cwd: binding.cwd, workspaceKey,
  });
  let journalDigest = null;
  if (owner.schema === OWNER_SCHEMA) {
    let journal;
    try { journal = await readJSON(journalPath(config, id, owner.journal), { privateFile: true, maxBytes: 4 * 1024 * 1024 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal) { assertJournal(journal, owner); journalDigest = digest(journal); }
  }
  if (owner.nonce !== inspection.owner_nonce ||
      inspectionSignature(owner, workspaceKey, binding, journalDigest) !== inspection.confirmation)
    fail('RECOVERY_CONFIRMATION_MISMATCH', 'The exact lock owner, binding or lifecycle changed before quarantine; inspect again.');
  const recoveryId = randomUUID();
  const root = path.join(config.stateDir, 'recovery-quarantine', id);
  await privateDir(root);
  const sessionTarget = path.join(root, `${recoveryId}-session`);
  const workspaceTarget = path.join(root, `${recoveryId}-workspace`);
  const record = {
    schema: RECOVERY_SCHEMA, recovery_id: recoveryId, session_id: id, cwd: binding.cwd,
    workspace_key: workspaceKey, owner_nonce: owner.nonce, request_id: owner.request_id ?? null,
    created_at: new Date().toISOString(), status: 'planned', mode,
    binding_fingerprint: digest(binding), pair_fingerprint: digest(owner),
    inspection_confirmation: inspection.confirmation,
    quarantine: { session: sessionTarget, workspace: workspaceTarget },
    inspection_condition: inspection.condition, prior_task_outcome: 'unknown',
    order_replayed: false,
    execution_stop: mode === 'automatic'
      ? inspection.condition === 'prior_verified_boot'
        ? 'verified_prior_boot'
        : 'verified_prelaunch'
      : 'operator_reconciled',
    evidence: inspection.evidence ?? null,
    guarantee: inspection.evidence?.scope ??
      'Coordinator attestation covers the declared old writer only; unknown PTY/escaped processes and the old task outcome remain unproven.',
  };
  const recordPath = await writeRecoveryRecord(config, record);
  let sessionMoved = false;
  try {
    await fs.rename(p.lock, sessionTarget);
    sessionMoved = true;
    // Session first, workspace last: a failed second rename cannot allow a new
    // owner in this workspace and never rolls the old session lock back.
    await fs.rename(workspaceLock, workspaceTarget);
  } catch (error) {
    record.status = 'partial';
    record.partial = { session_quarantined: sessionMoved, workspace_quarantined: false };
    record.error_code = error.code === 'ENOENT' ? 'LOCK_TREE_CHANGED' : 'QUARANTINE_FAILED';
    await atomicJSON(recordPath, record);
    fail(record.error_code,
      `Recovery for workspace ${binding.cwd} and session ${id} did not quarantine the complete pair; any moved lock remains quarantined and no old lock is rolled back.`);
  }
  record.status = 'quarantined';
  record.quarantine = { session: sessionTarget, workspace: workspaceTarget };
  record.completed_at = new Date().toISOString();
  await atomicJSON(recordPath, record);
  await atomicJSON(path.join(sessionTarget, 'recovery.json'), record);
  return { ...record, record_path: recordPath };
}

function claimIdentity(snapshot) {
  const current = snapshot.rows?.find(row => row.pid === process.pid);
  return current ? clone(current) : null;
}
function validClaim(claim) {
  return claim?.schema === 'cwr.acp.recovery-claim/1' &&
    SAFE_UUID.test(claim.fence_id ?? '') &&
    Number.isSafeInteger(claim.ticket) && claim.ticket >= 0 &&
    typeof claim.choosing === 'boolean' && iso(claim.created_at) &&
    typeof claim.boot === 'string' && claim.boot &&
    processIdentity(claim.owner?.identity);
}
function claimLiveness(claim, snapshot) {
  if (!validClaim(claim) || snapshot.unavailable) return { dead: false, uncertain: true };
  if (claim.boot !== snapshot.boot) return { dead: true, uncertain: false };
  const current = snapshot.rows.find(row => row.pid === claim.owner.identity.pid);
  return {
    dead: !current || identityKey(current) !== identityKey(claim.owner.identity),
    uncertain: false,
  };
}
async function readClaims(dir) {
  const claims = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      claims.push(await readJSON(path.join(dir, name), {
        privateFile: true, maxBytes: 16 * 1024,
      }));
    } catch (error) {
      if (error.code !== 'ENOENT')
        fail('RECOVERY_IN_PROGRESS', 'Recovery contender evidence is malformed; admission stays blocked.');
    }
  }
  return claims;
}

// Unique immutable contender names implement a bounded Lamport bakery. A
// caller only writes/removes its own claim. Dead claims are ignored by exact
// boot/PID/start identity; live or uncertain contenders block. No shared fence
// path is renamed, unlinked or reused.
async function withRecoveryClaim({ config, processEvidence }, fn) {
  const dir = path.join(config.stateDir, 'recovery-claims');
  await privateDir(dir);
  const snapshot = await evidenceSnapshot(processEvidence);
  const identity = claimIdentity(snapshot);
  if (!identity)
    fail('RECOVERY_IN_PROGRESS', 'Could not establish the recovery contender host identity.');
  const fenceId = randomUUID();
  const claimFile = path.join(dir, `${fenceId}.json`);
  const claim = {
    schema: 'cwr.acp.recovery-claim/1', fence_id: fenceId, ticket: 0,
    choosing: true, created_at: new Date().toISOString(), boot: snapshot.boot,
    owner: { identity },
  };
  await atomicJSON(claimFile, claim);
  const deadline = performance.now() + CLAIM_WAIT_MS;
  try {
    let ticket = 0;
    for (const candidate of await readClaims(dir)) {
      if (validClaim(candidate)) ticket = Math.max(ticket, candidate.ticket);
    }
    if (!Number.isSafeInteger(ticket + 1))
      fail('RECOVERY_IN_PROGRESS', 'Recovery contender ticket space is exhausted.');
    claim.ticket = ticket + 1;
    claim.choosing = false;
    await atomicJSON(claimFile, claim);
    for (;;) {
      const current = await evidenceSnapshot(processEvidence);
      if (current.unavailable)
        fail('RECOVERY_IN_PROGRESS', 'Recovery contender liveness is unavailable.');
      const before = await readClaims(dir);
      const afterSnapshot = await evidenceSnapshot(processEvidence);
      if (afterSnapshot.unavailable)
        fail('RECOVERY_IN_PROGRESS', 'Recovery contender liveness is unavailable.');
      const blocked = before.some(candidate => {
        if (candidate.fence_id === fenceId ||
            claimLiveness(candidate, afterSnapshot).dead) return false;
        if (!validClaim(candidate) || candidate.choosing) return true;
        return candidate.ticket < claim.ticket ||
          (candidate.ticket === claim.ticket && candidate.fence_id < claim.fence_id);
      });
      if (!blocked) return await fn();
      if (performance.now() >= deadline)
        fail('RECOVERY_IN_PROGRESS',
          'Another live or uncertain recovery contender holds the admission boundary.');
      await sleep(25);
    }
  } finally {
    // Unique claim names are never reused. A crashed claim remains historical
    // evidence and is ignored only after exact identity death.
    await fs.unlink(claimFile).catch(() => {});
  }
}

export async function inspectLockRecovery({ config, binding, processEvidence = defaultProcessEvidence }) {
  processEvidence = usableProcessEvidence(processEvidence);
  binding = await currentBinding(config, binding);
  return inspectPair({
    config, id: binding.id, binding,
    workspaceKey: digest(binding.cwd), processEvidence,
  });
}

export async function recoverExactLockPair({
  config, binding, processEvidence = defaultProcessEvidence,
  attestStopped = false, confirm = null,
}) {
  processEvidence = usableProcessEvidence(processEvidence);
  const workspaceKey = digest(binding.cwd);
  return withRecoveryClaim({ config, processEvidence }, async () => {
    binding = await currentBinding(config, binding);
    const inspection = await inspectPair({
      config, id: binding.id, binding, workspaceKey, processEvidence,
    });
    if (inspection.state === 'idle')
      return { schema: RECOVERY_SCHEMA, session_id: binding.id, cwd: binding.cwd, status: 'idle' };
    if (inspection.condition === 'recovery_partial_resumable') {
      if (!attestStopped || confirm !== inspection.confirmation)
        fail('RECOVERY_REQUIRED', inspection.message);
      return resumePartialRecovery({ config, binding, workspaceKey, inspection });
    }
    if (inspection.state === 'recoverable')
      return quarantinePair({
        config, id: binding.id, binding, workspaceKey, inspection, mode: 'automatic',
      });
    if (inspection.evidence?.observed_live_processes?.length || inspection.attestation_allowed !== true)
      fail('RECOVERY_BLOCKED',
        'Present processes, unavailable current inspection or unresolved lock ownership cannot be overridden by stopped attestation.');
    if (!attestStopped || !SAFE_DIGEST.test(confirm ?? ''))
      fail('RECOVERY_REQUIRED', inspection.message);
    if (confirm !== inspection.confirmation)
      fail('RECOVERY_CONFIRMATION_MISMATCH',
        `Confirmation does not match the exact workspace ${binding.cwd}, session ${binding.id} and current lock/evidence identity.`);
    return quarantinePair({
      config, id: binding.id, binding, workspaceKey, inspection, mode: 'attested',
    });
  });
}

export async function acquireOperationLocks({
  config, binding, owner, processEvidence = defaultProcessEvidence, progress = () => {},
}) {
  processEvidence = usableProcessEvidence(processEvidence);
  const p = bindingPaths(config, binding.id);
  const workspaceLock = path.join(config.stateDir, 'workspace-locks', owner.workspace_key);
  let recovery = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const unlockWorkspace = await lock(workspaceLock, owner);
      let unlockSession;
      try { unlockSession = await lock(p.lock, owner); }
      catch (error) { await unlockWorkspace().catch(() => {}); throw error; }
      return { unlockSession, unlockWorkspace, workspaceLock, recovered: recovery !== null, recovery };
    } catch (error) {
      if (error.code !== 'BUSY_OR_UNRECONCILED') throw error;
      if (attempt > 0) break;
      const existingOwner = await discoverWorkspaceLockOwner(config, binding.cwd);
      const existing = existingOwner?.session
        ? await loadBinding(config.stateDir, sessionId(existingOwner.session)) : binding;
      if (existing.cwd !== binding.cwd)
        fail('LOCK_PAIR_MISMATCH', 'The conflicting workspace lock identifies a different workspace.');
      const inspection = await inspectLockRecovery({ config, binding: existing, processEvidence });
      if (inspection.state === 'idle') continue;
      if (inspection.state !== 'recoverable') fail('RECOVERY_REQUIRED', inspection.message);
      recovery = await recoverExactLockPair({ config, binding: existing, processEvidence });
      progress(`[acp] recovered verified-stopped lock pair for session ${existing.id}; prior task outcome remains unknown and the order was not replayed.\n`);
    }
  }
  fail('RECOVERY_REQUIRED',
    `Workspace ${binding.cwd} and session ${binding.id} remain locked after one safe recovery attempt.`);
}

export async function discoverWorkspaceLockOwner(config, cwd) {
  const workspaceKey = digest(cwd);
  const lockDir = path.join(config.stateDir, 'workspace-locks', workspaceKey);
  if (!(await directoryPresent(lockDir))) return null;
  try {
    return await readJSON(path.join(lockDir, 'owner.json'), { privateFile: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { malformed: true, workspace_key: workspaceKey };
    throw error;
  }
}
