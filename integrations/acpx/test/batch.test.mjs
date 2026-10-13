// Finite batch contracts use a synthetic job spawner and a real temporary state
// root. A separate case in real-acpx.integration exercises real subprocesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseManifest, runBatch, MANIFEST_SCHEMA, HANDLE_SCHEMA } from '../src/batch.mjs';
import { writeDeliverySidecar, deliveryFile } from '../src/delivery.mjs';
import { fixture } from './helpers.mjs';

function job(over = {}) {
  return { id: 'j1', verb: 'run', route: 'worker', cwd: '/abs/ws', file: '/abs/o.md', permissions: 'read', ...over };
}
const uuid = () => randomUUID();
async function jobRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-bws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const blockFor = (req, sid, over = {}) => '```cwr-delivery\n' + JSON.stringify({ schema: 'cwr.acp.delivery/1', status: 'ready', summary: 'ok', criteria: [], checks: [], artifacts: [], questions: [], request_id: req, session_id: sid, ...over }) + '\n```';

test('manifest validation is strict: schema, ids, verbs, permissions, absolute paths, deliver', () => {
  assert.throws(() => parseManifest({ schema: 'x', jobs: [job()] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ id: 'bad id!' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ id: 'a' }), job({ id: 'a' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ verb: 'stop' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ permissions: undefined })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ cwd: 'relative' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ verb: 'continue' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ deliver: 'yes' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ verb: 'continue', session: uuid(), route: 'worker' })] }), { code: 'BAD_MANIFEST' });
  assert.throws(() => parseManifest({ schema: MANIFEST_SCHEMA, jobs: [job({ session: uuid() })] }), { code: 'BAD_MANIFEST' });
  const ok = parseManifest({ schema: MANIFEST_SCHEMA, maxConcurrency: 3, jobs: [job({ id: 'a' }), job({ id: 'b', resources: ['port:1'], deliver: false })] });
  assert.equal(ok.maxConcurrency, 3);
  assert.equal(ok.jobs.length, 2);
  assert.equal(ok.jobs[0].deliver, true);
  assert.equal(ok.jobs[1].deliver, false);
});

// A synthetic spawner: writes a real start handle + receipt-shaped stdout, and
// (optionally) a real delivery sidecar into the fixture state root, so the batch
// collection path is exercised. `failIds` emit no receipt.
function fakeSpawner(state, behavior = {}) {
  return ({ job, handleFile, env }) => {
    let resolveDone, stopped = false;
    const done = new Promise(r => { resolveDone = r; });
    if (behavior.captureEnv) behavior.captureEnv(job, env);
    const start = async () => {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      const sid = uuid(), req = uuid();
      // The batch canonicalizes the workspace; the fake mirrors that so a
      // matching handle proves realpath comparison, not a raw-string match.
      const handleCwd = behavior.handleCwd ?? await fs.realpath(job.cwd).catch(() => job.cwd);
      await fs.writeFile(handleFile, JSON.stringify({ schema: HANDLE_SCHEMA, session_id: sid, request_id: req, cwd: handleCwd, route: job.route ?? 'worker' }));
      if (behavior.marker) behavior.marker(job, state, { sid, req });
      await new Promise(r => setTimeout(r, behavior.delay ?? 20));
      if (stopped) { state.active--; return; }
      if (behavior.failIds?.includes(job.id)) { state.active--; resolveDone({ code: 2, stdout: JSON.stringify({ schema: 'cwr.acp.error/1', code: 'X' }), stderr: 'boom' }); return; }
      if (job.deliver && behavior.writeDelivery !== false) {
        const overstated = behavior.deliverStatus ? { status: behavior.deliverStatus } : {};
        await writeDeliverySidecar({ stateDir: behavior.stateDir, session: sid, requestId: req, finishedAt: new Date().toISOString(), text: blockFor(req, sid, overstated) });
      }
      const receipt = { schema: 'cwr.acp.receipt/1', session_id: sid, request_id: req, runtime_status: behavior.status ?? 'completed', cleanup: 'confirmed', receipt_path: `/r/${job.id}.json`, error_code: null };
      state.active--;
      resolveDone({ code: behavior.status === 'failed' ? 1 : 0, stdout: JSON.stringify(receipt), stderr: '' });
    };
    const stop = () => { stopped = true; resolveDone({ code: null, stdout: '', stderr: 'cancelled' }); };
    start();
    return { done, stop };
  };
}

async function batchFixture(t, jobs, behavior = {}) {
  const f = await fixture();
  t.after(f.cleanup);
  // Register the job workspaces so real canonicalization runs against real dirs.
  const extra = [];
  for (const j of jobs) { await fs.mkdir(j.cwd, { recursive: true }); extra.push(j.cwd); }
  f.raw.routes.worker.workspaces = [...new Set([f.cwd, ...extra])];
  f.raw.routes.backup = { ...f.raw.routes.worker, workerHome: path.join(f.root, 'backup-home') };
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  const manifest = path.join(f.root, 'batch.json');
  await fs.writeFile(manifest, JSON.stringify({ schema: MANIFEST_SCHEMA, maxConcurrency: behavior.maxConcurrency ?? 2, jobs }));
  const out = [];
  return { f, manifestFile: manifest, out, state: { active: 0, maxActive: 0 } };
}
async function run(f, manifestFile, out, spawner, concurrency) {
  return runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile, ...(concurrency ? { concurrency: String(concurrency) } : {}) },
    deps: { loadConfig: async () => f.config, spawnJob: spawner },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
}

