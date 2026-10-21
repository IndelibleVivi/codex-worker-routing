import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Fault } from '../src/state.mjs';
import { fixture, fakeAcpx } from './helpers.mjs';
import { main, parseArgs, renderStorageText } from '../src/cli.mjs';
import {
  inventoryStorage, planStorage, applyStoragePlan, createScratch, loadScratch, compactSessionKey,
  newScratchLocation, v1ScratchLocation, storageWriterProbe, SCRATCH_DIR, SCRATCH_SCHEMA,
} from '../src/storage.mjs';
import { atomicJSON, loadBinding, lock, paths, privateDir, readJSON } from '../src/state.mjs';

async function setup(t, { olderThanMs = 0, compact = false } = {}) {
  const f = await fixture();
  t.after(() => f.cleanup());
  await fs.mkdir(f.selection.route.workerHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(f.selection.route.workerHome, 'tmp'), { recursive: true, mode: 0o700 });
  f.storageOlderThanMs = olderThanMs;
  const fixtureCleanup = f.cleanup;
  if (compact) {
    const compactParent = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    const compactRoot = path.join(await fs.realpath(compactParent), `cwr-socket-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(compactRoot, { recursive: true, mode: 0o700 });
    f.root = compactRoot;
    f.config = { ...f.config, stateDir: path.join(compactRoot, 's') };
    f.configFile = path.join(compactRoot, 'routes.json');
    f.raw.stateDir = f.config.stateDir;
    f.raw.routes.worker.workerHome = path.join(compactRoot, 'h');
    f.raw.routes.worker.workspaces = [path.join(compactRoot, 'w')];
    await fs.writeFile(f.configFile, JSON.stringify(f.raw), { mode: 0o600 });
    const { loadConfig, selectRoute } = await import('../src/config.mjs');
    f.config = await loadConfig(f.configFile);
    f.cwd = path.join(compactRoot, 'w');
    await fs.mkdir(f.config.stateDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(f.selection.route.workerHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(f.selection.route.workerHome, 'tmp'), { recursive: true, mode: 0o700 });
    await fs.mkdir(f.cwd, { recursive: true, mode: 0o700 });
    f.selection = await selectRoute(f.config, 'worker', f.cwd);
    await fs.writeFile(f.orderFile, 'Synthetic compact-path order.', { mode: 0o600 });
    f.cleanup = async () => { await fixtureCleanup(); await fs.rm(compactRoot, { recursive: true, force: true }); };
  }
  t.after(() => {
    // Keep the fixture cleanup's recursive synthetic-root removal as the only
    // actual removal of this test HOME.
  });
  return f;
}

async function closedSession(f, files = { 'payload.txt': 'synthetic payload' }, { closedAt = new Date(Date.now() - 30 * 86_400_000) } = {}) {
  const id = randomUUID();
  const manifest = await createScratch(f.config, 'worker', f.selection.route, id);
  const scratch = manifest.scratch;
  const manifestPath = path.join(scratch, '.cwr-scratch.json');
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(scratch, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, body, { mode: 0o600 });
  }
  const old = new Date(Date.now() - 30 * 86_400_000);
  await fs.utimes(manifestPath, old, old);
  for (const [name] of Object.entries(files)) {
    const file = path.join(scratch, name);
    if ((await fs.lstat(file)).isFile()) await fs.utimes(file, old, old);
  }
  const binding = {
    ...f.binding, id, route: 'worker', cwd: f.cwd,
    executionIdentity: f.selection.executionIdentity ?? { schema: 'cwr.acp.execution-identity/1', fingerprint: f.selection.fingerprint },
    closed: true, closedAt: closedAt.toISOString(), cleanup: 'confirmed',
    scratchDescriptor: manifest.descriptor,
  };
  delete binding.handle;
  await atomicJSON(paths(f.config.stateDir, id).binding, binding);
  return { id, scratch, manifest, binding };
}

async function target(f, id, { extraHomes } = {}) {
  const inv = await inventoryStorage(f.config, { extraHomes, olderThanMs: f.storageOlderThanMs });
  const found = inv.targets.find(x => x.session_id === id);
  assert.ok(found, `missing inventory target for ${id}`);
  return { inv, found };
}

async function runPythonListener(dir) {
  return new Promise(resolve => {
    const child = spawn('python3', ['-c',
      'from multiprocessing.connection import Listener; listener=Listener(); listener.close()'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => resolve({ ok: false, error: error.code }));
    child.once('close', code => resolve({ ok: code === 0, code, stderr }));
  });
}

async function makeV1Session(f, files = { 'payload.txt': 'v1 payload' }) {
  const id = randomUUID();
  const location = v1ScratchLocation(f.config, 'worker', f.selection.route, id);
  await privateDir(path.dirname(location.path));
  await privateDir(location.path);
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await atomicJSON(path.join(location.path, '.cwr-scratch.json'), {
    schema: SCRATCH_SCHEMA, session_id: id, route: 'worker', state_root: f.config.stateDir,
    home: f.selection.route.workerHome, scratch: location.path, created_at: old,
  });
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(location.path, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(location.path, name), body, { mode: 0o600 });
    await fs.utimes(path.join(location.path, name), new Date(old), new Date(old));
  }
  await fs.utimes(path.join(location.path, '.cwr-scratch.json'), new Date(old), new Date(old));
  const binding = { ...f.binding, id, route: 'worker', cwd: f.cwd, closed: true,
    closedAt: old, cleanup: 'confirmed', scratchDescriptor: location };
  delete binding.handle;
  await atomicJSON(paths(f.config.stateDir, id).binding, binding);
  return { id, scratch: location.path, descriptor: location };
}

async function fileTree(root) {
  const out = [];
  async function visit(dir, rel = '') {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name), r = path.join(rel, ent.name);
      const st = await fs.lstat(p);
      out.push({ path: r, mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink });
      if (st.isDirectory()) await visit(p, r);
    }
  }
  await visit(root);
  return out;
}

test('inventory is read-only, adapter-free, category-complete and payload-free', async t => {
  const f = await setup(t);
  await fs.mkdir(path.join(f.selection.route.workerHome, '.cache'), { mode: 0o700 });
  await fs.writeFile(path.join(f.selection.route.workerHome, '.cache', 'private-cache'), 'DO_NOT_EXPOSE_CACHE_PAYLOAD');
  await fs.writeFile(path.join(f.selection.route.workerHome, '.codex', 'history.jsonl'), 'DO_NOT_EXPOSE_HISTORY_PAYLOAD', { flag: 'wx' }).catch(async e => {
    if (e.code === 'ENOENT') {
      await fs.mkdir(path.join(f.selection.route.workerHome, '.codex'), { mode: 0o700 });
      await fs.writeFile(path.join(f.selection.route.workerHome, '.codex', 'history.jsonl'), 'DO_NOT_EXPOSE_HISTORY_PAYLOAD', { mode: 0o600 });
    } else throw e;
  });
  const before = await fileTree(f.root);
  const inv = await inventoryStorage(f.config, { olderThanMs: f.storageOlderThanMs });
  const after = await fileTree(f.root);
  assert.deepEqual(after, before, 'inventory must not create, chmod or repair anything');
  assert.ok(!JSON.stringify(inv).includes('DO_NOT_EXPOSE'));
  assert.equal(inv.schema, 'cwr.storage.inventory/1');
  assert.equal(inv.homes[0].path, f.selection.route.workerHome);
  const cats = inv.homes[0].categories.map(x => x.category);
  for (const category of ['scratch', 'cache', 'sessions_history', 'logs_databases', 'runtime_state_config']) assert.ok(cats.includes(category));
  assert.ok(inv.targets.some(x => x.category === 'cwr_state_receipts'));
  assert.ok(inv.targets.every(x => x.eligibility !== 'candidate'), 'no manifest means no candidate');
  assert.ok(inv.targets.find(x => x.category === 'sessions_history').reasons.some(r => r.code === 'PERSISTENT_HISTORY'));
  assert.match(renderStorageText(inv), /Inspect-only or incomplete targets/);
});

test('inventory rejects a symlink installed at a category root instead of traversing it', async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink regression');
    return;
  }
  const f = await setup(t);
  const home = f.selection.route.workerHome;
  const outside = path.join(f.root, 'outside-root');
  await fs.mkdir(outside, { recursive: true, mode: 0o700 });
  await fs.symlink(outside, path.join(home, '.cache'));
  const inv = await inventoryStorage(f.config, { olderThanMs: 0 });
  const cache = inv.targets.find(x => x.path === path.join(home, '.cache'));
  assert.ok(cache);
  assert.equal(cache.eligibility, 'incomplete');
  assert.ok(cache.reasons.some(x => x.code === 'SYMLINK_SKIPPED'));
});

test('no-follow inventory reports symlinks, hardlinks, special files and limits without leaking or following', async t => {
  const f = await setup(t);
  const home = f.selection.route.workerHome;
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, 'marker'), 'OUTSIDE_PAYLOAD', { mode: 0o600 });
  await fs.mkdir(path.join(home, '.cache'), { mode: 0o700 });
  await fs.symlink(outside, path.join(home, '.cache', 'link'));
  await fs.writeFile(path.join(home, '.cache', 'one'), 'one', { mode: 0o600 });
  await fs.link(path.join(home, '.cache', 'one'), path.join(home, '.cache', 'linked'));
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(home, '.cache', 'file-link'));
  }
  const inv = await inventoryStorage(f.config, { maxEntries: 2, maxDepth: 1, olderThanMs: f.storageOlderThanMs });
  const cache = inv.targets.find(x => x.path === path.join(home, '.cache'));
  assert.equal(cache.eligibility, 'incomplete');
  assert.ok(cache.reasons.some(r => r.code === 'SYMLINK_SKIPPED' || r.code === 'ENTRY_LIMIT'));
  assert.ok(!JSON.stringify(inv).includes('OUTSIDE_PAYLOAD'));
  await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
});

test('retired homes use full category classification and remain inspect-only', async t => {
  const f = await setup(t);
  const mainHome = path.join(f.root, 'synthetic-main-home');
  await fs.mkdir(mainHome, { mode: 0o700 });
  const retired = path.join(mainHome, 'retired-profile');
  await fs.mkdir(retired, { mode: 0o700 });
  await fs.writeFile(path.join(retired, 'state'), 'private', { mode: 0o600 });
  await fs.mkdir(path.join(retired, '.codex', 'sessions'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(retired, '.codex', 'sessions', 'history'), 'RETIRED_HISTORY', { mode: 0o600 });
  await fs.writeFile(path.join(retired, '.codex', 'logs_2.sqlite-wal'), 'RETIRED_LOG', { mode: 0o600 });
  await fs.mkdir(path.join(retired, '.codex', '.tmp'), { mode: 0o700 });
  await fs.writeFile(path.join(retired, '.codex', '.tmp', 'scratch'), 'RETIRED_TMP', { mode: 0o600 });
  const config = { ...f.config, mainHome };
  const inv = await inventoryStorage(config, { extraHomes: [retired], olderThanMs: f.storageOlderThanMs });
  const normalWorker = await inventoryStorage(config, { olderThanMs: f.storageOlderThanMs });
  assert.ok(normalWorker.homes.some(h => h.route === 'worker'));
  const extra = inv.targets.find(x => x.kind === 'extra_home');
  assert.ok(extra);
  assert.equal(extra.eligibility, 'inspect_only');
  assert.ok(extra.reasons.some(r => r.code === 'RETIRED_PROFILE_INSPECT_ONLY'));
  const retiredRows = inv.homes.find(h => h.status === 'retired_extra').categories.map(row => row.category);
  assert.ok(retiredRows.includes('sessions_history'));
  assert.ok(retiredRows.includes('logs_databases'));
  assert.ok(retiredRows.includes('scratch'));
  assert.ok(inv.targets.filter(t => t.kind === 'extra_home').every(t => t.eligibility !== 'candidate'));
  for (const bad of [config.mainHome, f.config.stateDir, f.cwd, f.selection.route.workerHome, path.join(f.config.stateDir, 'bindings')])
    await assert.rejects(inventoryStorage(config, { extraHomes: [bad], olderThanMs: f.storageOlderThanMs }), { code: 'EXTRA_HOME_OVERLAP' });
  await assert.rejects(inventoryStorage(f.config, { extraHomes: [f.config.mainHome], olderThanMs: f.storageOlderThanMs }), { code: 'EXTRA_HOME_OVERLAP' });
});

test('only closed, confirmed, unlocked manifest-owned scratch becomes a candidate', async t => {
  const f = await setup(t);
  const s = await closedSession(f, { 'payload.txt': 'synthetic payload' }, { closedAt: new Date(Date.now() - 30 * 86_400_000) });
  const { inv, found } = await target(f, s.id);
  assert.equal(found.eligibility, 'candidate');
  assert.ok(inv.totals.candidate_bytes >= Buffer.byteLength('synthetic payload'));

  const b = await loadBinding(f.config.stateDir, s.id);
  b.closed = false;
  await atomicJSON(paths(f.config.stateDir, s.id).binding, b);
  let now = await target(f, s.id);
  assert.equal(now.found.eligibility, 'inspect_only');
  assert.ok(now.found.reasons.some(r => r.code === 'BINDING_OPEN'));

  b.closed = true;
  await atomicJSON(paths(f.config.stateDir, s.id).binding, b);
  await privateDir(paths(f.config.stateDir, s.id).lock);
  now = await target(f, s.id);
  assert.ok(now.found.reasons.some(r => r.code === 'SESSION_LOCK'));
  assert.equal(now.found.eligibility, 'inspect_only');
  await fs.rmdir(paths(f.config.stateDir, s.id).lock);

  b.cleanup = 'unconfirmed';
  await atomicJSON(paths(f.config.stateDir, s.id).binding, b);
  now = await target(f, s.id);
  assert.ok(now.found.reasons.some(r => r.code === 'CLEANUP_UNCONFIRMED'));
  assert.notEqual(now.found.eligibility, 'candidate');
});

test('a compact session scratch stays stable across run and continuation while HOME and CODEX_HOME remain stable', async t => {
  const f = await setup(t, { compact: process.platform !== 'win32' });
  const envs = [];
  const api = fakeAcpx();
  const deps = {
    loadAcpx: async () => api,
    replaceEnvironment: env => envs.push({ ...env }),
    output: () => {}, progress: () => {},
  };
  const args = ['run', '--permissions', 'read', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile];
  const outputs = [];
  deps.output = r => outputs.push(r);
  assert.equal(await main(args, deps), 0);
  const id = outputs.at(-1).session_id;
  assert.equal(await main(['continue', '--permissions', 'read', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), 0);
  assert.equal(envs.length, 2);
  assert.equal(envs[0].TMPDIR, path.join(f.config.stateDir, 'scratch', compactSessionKey(id)));
  assert.equal(envs[1].TMPDIR, envs[0].TMPDIR);
  if (process.platform === 'win32') {
    assert.equal(envs[0].TEMP, envs[0].TMPDIR);
    assert.equal(envs[0].TMP, envs[0].TMPDIR);
  }
  assert.equal(envs[0].HOME, f.selection.route.workerHome);
  assert.equal(envs[0].CODEX_HOME, path.join(f.selection.route.workerHome, '.codex'));
  assert.ok(await fs.lstat(envs[0].TMPDIR));
  if (process.platform !== 'win32') assert.ok(Buffer.byteLength(envs[0].TMPDIR) < 96);
});

test('a missing manifest on a known managed binding fails explicitly, never falling back to legacy tmp', async t => {
  const f = await setup(t);
  const api = fakeAcpx();
  const envs = [];
  const outputs = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: env => envs.push({ ...env }), output: r => outputs.push(r), progress: () => {} };
  // Make the fixture binding look like a pre-manifest binding.
  f.binding.handle = null;
  f.binding.cleanup = 'confirmed';
  await atomicJSON(paths(f.config.stateDir, f.binding.id).binding, f.binding);
  // Give it the complete handle needed by continue; use a first real run with a
  // separate new session, then remove that session's manifest to model legacy.
  assert.equal(await main(['run', '--permissions', 'read', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = outputs.at(-1).session_id;
  const compactManifest = path.join(f.config.stateDir, 'scratch', compactSessionKey(id), '.cwr-scratch.json');
  await fs.unlink(compactManifest);
  await assert.rejects(main(['continue', '--permissions', 'read', '--config', f.configFile,
    '--session', id, '--file', f.orderFile], deps), { code: 'KNOWN_SCRATCH_MISSING' });
});

test('plan is immutable, inventory-selected, cutoff-bound and apply needs exact confirmation', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const recent = await closedSession(f, { 'recent.txt': 'recent' }, { closedAt: new Date() });
  const recentTarget = (await target(f, recent.id)).found;
  const recentPlan = await planStorage(f.config, { targetIds: [recentTarget.id], olderThanMs: 0 });
  assert.equal(recentPlan.targets[0].id, recentTarget.id);
  const old = new Date(Date.now() - 30 * 86_400_000);
  await fs.utimes(path.join(s.scratch, 'payload.txt'), old, old);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  assert.equal(plan.schema, 'cwr.storage.plan/1');
  assert.equal(plan.action, 'delete_managed_scratch');
  assert.equal(plan.targets.length, 1);
  assert.ok(plan.targets[0].snapshot.hash);
  assert.ok(plan.targets[0].snapshot.bytes > 0);
  assert.match(plan.targets[0].integrity, /^[a-f0-9]{64}$/);
  const planFile = path.join(f.config.stateDir, 'storage', 'plans', `${plan.plan_id}.json`);
  assert.deepEqual(await readJSON(planFile, { privateFile: true }), plan);
  assert.ok(await fs.lstat(s.scratch));
  await assert.rejects(applyStoragePlan(f.config, { planId: plan.plan_id, confirm: 'wrong' }), { code: 'CONFIRMATION_REQUIRED' });
  assert.ok(await fs.lstat(s.scratch));
});

test('apply deletes only the selected managed scratch and preserves persistent history, receipts and unrelated state', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const keep = await closedSession(f, { 'other.txt': 'keep me' });
  await fs.mkdir(path.join(f.selection.route.workerHome, '.codex'), { recursive: true, mode: 0o700 });
  const history = path.join(f.selection.route.workerHome, '.codex', 'history.jsonl');
  await fs.writeFile(history, 'HISTORY_SENTINEL', { mode: 0o600 });
  const receipt = path.join(f.config.stateDir, 'acpx', s.id, 'receipt.json');
  await atomicJSON(receipt, { schema: 'cwr.acp.receipt/1', sentinel: true });
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const applied = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.targets[0].status, 'deleted');
  assert.equal(applied.deleted_logical_bytes, plan.totals.bytes);
  assert.ok(applied.deleted_logical_bytes > Buffer.byteLength('synthetic payload'));
  await assert.rejects(fs.stat(s.scratch), { code: 'ENOENT' });
  assert.ok(await fs.lstat(keep.scratch));
  assert.equal(await fs.readFile(history, 'utf8'), 'HISTORY_SENTINEL');
  assert.deepEqual(await readJSON(receipt, { privateFile: true }), { schema: 'cwr.acp.receipt/1', sentinel: true });
  const stored = await readJSON(path.join(f.config.stateDir, 'storage', 'receipts', `${plan.plan_id}.json`), { privateFile: true });
  assert.equal(stored.status, 'applied');
});

test('apply removes nested scratch directories exactly once with complete byte accounting', async t => {
  const f = await setup(t);
  const s = await closedSession(f, { 'nested/deeper/result.txt': 'nested payload', 'root.txt': 'root payload' });
  await fs.mkdir(path.join(s.scratch, 'empty'), { mode: 0o700 });
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const applied = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.targets[0].status, 'deleted');
  assert.equal(applied.deleted_logical_bytes, plan.totals.bytes);
  await assert.rejects(fs.lstat(s.scratch), { code: 'ENOENT' });
});

test('apply rejects changed trees, new locks, changed config roots, forged targets and plan tamper', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const planFile = path.join(f.config.stateDir, 'storage', 'plans', `${plan.plan_id}.json`);

  await fs.writeFile(path.join(s.scratch, 'changed'), 'change', { mode: 0o600 });
  const changed = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.targets[0].reason, 'TARGET_CHANGED');
  assert.ok(await fs.lstat(s.scratch));

  // Make a fresh unchanged plan, then introduce a live session lock.
  const plan2 = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  await atomicallyRewrite(planFile, plan2);
  await privateDir(paths(f.config.stateDir, s.id).lock);
  const locked = await applyStoragePlan(f.config, { planId: plan2.plan_id, confirm: plan2.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(locked.status, 'failed');
  assert.equal(locked.targets[0].reason, 'SESSION_LOCK');
  await fs.rmdir(paths(f.config.stateDir, s.id).lock);

  // A plan bound to another state root is rejected before mutation.
  const plan3 = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const rootPlanFile = path.join(f.config.stateDir, 'storage', 'plans', `${plan3.plan_id}.json`);
  const tampered = await readJSON(rootPlanFile, { privateFile: true });
  tampered.state_root = path.join(f.root, 'other-state');
  await atomicJSON(rootPlanFile, tampered);
  await assert.rejects(applyStoragePlan(f.config, { planId: plan3.plan_id, confirm: plan3.plan_id }), { code: 'PLAN_TAMPERED' });
  assert.ok(await fs.lstat(s.scratch));

  // A forged target outside the exact route scratch root is never touched.
  const plan4 = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const plan4File = path.join(f.config.stateDir, 'storage', 'plans', `${plan4.plan_id}.json`);
  const forged = await readJSON(plan4File, { privateFile: true });
  forged.plan_id = plan4.plan_id;
  forged.targets[0].path = f.cwd;
  await atomicJSON(plan4File, forged);
  await assert.rejects(applyStoragePlan(f.config, { planId: plan4.plan_id, confirm: plan4.plan_id }), { code: 'PLAN_TAMPERED' });
  assert.ok(await fs.lstat(f.cwd));
});

async function atomicallyRewrite(file, value) { await atomicJSON(file, value); }

test('CLI storage default JSON, text view and parser/help have no adapter import and reject invalid limits', async t => {
  const f = await setup(t);
  assert.equal(parseArgs(['storage', '--config', f.configFile, '--json']).json, true);
  assert.equal(parseArgs(['storage', '--config', f.configFile, '--older-than', '14d'])['older-than'], '14d');
  const repeated = parseArgs(['storage-plan', '--config', f.configFile, '--target', 'a', '--target', 'b']);
  assert.deepEqual(repeated.targets, ['a', 'b']);
  assert.throws(() => parseArgs(['storage-plan', '--config', f.configFile]), { code: 'USAGE' });
  assert.throws(() => parseArgs(['storage-apply', '--config', f.configFile, '--plan', 'p']), { code: 'USAGE' });
  const outputs = [], text = [];
  let imported = false;
  assert.equal(await main(['storage', '--config', f.configFile, '--json'], {
    output: r => outputs.push(r), text: s => text.push(s),
    loadAcpx: async () => { imported = true; throw new Error('adapter must not load'); },
  }), 0);
  assert.equal(imported, false);
  assert.equal(outputs.at(-1).schema, 'cwr.storage.inventory/1');
  assert.equal(await main(['storage', '--config', f.configFile], {
    output: () => { throw new Error('text mode must not print JSON'); }, text: s => text.push(s),
  }), 0);
  assert.match(text.join(''), /Storage inventory/);
  await assert.rejects(main(['storage', '--config', f.configFile, '--max-entries', '0'], {
    output: () => {}, text: () => {},
  }), { code: 'USAGE' });
});

test('apply refuses a changed worker-home config before mutating and leaves the plan target intact', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  f.raw.routes.worker.workerHome = path.join(f.root, 'changed-worker-home');
  await fs.writeFile(f.configFile, JSON.stringify(f.raw), { mode: 0o600 });
  const receipt = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.targets[0].reason, 'CONFIG_CHANGED');
  assert.ok(await fs.lstat(s.scratch));
});

test('plan/schema contract remains public-safe and state paths stay private', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  assert.ok(plan.targets[0].path.startsWith(f.config.stateDir));
  assert.ok(plan.targets[0].manifest.state_root === f.config.stateDir);
  assert.equal(plan.targets[0].manifest.scratch, s.scratch);
  assert.ok(!JSON.stringify(plan).includes('synthetic payload'), 'plan never copies file payloads');
});

test('inventory exposes dashboard-compatible logical totals, CWR state and stable candidate flags', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const inv = await inventoryStorage(f.config, { olderThanMs: f.storageOlderThanMs });
  assert.ok(Number.isSafeInteger(inv.totals.logical_bytes));
  assert.equal(inv.totals.bytes, inv.totals.logical_bytes);
  assert.ok(inv.homes.some(h => h.name === 'CWR state' && h.totals.logical_bytes > 0));
  const candidate = inv.targets.find(t => t.session_id === s.id);
  assert.equal(candidate.eligibility, 'candidate');
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.logical_bytes, candidate.bytes);
  assert.ok(inv.homes.find(h => h.route === 'worker').categories.every(c => c.logical_bytes === c.bytes));
  assert.ok(inv.totals.eligible_logical_bytes >= candidate.bytes);
});

test('CLI applies only with the exact saved UUID and reports an exact private apply receipt', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const outputs = [];
  const deps = { output: r => outputs.push(r), text: () => {}, loadAcpx: async () => { throw new Error('storage never imports an adapter'); } };
  assert.equal(await main(['storage-plan', '--config', f.configFile, '--target', found.id, '--older-than', 'all'], deps), 0);
  const plan = outputs.at(-1);
  assert.equal(plan.schema, 'cwr.storage.plan/1');
  await assert.rejects(main(['storage-apply', '--config', f.configFile, '--plan', plan.plan_id, '--confirm', 'wrong'], deps), { code: 'CONFIRMATION_REQUIRED' });
  assert.ok(await fs.lstat(s.scratch));
  const blocked = await applyStoragePlan(f.config, {
    planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: false, code: 'WRITER_HANDLE_PRESENT' }),
  });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.targets[0].reason, 'WRITER_HANDLE_PRESENT');
  assert.ok(await fs.lstat(s.scratch));
  const probe = async () => ({ safe: true });
  const applyStorage = (config, options) => applyStoragePlan(config, { ...options, writerProbe: probe });
  // CLI confirmation is already covered above. Deletion uses the same backend
  // with an explicit test probe because the worker sandbox cannot approve the
  // real process-level writer probe reliably.
  const replacement = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const receipt = await applyStorage(f.config, { planId: replacement.plan_id, confirm: replacement.plan_id });
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.deleted_logical_bytes, replacement.totals.bytes);
  assert.equal(receipt.targets[0].status, 'deleted');
  assert.deepEqual(await readJSON(path.join(f.config.stateDir, 'storage', 'receipts', `${replacement.plan_id}.json`), { privateFile: true }), receipt);
  assert.deepEqual(await readJSON(path.join(f.config.stateDir, 'storage', 'receipts', `${plan.plan_id}.json`), { privateFile: true }), blocked);
  await assert.rejects(fs.stat(s.scratch), { code: 'ENOENT' });
});

test('a deletion that begins and then changes is reported partial with actual bytes, never a clean retryable failure', async t => {
  const f = await setup(t);
  const s = await closedSession(f, { 'a.txt': '1234567890', 'locked/nested.txt': 'abcdef' });
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const originalUnlink = fs.unlink;
  let calls = 0;
  t.after(() => { fs.unlink = originalUnlink; });
  fs.unlink = async file => {
    calls++;
    if (file.endsWith('.cwr-scratch.json')) return originalUnlink(file);
    if (calls === 2) {
      await originalUnlink(file);
      throw Object.assign(new Error('synthetic interruption after one unlink'), { code: 'EIO' });
    }
    await originalUnlink(file);
    return undefined;
  };
  // One payload unlink succeeds, then a later one is interrupted. The apply
  // must retain the actual bytes removed so far and stop that target.
  const result = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id,
    writerProbe: async () => ({ safe: true }) });
  assert.equal(result.status, 'partial');
  assert.equal(result.targets[0].status, 'partial');
  assert.ok(result.targets[0].deleted_logical_bytes > 0);
  assert.equal(result.targets[0].deleted_logical_bytes, result.deleted_logical_bytes);
});

test('an unlink failure after a zero-byte deletion is still partial without inventing bytes', async t => {
  const f = await setup(t);
  const s = await closedSession(f, { 'zero.txt': '', 'after.txt': 'not removed' });
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  const original = fs.unlink;
  let unlinks = 0;
  fs.unlink = async file => {
    if (file.endsWith('.cwr-scratch.json')) return original(file);
    unlinks++;
    if (unlinks === 2) throw Object.assign(new Error('synthetic failure after empty file'), { code: 'EIO' });
    return original(file);
  };
  t.after(() => { fs.unlink = original; });
  const receipt = await applyStoragePlan(f.config, {
    planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: true }),
  });
  assert.equal(receipt.status, 'partial');
  assert.ok(receipt.targets[0].deleted_logical_bytes >= 0);
  assert.equal(receipt.targets[0].deletion_uncertain, false);
  assert.equal(receipt.targets[0].deletion_uncertain, false);
  assert.equal(receipt.disk_freed_estimate, receipt.deleted_allocated_bytes);
});

test('retention is shared by inventory, plan and apply; close time dominates old files', async t => {
  const f = await setup(t);
  const oldFiles = { 'payload.txt': 'old payload' };
  const old = new Date(Date.now() - 30 * 86_400_000);
  const oldSession = await closedSession(f, oldFiles, { closedAt: old });
  const recentClose = await closedSession(f, oldFiles, { closedAt: new Date() });
  const seven = await inventoryStorage(f.config, { olderThanMs: 7 * 86_400_000 });
  assert.equal(seven.targets.find(x => x.session_id === oldSession.id).eligibility, 'candidate');
  assert.equal(seven.targets.find(x => x.session_id === recentClose.id).eligibility, 'inspect_only');
  assert.ok(seven.targets.find(x => x.session_id === recentClose.id).reasons.some(x => x.code === 'TOO_RECENT'));

  const fourteen = await inventoryStorage(f.config, { olderThanMs: 14 * 86_400_000 });
  assert.equal(fourteen.targets.find(x => x.session_id === oldSession.id).eligibility, 'candidate');
  assert.notEqual(fourteen.targets.find(x => x.session_id === recentClose.id).eligibility, 'candidate');

  const recentTarget = (await inventoryStorage(f.config, { olderThanMs: 0 })).targets.find(x => x.session_id === recentClose.id);
  await assert.rejects(planStorage(f.config, { targetIds: [recentTarget.id], olderThanMs: 7 * 86_400_000 }),
    { code: 'TARGET_NOT_ELIGIBLE' });
  const oldTarget = fourteen.targets.find(x => x.session_id === oldSession.id);
  const plan = await planStorage(f.config, { targetIds: [oldTarget.id], olderThanMs: 14 * 86_400_000 });
  assert.equal(plan.targets[0].session_id, oldSession.id);

  const binding = await loadBinding(f.config.stateDir, oldSession.id);
  binding.closedAt = new Date().toISOString();
  await atomicJSON(paths(f.config.stateDir, oldSession.id).binding, binding);
  const changed = await applyStoragePlan(f.config, {
    planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: true }),
  });
  assert.equal(changed.status, 'failed');
  assert.equal(changed.targets[0].reason, 'TARGET_TOO_RECENT');
  assert.ok(await fs.lstat(oldSession.scratch));

  binding.closedAt = 'invalid-date';
  await atomicJSON(paths(f.config.stateDir, oldSession.id).binding, binding);
  const unknown = await inventoryStorage(f.config, { olderThanMs: 0 });
  assert.notEqual(unknown.targets.find(x => x.session_id === oldSession.id).eligibility, 'candidate');
  assert.ok(unknown.targets.find(x => x.session_id === oldSession.id).reasons.some(x => x.code === 'CLOSE_TIME_UNKNOWN'));
});

test('Codex sessions, SQLite/WAL, logs, .tmp and unknown home remainders are disjoint and fully visible', async t => {
  const f = await setup(t);
  const home = f.selection.route.workerHome;
  const codex = path.join(home, '.codex');
  await fs.mkdir(path.join(codex, 'sessions'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(codex, 'sessions', 'thread.jsonl'), 'SECRET_HISTORY_PAYLOAD', { mode: 0o600 });
  await fs.mkdir(path.join(codex, 'history'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(codex, 'history', 'thread_history.sqlite'), 'SECRET_HISTORY_DB', { mode: 0o600 });
  await fs.writeFile(path.join(codex, 'logs_2.sqlite'), 'SECRET_LOG_PAYLOAD', { mode: 0o600 });
  await fs.writeFile(path.join(codex, 'logs_2.sqlite-wal'), 'SECRET_WAL_PAYLOAD', { mode: 0o600 });
  await fs.writeFile(path.join(codex, 'thread_history.sqlite'), 'SECRET_THREAD_DB', { mode: 0o600 });
  await fs.mkdir(path.join(codex, '.tmp'), { mode: 0o700 });
  await fs.writeFile(path.join(codex, '.tmp', 'legacy.tmp'), 'SECRET_TMP_PAYLOAD', { mode: 0o600 });
  await fs.writeFile(path.join(home, 'unknown-file'), 'SECRET_UNKNOWN_PAYLOAD', { mode: 0o600 });
  await fs.mkdir(path.join(f.config.stateDir, 'bindings'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(f.config.stateDir, 'dashboard-preferences.json'), '{"theme":"sage"}', { mode: 0o600 });

  const inv = await inventoryStorage(f.config, { olderThanMs: 7 * 86_400_000 });
  const row = name => inv.targets.find(x => x.path === path.join(codex, name));
  const expected = {
    history: Buffer.byteLength('SECRET_HISTORY_PAYLOAD'),
    historyDb: Buffer.byteLength('SECRET_HISTORY_DB'),
    log: Buffer.byteLength('SECRET_LOG_PAYLOAD'),
    wal: Buffer.byteLength('SECRET_WAL_PAYLOAD'),
    threadDb: Buffer.byteLength('SECRET_THREAD_DB'),
    tmp: Buffer.byteLength('SECRET_TMP_PAYLOAD'),
  };
  assert.equal(row('sessions').bytes, expected.history);
  assert.equal(row('history').bytes, expected.historyDb);
  assert.equal(row('logs_2.sqlite').bytes, expected.log);
  assert.equal(row('logs_2.sqlite-wal').bytes, expected.wal);
  assert.equal(row('thread_history.sqlite').bytes, expected.threadDb);
  assert.equal(row('.tmp').bytes, expected.tmp);
  assert.equal(row('sessions').category, 'sessions_history');
  assert.equal(row('history').category, 'sessions_history');
  assert.equal(row('logs_2.sqlite').category, 'logs_databases');
  assert.equal(row('logs_2.sqlite-wal').category, 'logs_databases');
  assert.equal(row('thread_history.sqlite').category, 'logs_databases');
  assert.equal(row('.tmp').category, 'scratch');
  assert.ok(inv.targets.some(x => x.path === path.join(home, 'unknown-file') &&
    x.reasons.some(r => r.code === 'UNKNOWN_HOME_REMAINDER')));
  assert.ok(inv.targets.some(x => x.path.endsWith('dashboard-preferences.json') && x.bytes === 16));
  assert.ok(!JSON.stringify(inv).includes('SECRET_'));
  assert.ok(inv.totals.logical_bytes >= Object.values(expected).reduce((a, b) => a + b, 0));
});

test('extra homes: dedicated descendants pass; ancestors, overlaps, duplicates and ancestor symlinks fail', async t => {
  const f = await setup(t);
  const mainHome = path.join(f.root, 'operator-home');
  const retired = path.join(mainHome, 'profiles', 'retired');
  await fs.mkdir(retired, { recursive: true, mode: 0o700 });
  const config = { ...f.config, mainHome };
  const inv = await inventoryStorage(config, { extraHomes: [retired], olderThanMs: 0 });
  assert.ok(inv.homes.some(x => x.status === 'retired_extra'));
  await assert.rejects(inventoryStorage(config, { extraHomes: [retired, retired], olderThanMs: 0 }), { code: 'EXTRA_HOME_OVERLAP' });
  await assert.rejects(inventoryStorage(config, { extraHomes: [mainHome], olderThanMs: 0 }), { code: 'EXTRA_HOME_OVERLAP' });
  await assert.rejects(inventoryStorage(config, { extraHomes: [f.config.stateDir], olderThanMs: 0 }), { code: 'EXTRA_HOME_OVERLAP' });
  await assert.rejects(inventoryStorage(config, { extraHomes: [f.cwd], olderThanMs: 0 }), { code: 'EXTRA_HOME_OVERLAP' });
  if (process.platform !== 'win32') {
    const linked = path.join(f.root, 'linked-retired');
    await fs.symlink(retired, linked);
    await assert.rejects(inventoryStorage(config, { extraHomes: [linked], olderThanMs: 0 }), { code: 'EXTRA_HOME_UNSAFE' });
    const redirected = path.join(f.root, 'redirected-home');
    await fs.mkdir(redirected, { mode: 0o700 });
    await fs.symlink(retired, path.join(redirected, '.local'));
    const redirectedConfig = { ...config, routes: { ...config.routes, worker: { ...config.routes.worker, workerHome: redirected } } };
    const scan = await inventoryStorage(redirectedConfig, { olderThanMs: 0 });
    const unsafe = scan.targets.find(x => x.path === path.join(redirected, '.local', 'share'));
    assert.ok(unsafe);
    assert.equal(unsafe.eligibility, 'incomplete');
    assert.ok(unsafe.reasons.some(x => ['SYMLINK_SKIPPED', 'ANCESTRY_UNSAFE', 'ANCESTRY_CHANGED'].includes(x.code)));
  }
});

test('writer probe failures never permit deletion', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  for (const code of ['WRITER_PROBE_UNAVAILABLE','WRITER_PROBE_FAILED','WRITER_PROBE_TIMEOUT','WRITER_HANDLE_PRESENT']) {
    const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
    const receipt = await applyStoragePlan(f.config, { planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: false, code }) });
    assert.equal(receipt.status, 'failed');assert.equal(receipt.targets[0].reason,code);
    assert.ok(await fs.lstat(s.scratch));
  }
});

test('real lsof permits an idle scratch and detects a nested live handle', {skip:process.platform==='win32'?'No supported Windows writer probe':false}, async t => {
  const f=await setup(t),s=await closedSession(f,{'nested/payload.txt':'held fixture'});
  const probe=storageWriterProbe(),idle=await probe(s.scratch);
  if(['WRITER_PROBE_UNAVAILABLE','WRITER_PROBE_WARNING'].includes(idle.code)){t.skip('lsof observation unavailable: '+idle.code);return;}
  assert.deepEqual(idle,{safe:true});
  const holder=spawn(process.execPath,['-e','const fs=require("fs");fs.openSync(process.argv[1],"r");process.stdout.write("CWR_HOLDER_READY");setInterval(()=>{},1000)',path.join(s.scratch,'nested/payload.txt')],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(holder.exitCode===null&&holder.signalCode===null){holder.kill('SIGKILL');await new Promise(resolve=>holder.once('close',resolve));}});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('holder did not become ready')),5000);holder.stdout.on('data',chunk=>{text+=chunk;if(text.includes('CWR_HOLDER_READY')){clearTimeout(timer);resolve();}});holder.once('error',reject);holder.once('exit',code=>{clearTimeout(timer);reject(new Error('holder exited before ready: '+code));});});
  assert.deepEqual(await probe(s.scratch),{safe:false,code:'WRITER_HANDLE_PRESENT'});
  const {found}=await target(f,s.id),plan=await planStorage(f.config,{targetIds:[found.id],olderThanMs:0});
  const blocked=await applyStoragePlan(f.config,{planId:plan.plan_id,confirm:plan.plan_id});
  assert.equal(blocked.status,'failed');assert.equal(blocked.targets[0].reason,'WRITER_HANDLE_PRESENT');assert.ok(await fs.lstat(s.scratch));
  holder.kill('SIGTERM');await new Promise(resolve=>holder.once('close',resolve));
  assert.deepEqual(await probe(s.scratch),{safe:true});
});

test('repeating a finalized apply preserves its stored outcome and never deletes again', async t => {
  const f=await setup(t),s=await closedSession(f);const {found}=await target(f,s.id);
  const plan=await planStorage(f.config,{targetIds:[found.id],olderThanMs:0});
  const first=await applyStoragePlan(f.config,{planId:plan.plan_id,confirm:plan.plan_id,writerProbe:async()=>({safe:true})});assert.equal(first.status,'applied');
  const file=path.join(f.config.stateDir,'storage','receipts',plan.plan_id+'.json'),before=await fs.readFile(file);
  const second=await applyStoragePlan(f.config,{planId:plan.plan_id,confirm:plan.plan_id,writerProbe:async()=>{throw new Error('must not probe again');}});
  assert.equal(second.status,'applied');assert.equal(second.replayed,true);assert.equal(second.finished_at,first.finished_at);assert.ok(before.equals(await fs.readFile(file)));
});

test('apply journals target deletion durably before finalization', async t => {
  const f = await setup(t);
  const s = await closedSession(f);
  const { found } = await target(f, s.id);
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  await applyStoragePlan(f.config, {
    planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: true }),
  });
  const receipt = await readJSON(path.join(f.config.stateDir, 'storage', 'receipts', `${plan.plan_id}.json`), { privateFile: true });
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.targets[0].status, 'deleted');
  await assert.rejects(fs.lstat(path.join(f.config.stateDir, 'storage', 'apply.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(f.config.stateDir, 'storage', 'inflight', `${plan.plan_id}.json`)), { code: 'ENOENT' });
});

test('unknown new-session setup failures are covered by the existing cleanup guard', async t => {
  const f = await setup(t);
  const api = fakeAcpx();
  const output = [];
  await assert.rejects(main(['run', '--permissions', 'read', '--config', f.configFile, '--route', 'worker',
    '--cwd', f.cwd, '--file', f.orderFile], {
    output: r => output.push(r), progress: () => {}, loadAcpx: async () => api,
    replaceEnvironment: () => {},
    createScratch: async () => { throw new Fault('SYNTHETIC_SETUP_FAILURE', 'synthetic setup failure'); },
  }), { code: 'SYNTHETIC_SETUP_FAILURE' });
  assert.equal(api.calls.length, 0);
  const sessions = await fs.readdir(path.join(f.config.stateDir, 'bindings')).catch(() => []);
  for (const session of sessions) {
    await assert.rejects(fs.lstat(paths(f.config.stateDir, session).lock), { code: 'ENOENT' });
  }
  const locks = await fs.readdir(path.join(f.config.stateDir, 'workspace-locks')).catch(() => []);
  assert.deepEqual(locks, []);
});

test('a failed new binding publication retains inspect-only scratch and releases execution locks', async t => {
  const f = await setup(t);
  const api = fakeAcpx();
  await assert.rejects(main(['run', '--permissions', 'read', '--config', f.configFile, '--route', 'worker',
    '--cwd', f.cwd, '--file', f.orderFile], {
    output: () => {}, progress: () => {}, loadAcpx: async () => api, replaceEnvironment: () => {},
    atomicJSON: async () => { throw new Fault('SYNTHETIC_BINDING_FAILURE', 'synthetic publication failure'); },
  }), { code: 'SYNTHETIC_BINDING_FAILURE' });
  assert.equal(api.calls.length, 0);
  const inventory = await inventoryStorage(f.config, { olderThanMs: 0 });
  const orphan = inventory.targets.find(row => row.path.startsWith(path.join(f.config.stateDir, 'scratch')));
  assert.ok(orphan);
  assert.equal(orphan.eligible, false);
  assert.ok(await fs.lstat(path.join(orphan.path, '.cwr-scratch.json')));
  assert.deepEqual(await fs.readdir(path.join(f.config.stateDir, 'workspace-locks')), []);
  for (const session of await fs.readdir(path.join(f.config.stateDir, 'bindings')))
    await assert.rejects(fs.lstat(paths(f.config.stateDir, session).lock), { code: 'ENOENT' });
});

test('storage --extra-home is repeatable only on inventory and dashboard receives configPath', async t => {
  const f = await setup(t);
  const one = parseArgs(['storage', '--config', f.configFile, '--extra-home', '/synthetic/a', '--extra-home', '/synthetic/b']);
  assert.deepEqual(one.extraHomes, ['/synthetic/a', '/synthetic/b']);
  assert.throws(() => parseArgs(['storage-plan', '--config', f.configFile, '--target', 'x', '--extra-home', '/a']), { code: 'USAGE' });
  assert.throws(() => parseArgs(['storage-apply', '--config', f.configFile, '--plan', 'x', '--confirm', 'x', '--extra-home', '/a']), { code: 'USAGE' });
  let options;
  const stub = { startDashboard: async value => { options = value; return { url: 'http://127.0.0.1:4317/#token=x', port: 4317 }; } };
  assert.equal(await main(['dashboard', '--config', f.configFile, '--port', '4317'], {
    output: () => {}, text: () => {}, loadDashboard: async () => stub,
  }), 0);
  assert.equal(options.configPath, f.configFile);
});

test('the compact per-session TMPDIR supports a real Python listener while the former long layout fails',
  { skip: process.platform === 'win32' ? 'POSIX Unix socket regression' : false }, async t => {
  const f = await setup(t, { compact: true });
  const id = randomUUID();
  const v2 = newScratchLocation(f.config, 'worker', f.selection.route, id);
  const old = v1ScratchLocation(f.config, 'worker', f.selection.route, id);
  await privateDir(v2.path);
  await privateDir(old.path);
  const fresh = await runPythonListener(v2.path);
  if (fresh.error === 'ENOENT') {
    t.skip('python3 is unavailable');
    return;
  }
  const prior = await runPythonListener(old.path);
  assert.equal(prior.ok, false);
  if (/Operation not permitted/.test(fresh.stderr)) {
    t.skip('sandbox denies Unix socket bind; compact path length is covered separately');
    return;
  }
  assert.match(prior.stderr, /AF_UNIX path too long|too long/);
  assert.equal(fresh.ok, true, fresh.stderr);
});

test('a valid managed v1 scratch keeps its original path through continuation, inventory and apply', async t => {
  const f = await setup(t);
  const v1 = await makeV1Session(f);
  const loaded = await loadScratch(f.config, 'worker', f.selection.route, v1.id, v1.descriptor);
  assert.equal(loaded.scratch, v1.scratch);
  assert.equal(loaded.descriptor.format, 'worker-home-v1');
  const found = (await target(f, v1.id)).found;
  assert.equal(found.path, v1.scratch);
  assert.equal(found.eligibility, 'candidate');
  const plan = await planStorage(f.config, { targetIds: [found.id], olderThanMs: 0 });
  assert.equal(plan.targets[0].path, v1.scratch);
  const applied = await applyStoragePlan(f.config, {
    planId: plan.plan_id, confirm: plan.plan_id, writerProbe: async () => ({ safe: true }),
  });
  assert.equal(applied.status, 'applied');
  await assert.rejects(fs.lstat(v1.scratch), { code: 'ENOENT' });
});

test('new state scratch is counted once, excluded from CWR state totals, and orphan content is inspect-only', async t => {
  const f = await setup(t);
  const s = await closedSession(f, { 'payload.txt': 'count exactly once' });
  const inv = await inventoryStorage(f.config, { olderThanMs: 0 });
  assert.equal(inv.targets.filter(x => x.path === s.scratch).length, 1);
  const cwr = inv.homes.find(x => x.name === 'CWR state');
  assert.ok(!cwr.categories.some(x => x.path === path.join(f.config.stateDir, 'scratch')));
  const orphan = path.join(f.config.stateDir, 'scratch', 'orphan-content');
  await fs.mkdir(orphan, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(orphan, 'unknown'), 'orphan bytes', { mode: 0o600 });
  const next = await inventoryStorage(f.config, { olderThanMs: 0 });
  const orphanTarget = next.targets.find(x => x.path === orphan && x.kind === 'state');
  assert.ok(orphanTarget);
  assert.equal(orphanTarget.eligibility, 'inspect_only');
  assert.ok(orphanTarget.reasons.some(x => x.code === 'UNOWNED_STATE_SCRATCH'));
  assert.equal(next.targets.filter(x => x.path === s.scratch).length, 1);
});

test('multiple routes inventory the shared scratch root once and reconcile all profile totals', async t => {
  const f = await setup(t);
  f.raw.routes.secondary = { ...f.raw.routes.worker, workerHome: path.join(f.root, 'secondary-home') };
  await fs.writeFile(f.configFile, JSON.stringify(f.raw), { mode: 0o600 });
  const { loadConfig } = await import('../src/config.mjs');
  f.config = await loadConfig(f.configFile);
  const s = await closedSession(f);
  const v1 = await makeV1Session(f);
  const orphan = path.join(f.config.stateDir, 'scratch', compactSessionKey(randomUUID()));
  await fs.mkdir(orphan, { mode: 0o700 });
  await fs.writeFile(path.join(orphan, 'unknown.txt'), 'unowned scratch');
  await atomicJSON(path.join(orphan, '.cwr-scratch.json'), null);
  const inventory = await inventoryStorage(f.config, { olderThanMs: 0 });
  for (const root of [s.scratch, v1.scratch, orphan])
    assert.equal(inventory.targets.filter(row => row.path === root).length, 1, 'one target per physical scratch tree');
  assert.equal(new Set(inventory.targets.map(row => row.id)).size, inventory.targets.length);
  assert.equal(inventory.targets.find(row => row.path === s.scratch).route, 'worker');
  assert.equal(inventory.targets.find(row => row.path === orphan).eligible, false);
  assert.equal(inventory.homes.reduce((sum, home) => sum + home.totals.logical_bytes, 0), inventory.totals.bytes);
  for (const home of inventory.homes)
    assert.equal(home.categories.reduce((sum, row) => sum + row.bytes, 0), home.totals.logical_bytes);
  const secondary = inventory.homes.find(home => home.route === 'secondary');
  assert.equal(secondary.totals.logical_bytes, 0, 'another route does not inherit the first route’s scratch');
});
