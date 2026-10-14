// Finite batch contracts use a synthetic job spawner and a real temporary state
// root. A separate case in real-acpx.integration exercises real subprocesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseManifest, runBatch, collectBatch, MANIFEST_SCHEMA, HANDLE_SCHEMA } from '../src/batch.mjs';
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
      await new Promise(r => setTimeout(r, behavior.delays?.[job.id] ?? behavior.delay ?? 20));
      if (stopped) { state.active--; return; }
      if (behavior.failIds?.includes(job.id)) { state.active--; resolveDone({ code: 2, stdout: JSON.stringify({ schema: 'cwr.acp.error/1', code: 'X' }), stderr: 'boom' }); return; }
      if (job.deliver && behavior.writeDelivery !== false) {
        const overrides = behavior.block?.(job, req, sid) ?? (behavior.deliverStatus ? { status: behavior.deliverStatus } : {});
        await writeDeliverySidecar({ stateDir: behavior.stateDir, session: sid, requestId: req, finishedAt: new Date().toISOString(), text: blockFor(req, sid, overrides) });
      }
      const receipt = { schema: 'cwr.acp.receipt/1', session_id: sid, request_id: req, runtime_status: behavior.status ?? 'completed', cleanup: behavior.cleanup ?? 'confirmed', receipt_path: `/r/${job.id}.json`, error_code: null };
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

// Cancellation lands DURING the admission config reload: the scheduler must
// re-check the live cancelled state after the await, before spawn. Asserting the
// final status alone would miss this — the broken shape also ended `partial`.
test('cancellation during the first admission await launches nothing', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b'), c = path.join(base, 'c');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
    job({ id: 'c', cwd: c, file: path.join(c, 'o.md'), deliver: false }),
  ], { maxConcurrency: 3 });
  let reads = 0, starts = 0;
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: {
      loadConfig: async () => { if (++reads === 2) process.emit('SIGINT'); return f.config; },
      spawnJob: () => { starts++; return { done: new Promise(() => {}), stop: () => {} }; },
    },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.equal(starts, 0, 'cancellation during the admission await must fence every launch');
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.equal(batch.cancelled, true);
  assert.deepEqual(batch.missing, ['a', 'b', 'c']);
  assert.equal(batch.jobs.length, 0, 'no fabricated results for jobs that never launched');
});

// One job is already running while the next admission yields: the running job
// receives the stop request, the pending admission never launches.
test('cancellation while one job runs stops it and skips the pending admission', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', route: 'backup', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
  ], { maxConcurrency: 2 });
  const cfg = { ...f.config, routes: { ...f.config.routes, backup: { ...f.config.routes.worker, workerHome: path.join(f.root, 'backup-home') } } };
  let reads = 0;
  const started = [], stopped = [];
  const spawner = ({ job: j, handleFile }) => {
    started.push(j.id);
    let resolveDone, isStopped = false;
    const done = new Promise(r => { resolveDone = r; });
    void (async () => {
      await fs.writeFile(handleFile, JSON.stringify({ schema: HANDLE_SCHEMA, session_id: uuid(), request_id: uuid(), cwd: await fs.realpath(j.cwd), route: j.route }));
    })();
    return { done, stop: () => { if (isStopped) return; isStopped = true; stopped.push(j.id); resolveDone({ code: null, stdout: '', stderr: 'cancelled' }); } };
  };
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: {
      loadConfig: async () => { if (++reads === 3) process.emit('SIGTERM'); return cfg; },
      spawnJob: spawner,
    },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.deepEqual(started, ['a'], 'the pending admission must not launch after cancellation');
  assert.deepEqual(stopped, ['a'], 'the already-running job receives the stop request');
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.equal(batch.cancelled, true);
  assert.ok(batch.missing.includes('a') && batch.missing.includes('b'));
  assert.equal(batch.jobs.find(j => j.id === 'b'), undefined, 'an unlaunched job has no fabricated record');
});

// An index publication failure sets the same admission-closed state. The batch
// lets in-flight work finish but must not spawn the next job afterwards.
test('an index publication failure closes admission before the next spawn', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', route: 'backup', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
  ], { maxConcurrency: 2 });
  const cfg = { ...f.config, routes: { ...f.config.routes, backup: { ...f.config.routes.worker, workerHome: path.join(f.root, 'backup-home') } } };
  let reads = 0, starts = 0;
  const counting = fakeSpawner(state, { stateDir: f.config.stateDir, delay: 120 });
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: {
      loadConfig: async () => {
        reads++;
        if (reads === 2) {
          // Replace the just-published index with a directory: the next
          // publication (triggered by the first captured handle) must fail.
          const batchesDir = path.join(f.config.stateDir, 'batches');
          const [bid] = await fs.readdir(batchesDir);
          const indexPath = path.join(batchesDir, bid, 'index.json');
          await fs.rm(indexPath);
          await fs.mkdir(indexPath);
        }
        // Let the failing publication land before this admission resolves.
        if (reads === 3) await new Promise(r => setTimeout(r, 400));
        return cfg;
      },
      spawnJob: args => { starts++; return counting(args); },
    },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.equal(starts, 1, 'no new launch after the index publication failure');
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.equal(batch.index_warning, 'UNSAFE_FILE');
  assert.deepEqual(batch.missing, ['b']);
  assert.equal(batch.jobs[0].id, 'a');
  assert.equal(batch.jobs[0].output_received, true);
});