test('batch runs each job as an independent process and returns complete with matching handles + delivery', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const cwdB = path.join((await jobRoot(t)), 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
    job({ id: 'b', cwd: cwdB, file: path.join(cwdB, 'o.md') }),
  ]);
  const code = await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir }));
  assert.equal(code, 0);
  const batch = out.at(-1);
  assert.equal(batch.status, 'complete');
  assert.equal(batch.admission_scope, 'batch_local_only');
  for (const j of batch.jobs) {
    assert.ok(j.start_handle, 'each job must expose a machine start handle');
    assert.equal(j.start_handle.request_id, j.request_id);
    assert.equal(j.start_handle.session_id, j.session_id);
    assert.equal(j.runtime_status, 'completed');
    assert.equal(j.delivery_status, 'ready');
    assert.equal(j.delivery_problem, null);
  }
});

test('a required delivery that is missing/wrong-identity yields partial with a reason', async t => {
  const cwd = path.join((await jobRoot(t)), 'x');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd, file: path.join(cwd, 'o.md'), deliver: true })]);
  const code = await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, writeDelivery: false }));
  assert.equal(code, 1);
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.deepEqual(batch.missing, ['a']);
  assert.equal(batch.jobs[0].delivery_problem, 'DELIVERY_MISSING');
});

test('a delivery:false job needs no sidecar and does not become partial', async t => {
  const cwd = path.join((await jobRoot(t)), 'y');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd, file: path.join(cwd, 'o.md'), deliver: false })]);
  const code = await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, writeDelivery: false }));
  assert.equal(code, 0);
  assert.equal(out.at(-1).status, 'complete');
});

test('batch serializes an UNKNOWN shared worker home unless every overlapping job is validated', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }), job({ id: 'b', cwd: b, file: path.join(b, 'o.md') })]);
  await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, delay: 40 }));
  assert.equal(state.maxActive, 1, 'same route => same home => serialized locally');
});

test('a partial shared-home validation cannot bypass serialization', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  // Only ONE job claims validated; the route home is shared, so it must still serialize.
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), sharedHomeValidation: 'validated' }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md') }),
  ]);
  await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, delay: 40 }));
  assert.equal(state.maxActive, 1, 'a partial validated declaration must not bypass serialization');
});

test('manifest-level validated shared home allows same-route parallelism', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const f = await fixture(); t.after(f.cleanup);
  await fs.mkdir(a, { recursive: true }); await fs.mkdir(b, { recursive: true });
  f.raw.routes.worker.workspaces = [f.cwd, a, b];
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  const manifest = path.join(f.root, 'b.json');
  // Parallelism on a shared home needs BOTH the manifest-level operator opt-in
  // and each overlapping job's own validated declaration.
  await fs.writeFile(manifest, JSON.stringify({ schema: MANIFEST_SCHEMA, maxConcurrency: 2, capabilities: { sharedWorkerHome: 'validated' }, jobs: [job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), sharedHomeValidation: 'validated' }), job({ id: 'b', cwd: b, file: path.join(b, 'o.md'), sharedHomeValidation: 'validated' })] }));
  const state = { active: 0, maxActive: 0 }, out = [];
  await runBatch({ config: { configPath: f.configFile }, opt: { manifest }, deps: { loadConfig: async () => f.config, spawnJob: fakeSpawner(state, { stateDir: f.config.stateDir, delay: 60 }) }, output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs' });
  assert.ok(state.maxActive >= 2, 'validated shared home may run concurrently');
});

test('batch serializes declared shared resources regardless of cwd or home', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), resources: ['port:4317'] }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md'), resources: ['port:4317'] }),
  ]);
  await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, delay: 40 }));
  assert.equal(state.maxActive, 1);
});

test('a missing required result yields partial, never a majority-complete claim', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }), job({ id: 'b', cwd: b, file: path.join(b, 'o.md') })]);
  const code = await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, failIds: ['b'] }));
  assert.equal(code, 1);
  assert.equal(out.at(-1).status, 'partial');
  assert.deepEqual(out.at(-1).missing, ['b']);
});

test('a handle that does not match its receipt identity is a partial, not a trusted handle', async t => {
  const cwd = path.join((await jobRoot(t)), 'z');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd, file: path.join(cwd, 'o.md') })]);
  // The fake writes a handle with the wrong cwd, which must not match.
  const spawner = fakeSpawner(state, { stateDir: f.config.stateDir, handleCwd: '/wrong/cwd' });
  const code = await run(f, manifestFile, out, spawner);
  assert.equal(code, 1);
  assert.equal(out.at(-1).status, 'partial');
  assert.deepEqual(out.at(-1).missing, ['a']);
  assert.equal(out.at(-1).jobs[0].handle_mismatch, true);
  assert.equal(out.at(-1).jobs[0].start_handle, null);
});

