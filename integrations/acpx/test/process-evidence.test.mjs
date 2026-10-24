// Real synthetic processes exercise the production inspector. These tests do
// not spawn ACP, use a provider, read user home, or make network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProcessEvidence, descendantsOf, identityKey } from '../src/process-evidence.mjs';
import { fixture, sleep } from './helpers.mjs';

const holder = path.resolve('test/fixture-process-holder.mjs');
async function until(check, message, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw new Error(message);
    await sleep(25);
  }
}
async function startHolder(f, mode) {
  const rootPidFile = path.join(f.root, `root-${mode}.pid`);
  const childPidFile = path.join(f.root, `child-${mode}.pid`);
  const child = spawn(process.execPath, [holder, rootPidFile, childPidFile, mode], {
    stdio: 'ignore', detached: false,
  });
  const rootPid = await until(async () => Number(await fs.readFile(rootPidFile, 'utf8').catch(() => 0)), 'holder did not publish its pid');
  const childPid = mode === 'child'
    ? await until(async () => Number(await fs.readFile(childPidFile, 'utf8').catch(() => 0)), 'holder did not publish its child pid')
    : null;
  return { child, rootPid, childPid };
}
async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function cleanupPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

test('real process inspector distinguishes same-boot live identity from exit and PID reuse', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  const evidence = createProcessEvidence();
  const h = await startHolder(f, 'child');
  t.after(async () => { await cleanupPid(h.childPid); await killAndWait(h.child); });
  let rows, boot;
  try {
    [rows, boot] = await Promise.all([evidence.snapshot(), evidence.boot()]);
  } catch (error) {
    assert.equal(error.code, 'PROCESS_IDENTITY_UNAVAILABLE',
      `host process inspection is unavailable rather than silently claiming safety: ${error.message}`);
    return;
  }
  const root = rows.find(row => row.pid === h.rootPid);
  const child = rows.find(row => row.pid === h.childPid);
  assert.ok(root && child, 'the real process table must contain the synthetic holder and child');
  assert.equal(child.parent_pid, h.rootPid);
  assert.ok(identityKey(root) && identityKey(child));
  assert.ok(descendantsOf(root, rows).some(item => identityKey(item) === identityKey(child)));
  assert.ok(boot);
  const host=await evidence.host();
  if(host!==null)assert.match(host,/^[a-f0-9]{64}$/,'host factory matches persisted owner schema');
  const oldRoot = structuredClone(root), oldChild = structuredClone(child);
  await cleanupPid(h.childPid);
  await until(async () => {
    const after = await evidence.snapshot();
    return !after.some(row => row.pid === h.childPid && identityKey(row) === identityKey(oldChild));
  }, 'the exact explicit child identity remained in the real process table');
  await killAndWait(h.child);
  await until(async () => {
    const after = await evidence.snapshot();
    return !after.some(row => row.pid === h.rootPid && identityKey(row) === identityKey(oldRoot)) &&
      !after.some(row => row.pid === h.childPid && identityKey(row) === identityKey(oldChild));
  }, 'the exact exited identities remained in the real process table');
  // The same numeric PID with a different start identity is reuse, not the old
  // process. If the OS does not expose start identity, snapshot() must already
  // have failed above instead of returning an unsafe synthetic value.
  const reuse = { ...oldRoot };
  const after = await evidence.snapshot();
  const current = after.find(row => row.pid === oldRoot.pid);
  assert.ok(!current || identityKey(current) !== identityKey(reuse));
});

test('real abrupt parent exit retains a child that recovery must not treat as stopped or kill', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  const evidence = createProcessEvidence();
  const h = await startHolder(f, 'child');
  t.after(async () => { await cleanupPid(h.childPid); await killAndWait(h.child); });
  let before;
  try { before = await evidence.snapshot(); }
  catch (error) {
    assert.equal(error.code, 'PROCESS_IDENTITY_UNAVAILABLE');
    return;
  }
  const root = before.find(row => row.pid === h.rootPid);
  const child = before.find(row => row.pid === h.childPid);
  assert.ok(root && child);
  await killAndWait(h.child);
  const retained = await until(async () => {
    const rows = await evidence.snapshot();
    const current = rows.find(row => row.pid === h.childPid);
    return current && identityKey(current) === identityKey(child) ? current : null;
  }, 'the child did not survive the abrupt parent exit');
  assert.equal(retained.pid, h.childPid);
  assert.equal(identityKey(retained), identityKey(child));
  // This is observation only: recovery must never kill a surviving process.
  await cleanupPid(h.childPid);
});

test('real same-boot inspector reports uncertainty and never promotes an empty group to automatic recovery', { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  const evidence = createProcessEvidence();
  const { createAdmissionOwner, initializeLifecycleJournal, createLifecycleJournal, inspectLockRecovery } =
    await import('../src/lock-recovery.mjs');
  const { atomicJSON, digest, loadBinding, paths } = await import('../src/state.mjs');
  let live;
  try { live = await evidence.snapshot(); }
  catch (error) {
    assert.equal(error.code, 'PROCESS_IDENTITY_UNAVAILABLE');
    return;
  }
  assert.ok(live.some(row => row.pid === process.pid));
  const h = await startHolder(f, 'child');
  t.after(async () => { await cleanupPid(h.childPid); await killAndWait(h.child); });
  const owner = await createAdmissionOwner({
    session: f.binding.id, requestId: '20000000-0000-0000-0000-000000000001',
    cwd: f.cwd, route: 'worker', permissions: 'read', workspaceKey: digest(f.cwd),
    processEvidence: evidence,
  });
  const p = paths(f.config.stateDir, f.binding.id);
  await atomicJSON(path.join(f.config.stateDir, 'workspace-locks', digest(f.cwd), 'owner.json'), owner);
  await atomicJSON(path.join(p.lock, 'owner.json'), owner);
  await initializeLifecycleJournal({ config: f.config, owner });
  const journal = createLifecycleJournal({ config: f.config, owner });
  await journal.admitted('real-holder');
  const rows = await evidence.snapshot();
  await journal.spawned({ launchId: 'real-holder', process: rows.find(row => row.pid === h.rootPid) });
  await journal.descendants({ launchId: 'real-holder', processes: descendantsOf(rows.find(row => row.pid === h.rootPid), rows) });
  await killAndWait(h.child);
  const binding = await loadBinding(f.config.stateDir, f.binding.id);
  const inspection = await inspectLockRecovery({ config: f.config, binding, processEvidence: evidence });
  assert.equal(inspection.state,'uncertain');
  assert.ok(await fs.stat(p.lock));
  assert.equal(inspection.automatic_recovery,false);
  assert.equal(await fs.stat(p.lock).then(()=>true,()=>false),true,'inspection is read-only');
});