// A config reload that THROWS after the batch started is a runtime error, not a
// pre-launch validation failure: admission closes, collected results are kept,
// the index settles to a final status, and the batch still reports.
test('a config reload failure mid-batch still settles and reports a partial batch', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
  ], { maxConcurrency: 1 });
  let reads = 0;
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: {
      loadConfig: async () => { if (++reads === 3) throw Object.assign(new Error('config unreadable'), { code: 'BAD_JSON' }); return f.config; },
      spawnJob: fakeSpawner(state, { stateDir: f.config.stateDir, delay: 20 }),
    },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1, 'a mid-batch admission error must not escape as an unsettled batch');
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.deepEqual(batch.admission_error, { job: 'b', code: 'BAD_JSON' });
  assert.equal(batch.jobs.find(j => j.id === 'a')?.output_received, true, 'the completed job keeps its collected result');
  assert.equal(batch.jobs.find(j => j.id === 'b')?.error_code, 'BAD_JSON');
  assert.deepEqual(batch.missing, ['b']);
  const index = JSON.parse(await fs.readFile(batch.index_path, 'utf8'));
  assert.equal(index.status, 'partial', 'the durable index reaches a terminal status, not stale "running"');
  assert.ok(index.results.some(r => r.id === 'a' && r.output_received), 'collected results reach the index');
});

// A child launched BEFORE cancellation may publish its start handle only after
// the handle polls were cleared (e.g. it acquired its locks during settlement).
// The end of the bounded wait does one final read: persisted for recovery,
// trusted only on identity match, cleanup stays unconfirmed.
test('a handle published during cancellation settlement is still captured for recovery', async t => {
  const base = await jobRoot(t);
  const a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', route: 'backup', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
  ], { maxConcurrency: 2 });
  const cfg = { ...f.config, routes: { ...f.config.routes, backup: { ...f.config.routes.worker, workerHome: path.join(f.root, 'backup-home') } } };
  const sid = uuid(), req = uuid();
  let reads = 0;
  const startedAt = Date.now();
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: {
      loadConfig: async () => {
        // Once both admissions have read, cancel while both children run.
        if (++reads === 3) setTimeout(() => process.emit('SIGINT'), 50);
        return cfg;
      },
      spawnJob: ({ job: j, handleFile }) => {
        let scheduled = false;
        return {
          done: new Promise(() => {}), // never settles within the bounded wait
          stop: () => {
            if (j.id !== 'a' || scheduled) return;
            scheduled = true;
            // The handle appears only AFTER cancellation began and the polls died.
            setTimeout(() => {
              void fs.realpath(j.cwd).then(cwd => fs.writeFile(handleFile, JSON.stringify({
                schema: HANDLE_SCHEMA, session_id: sid, request_id: req, cwd, route: j.route,
              }))).catch(() => {});
            }, 150);
          },
        };
      },
    },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt < 8000, 'settlement stays bounded');
  const batch = out.at(-1);
  assert.equal(batch.cancelled, true);
  const ja = batch.jobs.find(j => j.id === 'a');
  assert.equal(ja.start_handle?.session_id, sid, 'the late-published handle is captured');
  assert.equal(ja.session_id, sid);
  assert.equal(ja.cleanup, 'unconfirmed', 'holding a handle never upgrades to a confirmed stop');
  assert.equal(ja.handle_mismatch, false);
  assert.equal(ja.output_received, false);
  const jb = batch.jobs.find(j => j.id === 'b');
  assert.equal(jb.start_handle, null);
  assert.ok(jb.handle_file.endsWith('b.handle.json'), 'a locatable handle-file clue remains when nothing was published');
  const index = JSON.parse(await fs.readFile(batch.index_path, 'utf8'));
  assert.equal(index.jobs.find(j => j.id === 'a')?.start_handle?.session_id, sid, 'the late handle reaches the durable index');
});