test('an unknown/disabled route fails the whole batch before anything launches', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', route: 'ghost', cwd: a, file: path.join(a, 'o.md') })]);
  let spawned = 0;
  await assert.rejects(runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: () => { spawned++; return { done: Promise.resolve({}), stop: () => {} }; } },
    output: () => {}, text: () => {}, cliPath: 'cli.mjs',
  }), { code: 'ROUTE_DISABLED' });
  assert.equal(spawned, 0);
});

test('a parent interruption stops launching new items and preserves actual handles', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b'), c = path.join(base, 'c');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }), job({ id: 'b', cwd: b, file: path.join(b, 'o.md') }), job({ id: 'c', cwd: c, file: path.join(c, 'o.md') })]);
  const spawner = fakeSpawner(state, { stateDir: f.config.stateDir, delay: 60, marker: () => process.emit('SIGINT') });
  const code = await run(f, manifestFile, out, spawner);
  assert.equal(code, 1);
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.equal(batch.cancelled, true);
  // Every prepared job is accounted for exactly once across observed records
  // and missing ids; no fabricated result for a job that never produced one.
  assert.equal(new Set([...batch.jobs.map(j => j.id), ...batch.missing]).size, 3);
  assert.ok(batch.jobs.every(j => j.output_received || batch.missing.includes(j.id)));
  // The durable index exists and reflects real observed state.
  const index = JSON.parse(await fs.readFile(batch.index_path, 'utf8'));
  assert.equal(index.schema, 'cwr.acp.batch-index/1');
});


test('mixed job validation still serializes when the manifest declares HOME concurrency', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), sharedHomeValidation: 'validated' }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md') }),
  ]);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.capabilities = { sharedWorkerHome: 'validated' };
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, delay: 50 }));
  assert.equal(state.maxActive, 1);
});

test('changed route config fails a pending job before old-HOME admission can launch it', async t => {
  const cwd = path.join(await jobRoot(t), 'a');
  const { f, manifestFile, out } = await batchFixture(t, [job({ cwd, file: path.join(cwd, 'o.md') })]);
  let reads = 0, starts = 0;
  const changed = { ...f.config, routes: { ...f.config.routes, worker: { ...f.config.routes.worker, workerHome: path.join(f.root, 'changed-home') } } };
  const code = await runBatch({ config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => ++reads === 1 ? f.config : changed, spawnJob: () => { starts++; throw new Error('must not launch'); } },
    output: r => out.push(r), cliPath: 'cli.mjs' });
  assert.equal(starts, 0); assert.equal(code, 1);
  assert.equal(out.at(-1).jobs[0].error_code, 'CONFIG_CHANGED');
});

test('a batch forwards only the selected route passEnv into a separate CLI HOME', async t => {
  const cwd = path.join(await jobRoot(t), 'a');
  const { f, manifestFile, out, state } = await batchFixture(t, [job({ cwd, file: path.join(cwd, 'o.md') })]);
  const previous = process.env.CWR_SYNTHETIC_TOKEN;
  process.env.CWR_SYNTHETIC_TOKEN = 'synthetic-only';
  t.after(() => { if (previous === undefined) delete process.env.CWR_SYNTHETIC_TOKEN; else process.env.CWR_SYNTHETIC_TOKEN = previous; });
  const cfg = { ...f.config, routes: { ...f.config.routes, worker: { ...f.config.routes.worker, passEnv: ['CWR_SYNTHETIC_TOKEN'] } } };
  let observed;
  await runBatch({ config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => cfg, spawnJob: fakeSpawner(state, { stateDir: cfg.stateDir, captureEnv: (_, env) => { observed = env; } }) },
    output: r => out.push(r), cliPath: 'cli.mjs' });
  assert.equal(observed.CWR_SYNTHETIC_TOKEN, 'synthetic-only');
  assert.notEqual(observed.HOME, process.env.HOME);
  assert.notEqual(observed.HOME, cfg.routes.worker.workerHome);
  assert.equal(observed.CODEX_HOME, undefined);
});

test('a parent cancellation settles boundedly even if an owned child does not acknowledge', async t => {
  const cwd = path.join(await jobRoot(t), 'a');
  const { f, manifestFile, out } = await batchFixture(t, [job({ cwd, file: path.join(cwd, 'o.md') })]);
  const started = Date.now();
  const code = await runBatch({ config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: () => {
      setImmediate(() => process.emit('SIGINT'));
      return { done: new Promise(() => {}), stop: () => {} };
    } }, output: r => out.push(r), cliPath: 'cli.mjs' });
  assert.equal(code, 1); assert.ok(Date.now() - started < 8000);
  assert.equal(out.at(-1).jobs[0].cleanup, 'unconfirmed');
  assert.equal(out.at(-1).cancelled, true);
});
