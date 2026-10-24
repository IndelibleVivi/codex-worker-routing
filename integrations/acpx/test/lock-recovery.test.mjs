// Recovery uses synthetic state and process identities; no provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { main } from '../src/cli.mjs';
import { atomicJSON, digest, paths, readJSON } from '../src/state.mjs';
import { createAdmissionOwner, initializeLifecycleJournal, createLifecycleJournal,
  inspectLockRecovery, recoverExactLockPair } from '../src/lock-recovery.mjs';
import { fixture, fakeAcpx } from './helpers.mjs';

async function stopped(t, { legacy = false, pending = false, failed = false } = {}) {
  const f = await fixture(); t.after(f.cleanup);
  const evidence = f.processEvidence, ownerPid = 700001, adapterPid = 700002;
  evidence.add(ownerPid, null, 'old-owner'); evidence.add(adapterPid, ownerPid, 'old-adapter');
  const owner = legacy ? { nonce: randomUUID(), pid: ownerPid, session: f.binding.id,
    startedAt: new Date().toISOString() } : await createAdmissionOwner({
    session: f.binding.id, requestId: randomUUID(), cwd: f.cwd, route: 'worker',
    permissions: 'read', workspaceKey: digest(f.cwd), ownerPid, processEvidence: evidence,
  });
  const p = paths(f.config.stateDir, f.binding.id);
  const workspaceLock = path.join(f.config.stateDir, 'workspace-locks', digest(f.cwd));
  await atomicJSON(path.join(p.lock, 'owner.json'), owner);
  await atomicJSON(path.join(workspaceLock, 'owner.json'), owner);
  let journal;
  if (!legacy) {
    await initializeLifecycleJournal({ config: f.config, owner });
    journal = createLifecycleJournal({ config: f.config, owner });
    await journal.admitted('launch');
    if (failed) await journal.spawnFailed('launch');
    else if (!pending) await journal.spawned({ launchId: 'launch', process: await evidence.identity(adapterPid) });
  }
  evidence.remove(ownerPid); evidence.remove(adapterPid);
  const args = { config: f.config, binding: f.binding, processEvidence: evidence };
  return { ...f, evidence, ownerPid, adapterPid, owner, p, workspaceLock, journal, args };
}
const inspect = f => inspectLockRecovery(f.args);
const attest = (f, view) => recoverExactLockPair({ ...f.args, attestStopped: true, confirm: view.confirmation });
async function noRecovery(f) {
  assert.ok(await fs.stat(f.p.lock)); assert.ok(await fs.stat(f.workspaceLock));
  assert.equal(await fs.readdir(path.join(f.config.stateDir, 'recovery-records')).catch(() => []).then(a => a.length), 0);
}