// The REAL spawnJob collector: a child floods stderr past the retention budget
// and only then prints a valid receipt. Diagnostics may truncate; the receipt
// must survive in stdout's own budget.
test('a noisy child cannot starve the stdout receipt: stderr and stdout keep separate budgets', async t => {
  const cwd = path.join((await jobRoot(t)), 'n');
  const order = path.join(cwd, 'o.md');
  const { f, manifestFile, out } = await batchFixture(t, [job({ id: 'n', cwd, file: order, deliver: false })]);
  await fs.writeFile(order, 'flood-stderr');
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-noisy-child.mjs');
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config }, // REAL spawnJob
    output: r => out.push(r), text: () => {}, cliPath,
  });
  const batch = out.at(-1);
  const j = batch.jobs[0];
  assert.equal(j.output_received, true, 'the valid receipt survives a flooded stderr');
  assert.equal(j.runtime_status, 'completed');
  assert.equal(j.output_truncated, false);
  assert.equal(j.stderr_truncated, true, 'stderr truncation stays visible');
  assert.ok(j.start_handle, 'the published handle still matches');
  assert.equal(code, 0);
  assert.equal(batch.status, 'complete');
});

// The reverse failure shape: padding pushes stdout past its budget AFTER a
// complete receipt, so the retained prefix still parses. A truncated stdout is
// refused as a receipt; the job lands in missing, never guessed successful.
test('a truncated stdout is never accepted as a receipt, even when the retained prefix parses', async t => {
  const cwd = path.join((await jobRoot(t)), 'o');
  const order = path.join(cwd, 'o.md');
  const { f, manifestFile, out } = await batchFixture(t, [job({ id: 'o', cwd, file: order, deliver: false })]);
  await fs.writeFile(order, 'stdout-overflow');
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-noisy-child.mjs');
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config }, // REAL spawnJob
    output: r => out.push(r), text: () => {}, cliPath,
  });
  assert.equal(code, 1);
  const batch = out.at(-1);
  const j = batch.jobs[0];
  assert.equal(j.output_truncated, true);
  assert.equal(j.output_received, false, 'a truncated receipt is refused even if the prefix is valid JSON');
  assert.equal(batch.status, 'partial');
  assert.deepEqual(batch.missing, ['o']);
});

// --- Bounded delivery excerpt, candidate next actions, incremental index ---

test('batch results carry a bounded worker-reported delivery excerpt and candidate next actions', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
  ]);
  const code = await run(f, manifestFile, out, fakeSpawner({ active: 0, maxActive: 0 }, {
    stateDir: f.config.stateDir,
    block: () => ({
      status: 'needs_input',
      summary: 'investigated the importer; one contract conflict remains',
      criteria: [{ criterion: 'map the call chain', state: 'satisfied' }, { criterion: 'decide which contract wins', state: 'unsatisfied' }],
      checks: [{ name: 'npm run check', state: 'passed', detail: 'all green' }, { name: 'contract probe', state: 'blocked', detail: 'needs a decision' }],
      questions: ['Which of the two conflicting contracts should win?'],
    }),
  }));
  // A valid needs_input delivery is complete collection, not engineering acceptance.
  assert.equal(code, 0);
  const j = out.at(-1).jobs.find(r => r.id === 'a');
  assert.equal(j.delivery_status, 'needs_input');
  const ex = j.delivery_excerpt;
  assert.equal(ex.source, 'worker_reported');
  assert.equal(ex.summary, 'investigated the importer; one contract conflict remains');
  assert.equal(ex.summary_truncated, false);
  assert.deepEqual(ex.criteria, { total: 2, unsatisfied: 1, unsatisfied_list: ['decide which contract wins'] });
  assert.equal(ex.checks.total, 2);
  assert.deepEqual(ex.checks.by_state, { passed: 1, blocked: 1 });
  assert.deepEqual(ex.checks.failing, ['contract probe']);
  assert.deepEqual(ex.questions, ['Which of the two conflicting contracts should win?']);
  assert.equal(ex.questions_total, 1);
  assert.deepEqual(j.next_actions, [{ action: 'answer_questions', session_id: j.session_id, reason: 'worker returned precise questions or a blocker' }]);
});

test('the delivery excerpt is bounded: long fields are clipped, never expanded', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
  ]);
  await run(f, manifestFile, out, fakeSpawner({ active: 0, maxActive: 0 }, {
    stateDir: f.config.stateDir,
    block: () => ({ status: 'ready', summary: 'x'.repeat(900), criteria: [], checks: [], questions: ['q1', 'q2', 'q3', 'q4', 'q5'] }),
  }));
  const ex = out.at(-1).jobs[0].delivery_excerpt;
  assert.equal(ex.summary.length, 400);
  assert.equal(ex.summary_truncated, true);
  assert.equal(ex.questions.length, 4);
  assert.equal(ex.questions_total, 5);
});

test('candidate next actions follow trusted state only', async t => {
  const mk = async (behavior, jobOver = {}) => {
    const cwdA = path.join((await jobRoot(t)), `a${randomUUID().slice(0, 8)}`);
    const { f, manifestFile, out } = await batchFixture(t, [job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md'), ...jobOver })]);
    await run(f, manifestFile, out, fakeSpawner({ active: 0, maxActive: 0 }, { stateDir: f.config.stateDir, ...behavior }));
    return out.at(-1).jobs[0];
  };
  // Failed runtime: inspect the receipt; no continue-class hint.
  const failed = await mk({ status: 'failed' });
  assert.equal(failed.runtime_status, 'failed');
  assert.deepEqual(failed.next_actions.map(a => a.action), ['inspect_receipt']);
  assert.equal(failed.next_actions[0].receipt_path, failed.receipt_path);
  // Completed runtime with a missing report: consolidate the report on the same
  // session, never replay the work.
  const missingReport = await mk({ writeDelivery: false });
  assert.equal(missingReport.delivery_problem, 'DELIVERY_MISSING');
  assert.deepEqual(missingReport.next_actions.map(a => a.action), ['consolidate_report']);
  // Unconfirmed cleanup must NOT get a continue-class hint even with questions pending.
  const unconfirmed = await mk({ cleanup: 'unconfirmed', block: () => ({ status: 'needs_input', summary: 's', criteria: [], checks: [], questions: ['q?'] }) });
  assert.equal(unconfirmed.cleanup, 'unconfirmed');
  assert.deepEqual(unconfirmed.next_actions, []);
  // No receipt at all: reconcile the session; nothing else is claimed.
  const noReceipt = await mk({ failIds: ['a'] });
  assert.equal(noReceipt.output_received, false);
  assert.deepEqual(noReceipt.next_actions.map(a => a.action), ['reconcile_session']);
});

test('settled results publish to the index mid-batch and collect reads them without waiting', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const cwdB = path.join((await jobRoot(t)), 'b');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
    job({ id: 'b', cwd: cwdB, file: path.join(cwdB, 'o.md') }),
  ]);
  const p = run(f, manifestFile, out, fakeSpawner({ active: 0, maxActive: 0 }, { stateDir: f.config.stateDir, delays: { a: 10, b: 600 } }));
  const batchesDir = path.join(f.config.stateDir, 'batches');
  let mid = null;
  for (let i = 0; i < 160 && !mid; i++) {
    const ids = await fs.readdir(batchesDir).catch(() => []);
    if (ids.length === 1) {
      try {
        const idx = JSON.parse(await fs.readFile(path.join(batchesDir, ids[0], 'index.json'), 'utf8'));
        if (idx.results?.some(r => r.id === 'a')) {
          assert.ok(!idx.results.some(r => r.id === 'b'), 'the slow job must not have settled yet');
          mid = idx;
        }
      } catch { /* retry while the index is being replaced */ }
    }
    if (!mid) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(mid, 'the settled fast job must appear in the index while the batch is still running');
  assert.equal(mid.status, 'running');
  assert.equal(mid.total, 2, 'the index carries the full batch size before every job settles');
  // The settling job's own handle is captured synchronously during collection;
  // the still-running job's handle arrives via its own poll, so it may lag.
  assert.ok(mid.jobs.some(j => j.id === 'a' && j.start_handle), 'the settled job publishes its start handle');
  const midA = mid.results.find(r => r.id === 'a');
  assert.equal(midA.delivery_excerpt.summary, 'ok');
  assert.equal(await p, 0);
  // collectBatch is a read-only view over the final index.
  const batchId = out.at(-1).batch_id;
  const collected = await collectBatch({ config: { stateDir: f.config.stateDir }, batchId });
  assert.equal(collected.schema, 'cwr.acp.batch-collect/1');
  assert.equal(collected.status, 'complete');
  assert.equal(collected.total, 2);
  assert.equal(collected.settled, 2);
  assert.equal(collected.outstanding, 0);
  assert.equal(collected.results.find(r => r.id === 'a').delivery_excerpt.summary, 'ok');
});

test('collect refuses a corrupted or unknown index instead of fabricating a pass', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
  ]);
  await run(f, manifestFile, out, fakeSpawner({ active: 0, maxActive: 0 }, { stateDir: f.config.stateDir }));
  const batchId = out.at(-1).batch_id;
  await assert.rejects(collectBatch({ config: { stateDir: f.config.stateDir }, batchId: 'not-a-uuid' }), { code: 'BAD_BATCH_ID' });
  await assert.rejects(collectBatch({ config: { stateDir: f.config.stateDir }, batchId: randomUUID() }), { code: 'BATCH_NOT_FOUND' });
  await fs.writeFile(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), '{"schema":"wrong"}\n', { mode: 0o600 });
  await assert.rejects(collectBatch({ config: { stateDir: f.config.stateDir }, batchId }), { code: 'CORRUPT_INDEX' });
});