for (const group of [null, 700001]) test(`live owner blocks pending admission with group ${group}`, async t => {
  const f = await stopped(t, { pending: true });
  f.evidence.add(f.ownerPid, null, 'old-owner', group);
  const v = await inspect(f);
  assert.equal(v.condition, 'owner_live'); assert.equal(v.automatic_recovery, false);
  await assert.rejects(attest(f, v), { code: 'RECOVERY_BLOCKED' }); await noRecovery(f);
});
test('pending spawn outcome with a dead owner is never prelaunch proof', async t => {
  const f = await stopped(t, { pending: true });
  const v = await inspect(f);
  assert.equal(v.condition, 'lifecycle_incomplete'); assert.equal(v.automatic_recovery, false);
});
test('unavailable fresh observation cannot attest a previously inspectable owner', async t => {
  const f = await stopped(t); const v = await inspect(f);
  const snapshot = f.evidence.snapshot;
  let reads = 0;
  // Claim creation sees the current claimant. The actual recovery inspection
  // loses process access afterwards; it must not inherit the earlier token.
  f.evidence.snapshot = async () => {
    if (++reads >= 4) throw Object.assign(new Error('synthetic denied inspection'), { code: 'EPERM' });
    return snapshot();
  };
  await assert.rejects(attest(f, v), { code: 'RECOVERY_BLOCKED' }); await noRecovery(f);
});
test('legacy missing schema is distinct from a live owner or adapter PID', async t => {
  const f = await stopped(t, { legacy: true });
  f.evidence.add(f.ownerPid);
  let v = await inspect(f);
  assert.equal(v.condition, 'legacy_process_present');
  await assert.rejects(attest(f, v), { code: 'RECOVERY_BLOCKED' });
  f.evidence.remove(f.ownerPid);
  f.binding.handle = { backend: 'acpx', acpxRecordId: 'synthetic', backendSessionId: 'conversation' };
  await atomicJSON(f.p.binding, f.binding);
  await atomicJSON(path.join(f.config.stateDir, 'acpx', f.binding.id, 'sessions', 'synthetic.json'), {
    acpxRecordId: 'synthetic', acpSessionId: 'conversation', cwd: f.cwd, pid: f.adapterPid,
  });
  f.evidence.add(f.adapterPid);
  v = await inspect(f);
  assert.ok(v.evidence.observed_live_processes.some(p => p.kind === 'legacy_adapter_pid_present'));
  await assert.rejects(attest(f, v), { code: 'RECOVERY_BLOCKED' }); await noRecovery(f);
});
test('changed durable conversation or execution identity rejects the old inspection', async t => {
  const f = await stopped(t); const v = await inspect(f);
  await atomicJSON(f.p.binding, { ...f.binding, handle: { backendSessionId: 'changed' } });
  await assert.rejects(attest(f, v), { code: 'RECOVERY_BINDING_CHANGED' }); await noRecovery(f);
});
test('a newly matched pair inserted before quarantine cannot use the old inspection', async t => {
  const f = await stopped(t); const v = await inspect(f);
  const lstat = fs.lstat; let reads = 0; const changed = { ...f.owner, nonce: randomUUID() };
  fs.lstat = async (file, ...args) => {
    if (file === path.join(f.p.lock, 'owner.json') && ++reads === 2) {
      await atomicJSON(path.join(f.p.lock, 'owner.json'), changed);
      await atomicJSON(path.join(f.workspaceLock, 'owner.json'), changed);
    }
    return lstat(file, ...args);
  };
  try {
    await assert.rejects(attest(f, v), error => ['LOCK_EVIDENCE_INCOMPLETE', 'RECOVERY_CONFIRMATION_MISMATCH'].includes(error.code));
  } finally { fs.lstat = lstat; }
  assert.equal((await readJSON(path.join(f.p.lock, 'owner.json'))).nonce, changed.nonce);
  await noRecovery(f);
});
for (const denial of ['permissions', 'workspace', 'admission']) test(`unauthorized ${denial} run preserves recoverable locks`, async t => {
  const f = await stopped(t, { failed: true });
  assert.equal((await inspect(f)).state, 'recoverable');
  if (denial === 'permissions') f.raw.routes.worker.maxPermissions = 'read';
  if (denial === 'workspace') f.raw.routes.worker.workspaces = [f.root];
  // A parent is allowed by the ordinary route policy, so use a distinct path.
  if (denial === 'workspace') {
    const other = path.join(f.root, 'other'); await fs.mkdir(other); f.raw.routes.worker.workspaces = [other];
  }
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  const api = fakeAcpx();
  await assert.rejects(main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd,
    '--file', f.orderFile, '--permissions', 'full', ...(denial === 'admission' ? ['--expected-admission', 'changed'] : [])],
  { replaceEnvironment() {}, loadAcpx: async () => api, output() {}, progress() {}, processEvidence: f.evidence }),
  { code: denial === 'permissions' ? 'PERMISSION_DENIED' : denial === 'workspace' ? 'WORKSPACE_NOT_ALLOWED' : 'ADMISSION_CHANGED' });
  assert.equal(api.calls.length, 0); await noRecovery(f);
});
test('verified prior boot recovers automatically only on the same host', async t => {
  const f = await stopped(t); f.evidence.state.boot = 'synthetic-boot/2';
  let v = await inspect(f);
  assert.equal(v.condition, 'prior_verified_boot'); assert.equal(v.automatic_recovery, true);
  f.evidence.state.host = 'e'.repeat(64);
  v = await inspect(f); assert.equal(v.automatic_recovery, false); assert.equal(v.attestation_allowed, false);
  f.evidence.state.host = 'f'.repeat(64);
  const r = await recoverExactLockPair(f.args);
  assert.equal(r.execution_stop, 'verified_prior_boot'); assert.equal(r.prior_task_outcome, 'unknown');
});
test('two healthy recovery contenders both settle and quarantine the old pair once', async t => {
  const f = await stopped(t, { failed: true }); const started = performance.now();
  const results = await Promise.all([recoverExactLockPair(f.args), recoverExactLockPair(f.args)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['idle', 'quarantined']);
  assert.ok(performance.now() - started < 4500, 'healthy contenders must make progress before claim timeout');
  const records = await fs.readdir(path.join(f.config.stateDir, 'recovery-records', f.binding.id));
  assert.equal(records.length, 1);
});
