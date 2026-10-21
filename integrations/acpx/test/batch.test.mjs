// Finite batch contracts use a synthetic job spawner and a real temporary state
// root. A separate case in real-acpx.integration exercises real subprocesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseManifest, runBatch, collectBatch, collectBatchCompact, collectBatchJob, collectBatchImpacts, deliveryExcerpt, projectResult, MANIFEST_SCHEMA, HANDLE_SCHEMA, COMPACT_MIN_BYTES } from '../src/batch.mjs';
import { writeDeliverySidecar, deliveryFile } from '../src/delivery.mjs';
import { atomicJSON } from '../src/state.mjs';
import { fixture, deferred, sleep } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// Invoke the REAL public CLI entry (never an in-process copy) and capture the
// raw stdout bytes, so a budget assertion measures the actual command output.
function runCli(args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { maxBuffer }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}
const encodeTestCursor = payload => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

function job(over = {}) {
  return { id: 'j1', verb: 'run', route: 'worker', cwd: '/abs/ws', file: '/abs/o.md', permissions: 'read', ...over };
}
const uuid = () => randomUUID();
async function jobRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-bws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
// Whether this filesystem folds case, so a case-only alias names a real
// directory. Windows and default macOS APFS do; Linux CI does not.
async function caseInsensitiveFs() {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-case-'));
  try {
    await fs.mkdir(path.join(probe, 'CwrCaseProbe'));
    try { return (await fs.stat(path.join(probe, 'cwrcaseprobe'))).isDirectory(); }
    catch { return false; }
  } finally { await fs.rm(probe, { recursive: true, force: true }); }
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

test('dependency declarations reject unknown, self, duplicate, unbound, deliver:false and cyclic edges before launch', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), b = path.join(base, 'b'), c = path.join(base, 'c');
  const parsed = over => ({ schema: MANIFEST_SCHEMA, jobs: [
    { ...job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }), ...(over.a ?? {}) },
    { ...job({ id: 'b', cwd: b, file: path.join(b, 'o.md') }), ...(over.b ?? {}) },
    { ...job({ id: 'c', cwd: c, file: path.join(c, 'o.md') }), ...(over.c ?? {}) },
  ] });
  for (const invalid of [
    { c: { depends_on: ['ghost'], inputs: [{ job: 'ghost', report: true }] } },
    { c: { depends_on: ['c'], inputs: [{ job: 'c', report: true }] } },
    { c: { depends_on: ['a', 'a'], inputs: [{ job: 'a', report: true }] } },
    { c: { depends_on: ['a'], inputs: [] } },
    { c: { depends_on: ['a'], inputs: [{ job: 'a', artifacts: ['x'] }, { job: 'a', report: true }] } },
    { c: { depends_on: ['a'], inputs: [{ job: 'b', report: true }] } },
    { a: { deliver: false }, c: { depends_on: ['a'], inputs: [{ job: 'a', report: true }] } },
    { a: { depends_on: ['c'], inputs: [{ job: 'c', report: true }] }, c: { depends_on: ['a'], inputs: [{ job: 'a', report: true }] } },
  ]) assert.throws(() => parseManifest(parsed(invalid)), { code: 'BAD_DEPENDENCIES' });
  const valid = parseManifest(parsed({
    c: { depends_on: ['a', 'b'], inputs: [
      { job: 'a', report: true },
      { job: 'b', report: true, artifacts: ['out/report.md'] },
    ] },
  }));
  assert.deepEqual(valid.jobs.find(j => j.id === 'c').depends_on, ['a', 'b']);

  // runBatch validates the graph before config reads, workspace canonicalization
  // or child admission, so malformed edges cannot launch an independent sibling.
  const { f, manifestFile, out } = await batchFixture(t, [job({ id: 'a', cwd: a, file: path.join(a, 'o.md') })]);
  const badManifest = path.join(f.root, 'bad-batch.json');
  await fs.writeFile(badManifest, JSON.stringify(parsed({ c: { depends_on: ['c'], inputs: [{ job: 'c', report: true }] } })));
  let reads = 0, launches = 0;
  await assert.rejects(runBatch({
    config: { configPath: f.configFile }, opt: { manifest: badManifest },
    deps: { loadConfig: async () => { reads++; return f.config; }, spawnJob: () => { launches++; throw new Error('must not launch'); } },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  }), { code: 'BAD_DEPENDENCIES' });
  assert.deepEqual({ reads, launches }, { reads: 0, launches: 0 });
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
  assert.equal(code, 0, JSON.stringify({
    status: out.at(-1)?.status, blocked: out.at(-1)?.blocked,
    waiting: out.at(-1)?.waiting, missing: out.at(-1)?.missing,
    jobs: out.at(-1)?.jobs?.map(j => ({ id: j.id, problem: j.delivery_problem, runtime: j.runtime_status })),
  }));
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

test('A/B predecessors bind exact reports into C while slow unrelated D keeps running', async t => {
  const base = await jobRoot(t);
  const cwd = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, path.join(base, id)]));
  const jobs = Object.entries(cwd).map(([id, dir]) => job({ id, cwd: dir, file: path.join(dir, 'o.md') }));
  const { f, manifestFile, out, state } = await batchFixture(t, jobs, { maxConcurrency: 3 });
  const spawned = [];
  const byId = new Map();
  const spawner = fakeSpawner(state, {
    stateDir: f.config.stateDir,
    delays: { a: 40, b: 60, c: 20, d: 500 },
    block: ({ id }) => id === 'a'
      ? { status: 'ready', summary: 'A exact report', criteria: [], checks: [], artifacts: [], questions: [], decision_impacts: [{ target: 'A target', finding: 'A finding', consequence: 'A consequence', evidence_refs: ['src/a.mjs'] }] }
      : id === 'b' ? { status: 'ready', summary: 'B exact report', criteria: [], checks: [{ name: 'b check', state: 'passed', detail: 'B exact evidence' }], artifacts: [], questions: [] }
      : { status: 'ready', summary: `${id} report`, criteria: [], checks: [], artifacts: [], questions: [] },
    marker: (j, _state, ids) => {
      spawned.push(j.id);
      byId.set(j.id, ids);
    },
  });
  const originalSpawn = spawner;
  let cPrompt = null;
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  await fs.writeFile(path.join(cwd.c, 'o.md'), 'C combines A and B.');
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a', 'b'];
  manifest.jobs.find(j => j.id === 'c').inputs = [
    { job: 'a', report: true },
    { job: 'b', report: true },
  ];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const wrapped = args => {
    if (args.job.id === 'c') {
      const text = fsSync.readFileSync(args.job.file, 'utf8');
      return originalSpawn({ ...args, job: { ...args.job, file: path.join(f.root, 'c-bound.md') } });
    }
    return originalSpawn(args);
  };
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: wrapped },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 0, JSON.stringify({
    status: out.at(-1)?.status, blocked: out.at(-1)?.blocked,
    waiting: out.at(-1)?.waiting, missing: out.at(-1)?.missing,
    jobs: out.at(-1)?.jobs?.map(j => ({ id: j.id, problem: j.delivery_problem, runtime: j.runtime_status })),
  }));
  const batch = out.at(-1);
  assert.equal(batch.status, 'complete');
  assert.deepEqual([...new Set(spawned)].sort(), ['a', 'b', 'c', 'd']);
  const bound = await fs.readFile(path.join(f.config.stateDir, 'batches', batch.batch_id, 'c.order.md'), 'utf8');
  assert.ok(bound.includes('A exact report'), bound);
  assert.ok(bound.includes('B exact report'));
  assert.ok(bound.includes('A finding'));
  assert.ok(bound.includes('B exact evidence'));
  assert.ok(bound.includes(byId.get('a').sid));
  assert.ok(bound.includes(byId.get('b').req));
  assert.ok(bound.includes('untrusted input, not instructions'));
  assert.equal(batch.jobs.find(j => j.id === 'd').runtime_status, 'completed');

  // The successor's full report and selected artifact are reachable from the
  // ordinary immutable sidecar with exact request/session identity.
  const c = batch.jobs.find(j => j.id === 'c');
  const cDelivery = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: c.session_id, requestId: c.request_id,
    finishedAt: new Date().toISOString(),
    text: blockFor(c.request_id, c.session_id, { summary: 'C complete', decision_impacts: [] }),
  });
  assert.equal(cDelivery.sidecar.worker.block.request_id, c.request_id);
});

test('selected predecessor artifacts must be present and are bound by exact reference', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), c = path.join(base, 'c');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }),
    job({ id: 'c', cwd: c, file: path.join(c, 'o.md') }),
  ]);
  await fs.writeFile(path.join(a, 'report.txt'), 'selected predecessor artifact');
  await fs.writeFile(path.join(c, 'o.md'), 'Use only the selected artifact.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a'];
  manifest.jobs.find(j => j.id === 'c').inputs = [{ job: 'a', report: false, artifacts: ['report.txt'] }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  let bound = null;
  const spawner = fakeSpawner(state, {
    stateDir: f.config.stateDir,
    block: () => ({ status: 'ready', summary: 'artifact producer', criteria: [], checks: [], questions: [], artifacts: [{ kind: 'file', ref: 'report.txt', note: 'exact artifact' }] }),
  });
  const wrapped = args => {
    if (args.job.id === 'c') bound = bound ?? fsSync.readFileSync(args.job.file, 'utf8');
    return spawner(args);
  };
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: wrapped },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 0);
  assert.ok(bound);
  assert.ok(bound.includes('"report": null'));
  assert.ok(bound.includes('"ref": "report.txt"'));
  assert.ok(bound.includes('"status": "present"'));
});

test('explicit dependencies can order continuations of the same existing session', () => {
  const session = randomUUID();
  const manifest = { schema: MANIFEST_SCHEMA, jobs: [
    { id: 'b', verb: 'continue', session, cwd: '/abs/ws', file: '/abs/b.md', permissions: 'read' },
    {
      id: 'c', verb: 'continue', session, cwd: '/abs/ws', file: '/abs/c.md', permissions: 'read',
      depends_on: ['b'], inputs: [{ job: 'b', report: true }],
    },
  ] };
  const parsed = parseManifest(manifest);
  assert.deepEqual(parsed.jobs.find(j => j.id === 'c').depends_on, ['b']);
  assert.equal(parsed.jobs.find(j => j.id === 'c').session, session);
  const indirect = { schema: MANIFEST_SCHEMA, jobs: [
    { id: 'b', verb: 'continue', session, cwd: '/abs/ws', file: '/abs/b.md', permissions: 'read' },
    { id: 'c', verb: 'continue', session, cwd: '/abs/ws', file: '/abs/c.md', permissions: 'read',
      depends_on: ['a'], inputs: [{ job: 'a', report: true }] },
    { id: 'a', verb: 'run', route: 'worker', cwd: '/abs/a', file: '/abs/a.md', permissions: 'read',
      depends_on: ['b'], inputs: [{ job: 'b', report: true }] },
  ] };
  assert.deepEqual(parseManifest(indirect).jobs.find(j => j.id === 'c').depends_on, ['a']);
});

test('an unavailable selected predecessor artifact blocks the successor instead of substituting it', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), c = path.join(base, 'c');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }),
    job({ id: 'c', cwd: c, file: path.join(c, 'o.md') }),
  ]);
  await fs.writeFile(path.join(c, 'o.md'), 'Use the missing artifact.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a'];
  manifest.jobs.find(j => j.id === 'c').inputs = [{ job: 'a', artifacts: ['never-created.txt'] }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  let launchedC = false;
  const spawner = fakeSpawner(state, {
    stateDir: f.config.stateDir,
    block: () => ({ status: 'ready', summary: 'artifact producer', criteria: [], checks: [], questions: [], artifacts: [{ kind: 'file', ref: 'never-created.txt', note: 'declared but absent' }] }),
  });
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: args => { if (args.job.id === 'c') launchedC = true; return spawner(args); } },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.equal(launchedC, false);
  assert.equal(out.at(-1).blocked.find(x => x.id === 'c')?.code, 'PREDECESSOR_ARTIFACT_UNAVAILABLE');
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

test('a malformed predecessor report cannot satisfy a successor', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), c = path.join(base, 'c');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }),
    job({ id: 'c', cwd: c, file: path.join(c, 'o.md') }),
  ]);
  await fs.writeFile(path.join(c, 'o.md'), 'Must not receive a malformed predecessor.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a'];
  manifest.jobs.find(j => j.id === 'c').inputs = [{ job: 'a', report: true }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  let launchedC = false;
  const spawner = fakeSpawner(state, {
    stateDir: f.config.stateDir,
    block: () => ({ status: 'ready', summary: 'bad', criteria: [], checks: [], artifacts: [], questions: [], extra: 'rejected' }),
  });
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: args => { if (args.job.id === 'c') launchedC = true; return spawner(args); } },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  assert.equal(launchedC, false);
  assert.equal(out.at(-1).blocked.find(x => x.id === 'c')?.code, 'PREDECESSOR_DELIVERY_MALFORMED');
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

// The REAL child double must canonicalize its cwd EXACTLY as the batch parent
// does. The parent uses `node:fs/promises`.realpath (the native resolver, which
// also expands Windows 8.3 short names and case aliases); the double must not
// fall back to the `node:fs` JS walk, which only strips symlinks and keeps the
// lexical alias. Windows temporary paths may contain 8.3 short components;
// a case-only alias reproduces this identity mismatch on a case-insensitive
// filesystem without depending on the host's temporary path spelling.
test('the real child double canonicalizes an aliased cwd exactly like the batch parent', async t => {
  if (!(await caseInsensitiveFs())) return t.skip('case-sensitive filesystem: no alias to resolve');
  const base = await jobRoot(t);
  const realDir = path.join(base, 'WorkSpace');
  await fs.mkdir(realDir, { recursive: true });
  const aliasCwd = path.join(base, 'workspace'); // same directory, aliased case
  const order = path.join(realDir, 'o.md');
  const { f, manifestFile, out } = await batchFixture(t, [job({ id: 'n', cwd: aliasCwd, file: order, deliver: false })]);
  await fs.writeFile(order, 'flood-stderr');
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-noisy-child.mjs');
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config }, // REAL spawnJob
    output: r => out.push(r), text: () => {}, cliPath,
  });
  const batch = out.at(-1);
  const j = batch.jobs[0];
  assert.equal(j.handle_mismatch, false, 'an aliased cwd is not an identity mismatch');
  assert.ok(j.start_handle, 'the published handle still matches');
  assert.equal(j.runtime_status, 'completed');
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
  // The DEFAULT terminal keeps the full legacy excerpt AND every full field, so
  // existing consumers lose nothing.
  assert.deepEqual(ex.criteria, { total: 2, unsatisfied: 1, unsatisfied_list: ['decide which contract wins'], unsatisfied_truncated: [false] });
  assert.equal(ex.checks.total, 2);
  assert.deepEqual(ex.checks.by_state, { passed: 1, blocked: 1 });
  assert.deepEqual(ex.checks.failing, ['contract probe']);
  assert.deepEqual(ex.questions, ['Which of the two conflicting contracts should win?']);
  assert.deepEqual(ex.questions_truncated, [false]);
  assert.equal(ex.questions_total, 1);
  assert.deepEqual(j.delivery_questions, ['Which of the two conflicting contracts should win?']);
  assert.ok(Array.isArray(j.artifact_references), 'the legacy artifact_references field is preserved');
  const compact = await collectBatchCompact({ config: { stateDir: f.config.stateDir }, batchId: out.at(-1).batch_id });
  const citem = compact.items.find(r => r.id === 'a');
  assert.equal(citem.detail, 'full');
  const cex = citem.delivery_excerpt;
  assert.equal(cex.source, 'worker_reported');
  assert.deepEqual(cex.criteria, { total: 2, unsatisfied: 1, unsatisfied_list: ['decide which contract wins'], unsatisfied_truncated: [false] });
  assert.equal(cex.checks.total, 2);
  assert.deepEqual(cex.checks.by_state, { passed: 1, blocked: 1 });
  assert.deepEqual(cex.checks.failing, ['contract probe']);
  assert.deepEqual(cex.checks.evidence, [
    { name: 'contract probe', name_truncated: false, state: 'blocked', detail: 'needs a decision', detail_truncated: false },
    { name: 'npm run check', name_truncated: false, state: 'passed', detail: 'all green', detail_truncated: false },
  ]);
  assert.deepEqual(cex.questions, ['Which of the two conflicting contracts should win?']);
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
  assert.equal(ex.omitted.questions, 1);
  // The legacy full question list is still present on the default terminal.
  assert.deepEqual(out.at(-1).jobs[0].delivery_questions, ['q1', 'q2', 'q3', 'q4', 'q5']);
  // The compact read clips the same way and never expands long text.
  const compact = await collectBatchCompact({ config: { stateDir: f.config.stateDir }, batchId: out.at(-1).batch_id });
  const cex = compact.items[0].delivery_excerpt;
  assert.equal(cex.summary.length, 400);
  assert.equal(cex.summary_truncated, true);
  assert.equal(cex.questions.length, 4);
  assert.equal(cex.questions_total, 5);
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

test('persistent index rename denial still closes admission before the next job', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), b = path.join(base, 'b');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md'), deliver: false }),
    job({ id: 'b', cwd: b, file: path.join(b, 'o.md'), deliver: false }),
  ]);
  const originalRename = fs.rename;
  t.after(() => { fs.rename = originalRename; });
  fs.rename = async (from, to) => {
    if (path.basename(to) === 'index.json') {
      const record = JSON.parse(await fs.readFile(from, 'utf8'));
      if (record.jobs.length) throw Object.assign(new Error('persistent synthetic index denial'), { code: 'EPERM' });
    }
    return originalRename(from, to);
  };
  let starts = 0;
  const spawn = fakeSpawner(state, { stateDir: f.config.stateDir });
  const code = await run(f, manifestFile, out, args => { starts++; return spawn(args); });
  assert.equal(code, 1);
  assert.equal(starts, 1, 'persistent index denial must not admit the second job');
  assert.equal(out.at(-1).status, 'partial');
  assert.equal(out.at(-1).index_warning, 'EPERM');
  assert.deepEqual(out.at(-1).missing, ['b']);
});

test('settled results publish to the index mid-batch and collect reads them without waiting', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const cwdB = path.join((await jobRoot(t)), 'b');
  const { f, manifestFile, out } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md') }),
    job({ id: 'b', cwd: cwdB, file: path.join(cwdB, 'o.md') }),
  ]);
  // The batch id comes from its OWN published start handle, not a scan of the
  // private state directory.
  const startHandle = path.join(f.root, 'batch.handle.json');
  const p = runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile, 'start-handle': startHandle },
    deps: { loadConfig: async () => f.config, spawnJob: fakeSpawner({ active: 0, maxActive: 0 }, { stateDir: f.config.stateDir, delays: { a: 10, b: 600 } }) },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  let mid = null;
  let batchId = null;
  for (let i = 0; i < 160 && !mid; i++) {
    if (!batchId) {
      try { batchId = JSON.parse(await fs.readFile(startHandle, 'utf8')).batch_id; } catch { /* not published yet */ }
    }
    if (batchId) {
      try {
        const idx = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), 'utf8'));
        if (idx.results?.some(r => r.id === 'a')) {
          assert.ok(!idx.results.some(r => r.id === 'b'), 'the slow job must not have settled yet');
          mid = idx;
        }
      } catch { /* retry while the index is being replaced */ }
    }
    if (!mid) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(mid, 'the settled fast job must appear in the index while the batch is still running');
  if (mid.status !== 'running') await p;
  const terminal = out.at(-1);
  assert.equal(mid.status, 'running', JSON.stringify({
    mid_status: mid.status, result_ids: mid.results.map(r => r.id),
    terminal_status: terminal?.status, index_warning: terminal?.index_warning,
    admission_error: terminal?.admission_error, missing: terminal?.missing,
    cancelled: terminal?.cancelled,
  }));
  assert.equal(mid.total, 2, 'the index carries the full batch size before every job settles');
  // The settling job's own handle is captured synchronously during collection;
  // the still-running job's handle arrives via its own poll, so it may lag.
  assert.ok(mid.jobs.some(j => j.id === 'a' && j.start_handle), 'the settled job publishes its start handle');
  const midA = mid.results.find(r => r.id === 'a');
  assert.equal(midA.delivery_excerpt.summary, 'ok');
  assert.equal(await p, 0);
  // collectBatch is a read-only view over the final index.
  assert.equal(batchId, out.at(-1).batch_id, 'the published handle names the same batch the batch reports');
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

// --- Initial batch handle, compact read and identity expansion -----------------

test('batch --start-handle publishes the batch id before any launch', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md'), deliver: false }),
  ]);
  const startHandle = path.join(f.root, 'batch.handle.json');
  let handleAtFirstSpawn = null, indexAtFirstSpawn = null;
  const baseSpawn = fakeSpawner(state, { stateDir: f.config.stateDir });
  const spawner = args => {
    if (handleAtFirstSpawn === null) {
      // The spawner is called synchronously right before a child is launched:
      // both the handle and the initial index must already be on disk.
      handleAtFirstSpawn = JSON.parse(fsSync.readFileSync(startHandle, 'utf8'));
      indexAtFirstSpawn = JSON.parse(fsSync.readFileSync(handleAtFirstSpawn.index_path, 'utf8'));
    }
    return baseSpawn(args);
  };
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile, 'start-handle': startHandle },
    deps: { loadConfig: async () => f.config, spawnJob: spawner },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 0);
  const handle = JSON.parse(await fs.readFile(startHandle, 'utf8'));
  assert.equal(handle.schema, 'cwr.acp.batch-handle/1');
  assert.equal(handle.batch_id, out.at(-1).batch_id);
  assert.equal(handle.total, 1);
  assert.ok(handle.index_path.endsWith('index.json'));
  // The handle (and the initial index) existed with the SAME id before the first
  // child launch, so no caller has to guess the id from the state directory.
  assert.ok(handleAtFirstSpawn, 'the handle exists before any launch');
  assert.equal(handleAtFirstSpawn.batch_id, handle.batch_id);
  assert.equal(handleAtFirstSpawn.status, 'running');
  assert.equal(indexAtFirstSpawn.batch_id, handle.batch_id);
  assert.equal(indexAtFirstSpawn.status, 'running');
  assert.deepEqual(indexAtFirstSpawn.planned, ['a']);
  assert.deepEqual(indexAtFirstSpawn.results, []);
});

test('a failed batch start-handle write aborts before any child launches', async t => {
  const cwdA = path.join((await jobRoot(t)), 'a');
  const { f, manifestFile, state } = await batchFixture(t, [
    job({ id: 'a', cwd: cwdA, file: path.join(cwdA, 'o.md'), deliver: false }),
  ]);
  // A directory at the handle path cannot be atomically replaced.
  const handleDir = path.join(f.root, 'handle-as-dir');
  await fs.mkdir(handleDir, { mode: 0o700 });
  let spawned = 0;
  await assert.rejects(runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile, 'start-handle': handleDir },
    deps: { loadConfig: async () => f.config, spawnJob: () => { spawned++; return { done: Promise.resolve({}), stop: () => {} }; } },
    output: () => {}, text: () => {}, cliPath: 'cli.mjs',
  }), { code: 'UNSAFE_FILE' });
  assert.equal(spawned, 0, 'an unaddressable batch must launch nothing');
  // Inspect only this synthetic failed-start fixture, which owns one index;
  // successful callers obtain identity through the public handle instead.
  const batchIds = await fs.readdir(path.join(f.config.stateDir, 'batches'));
  assert.equal(batchIds.length, 1);
  const index = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'batches', batchIds[0], 'index.json'), 'utf8'));
  assert.equal(index.status, 'partial', 'failed startup must not leave a running index');
  assert.deepEqual(index.missing, ['a']);
});

const compactResult = (id, summary, rev = 1) => ({
  id, session_id: randomUUID(), request_id: randomUUID(), route: 'worker',
  rev,
  start_handle: null, handle_mismatch: false, runtime_status: 'completed', cleanup: 'confirmed',
  receipt_path: `/receipts/${id}.json`, exit_code: 0, output_received: true,
  output_truncated: false, stderr_truncated: false, error_code: null,
  delivery_status: 'ready', delivery_questions: ['q'.repeat(8)], artifact_references: [],
  delivery_problem: null, next_actions: [],
  delivery_excerpt: {
    source: 'worker_reported', summary, summary_truncated: false,
    criteria: { total: 0, unsatisfied: 0, unsatisfied_list: [] },
    checks: { total: 0, by_state: {}, failing: [], evidence: [] },
    questions: [], questions_total: 0, omitted: {},
  },
});

test('compact collect pages by change cursor, distinguishes recorded-handle/awaiting-handle/missing and rejects bad cursors', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const batchId = randomUUID(), otherId = randomUUID();
  const cfg = { stateDir: f.config.stateDir };
  const indexFor = over => ({
    schema: 'cwr.acp.batch-index/1', batch_id: batchId, status: 'running', revision: 2,
    started_at: new Date().toISOString(), total: 4, planned: ['j0', 'j1', 'j2', 'j3'],
    jobs: [{ id: 'j2', start_handle: { session_id: randomUUID(), request_id: randomUUID() } }],
    results: [compactResult('j0', 's0', 1), compactResult('j1', 's1', 2)], ...over,
  });
  await atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), indexFor());
  await atomicJSON(path.join(f.config.stateDir, 'batches', otherId, 'index.json'), indexFor({ batch_id: otherId }));

  // Page 1 (item limit): j0 only, more to come, running/not-started classified.
  const p1 = await collectBatchCompact({ config: cfg, batchId, limit: 1 });
  assert.equal(p1.schema, 'cwr.acp.batch-collect-compact/1');
  assert.equal(p1.changed, true);
  assert.equal(p1.items.length, 1);
  assert.equal(p1.items[0].id, 'j0');
  assert.equal(p1.page.has_more, true);
  assert.equal(p1.page.limited_by, 'limit');
  assert.deepEqual(p1.unresolved.running, ['j2']);
  assert.deepEqual(p1.unresolved.awaiting_handle, ['j3']);
  assert.deepEqual(p1.unresolved.missing, []);
  assert.equal(p1.unresolved.terminal, false);
  assert.ok(p1.budget.used_bytes <= p1.budget.max_bytes);

  // Page 2 via the issued cursor: the remaining settled item, then no change.
  const p2 = await collectBatchCompact({ config: cfg, batchId, limit: 1, cursor: p1.next_cursor });
  assert.equal(p2.changed, true);
  assert.deepEqual(p2.items.map(i => i.id), ['j1']);
  assert.equal(p2.page.has_more, false);
  const p3 = await collectBatchCompact({ config: cfg, batchId, limit: 1, cursor: p2.next_cursor });
  assert.equal(p3.changed, false, 'no change since the cursor must not re-transfer results');
  assert.deepEqual(p3.items, []);

  // A later revision: the SAME cursor returns ONLY the newly settled item.
  await atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'),
    indexFor({ status: 'complete', revision: 3, results: [compactResult('j0', 's0', 1), compactResult('j1', 's1', 2), compactResult('j2', 's2', 3)], jobs: [], missing: ['j3'] }));
  const p4 = await collectBatchCompact({ config: cfg, batchId, limit: 5, cursor: p2.next_cursor });
  assert.deepEqual(p4.items.map(i => i.id), ['j2']);
  assert.equal(p4.unresolved.terminal, true);
  assert.deepEqual(p4.unresolved.missing, ['j3']);
  assert.deepEqual(p4.unresolved.running, []);
  assert.deepEqual(p4.unresolved.awaiting_handle, []);

  // A small result set still fits one page in the default budget.
  const onePage = await collectBatchCompact({ config: cfg, batchId, limit: 32 });
  assert.equal(onePage.page.has_more, false);
  assert.equal(onePage.items.length, 3);

  // Cursor rejections: cross-batch, malformed, future revision, out of range.
  await assert.rejects(collectBatchCompact({ config: cfg, batchId: otherId, cursor: p4.next_cursor }), { code: 'CROSS_BATCH_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: 'not-a-cursor' }), { code: 'BAD_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: encodeTestCursor({ v: 1, b: batchId, r: 999, o: 0 }) }), { code: 'FUTURE_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: encodeTestCursor({ v: 1, b: batchId, r: 3, o: 99 }) }), { code: 'CURSOR_OUT_OF_RANGE' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: encodeTestCursor({ v: 2, b: batchId, r: 3, o: 0 }) }), { code: 'BAD_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: encodeTestCursor({ v: 1, b: batchId, r: 3, o: 0, x: 1 }) }), { code: 'BAD_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, cursor: `${p4.next_cursor}=` }), { code: 'BAD_CURSOR' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, maxBytes: 128 }), { code: 'BAD_BUDGET' });
  await assert.rejects(collectBatchCompact({ config: cfg, batchId, limit: 0 }), { code: 'BAD_LIMIT' });

  // Mentioning a planned-but-unsettled job vs truly missing is distinct.
  await assert.rejects(collectBatchJob({ config: cfg, batchId, jobId: 'j9' }), { code: 'JOB_NOT_FOUND' });
  const full = await collectBatchJob({ config: cfg, batchId, jobId: 'j2' });
  assert.equal(full.schema, 'cwr.acp.batch-job/1');
  assert.deepEqual(full.job.delivery_questions, ['q'.repeat(8)]);
});

test('a 32-job maximal-delivery batch stays bounded at the public CLI and expands in full', async t => {
  const base = await jobRoot(t);
  const jobs = [];
  for (let i = 0; i < 32; i++) {
    const cwd = path.join(base, `j${i}`);
    jobs.push(job({ id: `j${String(i).padStart(2, '0')}`, cwd, file: path.join(cwd, 'o.md') }));
  }
  const { f, manifestFile, out, state } = await batchFixture(t, jobs, { maxConcurrency: 8 });
  // Each block is a legal delivery: 32 questions of 1800 chars + a long artifact
  // note, still under the 64 KiB delivery-block bound.
  const big = () => ({
    status: 'ready', summary: 'bulk delivery', criteria: [], checks: [],
    questions: Array.from({ length: 32 }, () => 'Q'.repeat(1800)),
    artifacts: [{ kind: 'file', ref: 'absent.txt', note: 'N'.repeat(1000) }],
  });
  const code = await run(f, manifestFile, out, fakeSpawner(state, { stateDir: f.config.stateDir, block: big }));
  assert.equal(code, 0);
  const batch = out.at(-1);
  assert.equal(batch.status, 'complete');
  assert.equal(batch.job_count, 32);

  // DEFAULT terminal = the FULL legacy receipt: the old fields are not lost.
  const first = batch.jobs.find(j => j.id === 'j00');
  assert.equal(first.delivery_questions.length, 32, 'the legacy full question list is preserved');
  assert.equal(first.delivery_questions[0].length, 1800);
  assert.ok(Array.isArray(first.artifact_references), 'the legacy artifact_references field is preserved');
  assert.equal(first.artifact_references[0].note.length, 1000);
  assert.equal(first.delivery_excerpt.questions_total, 32, 'the legacy excerpt total is preserved');

  // The REAL CLI compact read respects the byte budget and pages over all 32.
  const budget = 16 * 1024;
  const seen = new Map();
  let cursor = null, pages = 0, resp = null;
  for (;;) {
    const args = ['collect', '--config', f.configFile, '--batch', batch.batch_id, '--compact', '--max-bytes', String(budget), '--limit', '32'];
    if (cursor) args.push('--cursor', cursor);
    const r = await runCli(args);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout) <= budget, `page ${pages} stdout ${Buffer.byteLength(r.stdout)} must be within ${budget}`);
    resp = JSON.parse(r.stdout);
    assert.equal(resp.schema, 'cwr.acp.batch-collect-compact/1');
    assert.equal(resp.budget.max_bytes, budget);
    assert.ok(resp.budget.used_bytes <= budget, 'the self-reported size must fit the budget');
    for (const item of resp.items) seen.set(item.id, item);
    pages++;
    if (!resp.page.has_more) break;
    cursor = resp.next_cursor;
    assert.ok(pages <= 32, 'pagination must terminate');
  }
  assert.equal(seen.size, 32, 'paging reaches every settled job');
  assert.equal(resp.unresolved.missing.length, 0);
  assert.equal(resp.unresolved.terminal, true);
  // The compact read (not the terminal) carries the bounded short evidence.
  const compactFirst = seen.get('j00');
  assert.equal(compactFirst.delivery_excerpt.source, 'worker_reported');
  assert.equal(compactFirst.delivery_excerpt.questions_total, 32);
  assert.equal(compactFirst.delivery_excerpt.questions.length, 4);
  assert.equal(compactFirst.delivery_excerpt.questions[0].length, 300);
  assert.equal(compactFirst.artifacts.total, 1);
  assert.equal(compactFirst.artifacts.notable[0].note.length, 120);
  assert.equal(compactFirst.artifacts.notable[0].note_truncated, true);

  // Full expansion by job identity, then by session/request sidecar.
  const expanded = await runCli(['collect', '--config', f.configFile, '--batch', batch.batch_id, '--job', 'j00']);
  assert.equal(expanded.code, 0, expanded.stderr);
  const jobFull = JSON.parse(expanded.stdout).job;
  assert.equal(jobFull.delivery_questions.length, 32);
  assert.equal(jobFull.delivery_questions[0].length, 1800);
  assert.equal(jobFull.artifact_references[0].observed.status, 'missing');
  const side = await runCli(['delivery', '--config', f.configFile, '--session', jobFull.session_id, '--request', jobFull.request_id, '--json']);
  assert.equal(side.code, 0, side.stderr);
  const sidecar = JSON.parse(side.stdout);
  assert.equal(sidecar.worker.block.questions.length, 32);
  assert.equal(sidecar.worker.block.questions[0].length, 1800);

  // A caller requesting a compact budget must never receive an unbounded job
  // expansion because conflicting view options were silently ignored.
  for (const view of [['--compact'], ['--cursor', cursor], ['--limit', '1'], ['--max-bytes', '8192']]) {
    const conflict = await runCli(['collect', '--config', f.configFile, '--batch', batch.batch_id, '--job', 'j00', ...view]);
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, /cannot be combined/);
  }

  // --compact-only options without --compact are a usage error, not silent.
  const misuse = await runCli(['collect', '--config', f.configFile, '--batch', batch.batch_id, '--limit', '1']);
  assert.equal(misuse.code, 2);
  assert.match(misuse.stderr, /require --compact/);
  const batchMisuse = await runCli(['batch', '--config', f.configFile, '--manifest', path.join(f.root, 'missing.json'), '--limit', '2']);
  assert.equal(batchMisuse.code, 2);
  assert.match(batchMisuse.stderr, /require --compact/);
});

test('batch --compact keeps the whole terminal (metadata included) within budget and pages to every job', async t => {
  const base = await jobRoot(t);
  const jobs = [];
  for (let i = 0; i < 32; i++) {
    const cwd = path.join(base, `c${i}`);
    jobs.push(job({ id: `k${String(i).padStart(2, '0')}`, cwd, file: path.join(cwd, 'o.md') }));
  }
  const { f, manifestFile, out, state } = await batchFixture(t, jobs, { maxConcurrency: 8 });
  const big = () => ({
    status: 'ready', summary: 'bulk delivery', criteria: [], checks: [],
    questions: Array.from({ length: 32 }, () => 'Q'.repeat(1800)),
    artifacts: [{ kind: 'file', ref: 'absent.txt', note: 'N'.repeat(1000) }],
  });
  const budget = 16 * 1024;
  const code = await runBatch({
    config: { configPath: f.configFile },
    opt: { manifest: manifestFile, compact: true, limit: '32', 'max-bytes': String(budget) },
    deps: { loadConfig: async () => f.config, spawnJob: fakeSpawner(state, { stateDir: f.config.stateDir, block: big }) },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 0);
  const page = out.at(-1);
  assert.equal(page.schema, 'cwr.acp.batch-collect-compact/1');
  assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= budget, 'the whole compact terminal, metadata included, fits the budget');
  assert.equal(page.batch.admission_scope, 'batch_local_only');
  assert.ok(page.batch.index_path.endsWith('index.json'));
  assert.equal(page.batch.cancelled, false);
  assert.equal(page.status, 'complete');
  assert.ok(page.page.returned >= 1, 'the compact terminal returns at least one locatable item');
  assert.equal(page.items[0].detail, 'full');
  // Continue with the issued cursor until every settled job is covered.
  const seen = new Set(page.items.map(i => i.id));
  let cursor = page.next_cursor, lastOffset = page.page.next_offset, guard = 0, resp = page;
  while (resp.page.has_more) {
    resp = await collectBatchCompact({ config: { stateDir: f.config.stateDir }, batchId: page.batch_id, cursor, limit: 32, maxBytes: budget });
    assert.ok(Buffer.byteLength(JSON.stringify(resp)) + 1 <= budget, 'every continuation page fits the budget');
    assert.ok(resp.page.next_offset > lastOffset, 'each page makes forward progress');
    lastOffset = resp.page.next_offset;
    for (const item of resp.items) seen.add(item.id);
    cursor = resp.next_cursor;
    guard++;
    assert.ok(guard <= 32, 'pagination terminates');
  }
  assert.equal(seen.size, 32, 'the compact terminal plus cursors reach every job');
  assert.equal(resp.unresolved.missing.length, 0);
});

test('compact collect advances under the minimum budget by degrading the optional excerpt, never stalling', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const batchId = randomUUID(), sid = randomUUID(), req = randomUUID();
  const cfg = { stateDir: f.config.stateDir };
  // A LEGAL delivery (real normalizeDelivery via writeDeliverySidecar) whose
  // Chinese text makes the full short-evidence projection exceed 8 KiB.
  const zh = n => '汉'.repeat(n);
  const block = {
    status: 'ready', summary: zh(400),
    criteria: Array.from({ length: 8 }, () => ({ criterion: zh(160), state: 'unsatisfied' })),
    checks: Array.from({ length: 6 }, () => ({ name: zh(120), state: 'failed', detail: zh(200) })),
    questions: Array.from({ length: 4 }, () => zh(300)),
    artifacts: Array.from({ length: 6 }, () => ({ kind: 'file', ref: zh(200), note: zh(120) })),
  };
  const text = '```cwr-delivery\n' + JSON.stringify({ schema: 'cwr.acp.delivery/1', ...block, request_id: req, session_id: sid }) + '\n```';
  assert.ok(Buffer.byteLength(text, 'utf8') < 64 * 1024, 'the counterexample block is a legal delivery');
  const { sidecar } = await writeDeliverySidecar({ stateDir: f.config.stateDir, session: sid, requestId: req, finishedAt: new Date().toISOString(), text });
  assert.equal(sidecar.worker.status, 'ready');
  const result = {
    id: 'zh', rev: 1, session_id: sid, request_id: req, route: 'worker',
    start_handle: { session_id: sid, request_id: req, phase: 'locks_held' }, handle_mismatch: false,
    runtime_status: 'completed', cleanup: 'confirmed', receipt_path: null, exit_code: 0,
    output_received: true, output_truncated: false, stderr_truncated: false, error_code: null,
    delivery_status: 'ready', delivery_questions: sidecar.worker.block.questions,
    artifact_references: sidecar.worker.block.artifacts.map(a => ({ ...a, observed: { status: 'unknown' } })),
    delivery_problem: null, delivery_excerpt: deliveryExcerpt(sidecar.worker.block), next_actions: [],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(projectResult(result, { detail: 'full' }))) > COMPACT_MIN_BYTES, 'the full evidence projection exceeds the minimum budget');
  await atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), {
    schema: 'cwr.acp.batch-index/1', batch_id: batchId, status: 'complete', revision: 1,
    started_at: new Date().toISOString(), total: 1, planned: ['zh'], jobs: [], results: [result], missing: [],
  });
  const page = await collectBatchCompact({ config: cfg, batchId, limit: 2, maxBytes: COMPACT_MIN_BYTES });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) + 1 <= COMPACT_MIN_BYTES, 'the whole response respects the minimum budget');
  assert.equal(page.items.length, 1, 'the minimum budget still returns a locatable item');
  assert.ok(page.page.next_offset >= 1, 'the page advances, never a zero-progress page');
  const item = page.items[0];
  assert.ok(['full', 'reduced', 'minimal'].includes(item.detail));
  assert.notEqual(item.detail, 'full', 'the optional evidence was reduced to fit the minimum budget');
  // Identity, status, counts and expansion survive every reduction tier.
  assert.equal(item.id, 'zh');
  assert.equal(item.delivery_status, 'ready');
  assert.equal(item.expand.session_id, sid);
  assert.equal(item.expand.request_id, req);
  assert.equal(item.delivery_questions_total, 4);
  if (item.detail === 'reduced') {
    assert.equal(item.delivery_excerpt.source, 'worker_reported');
    assert.equal(item.delivery_excerpt.criteria.unsatisfied, 8);
    assert.equal(item.delivery_excerpt.checks.by_state.failed, 6);
    assert.ok(item.delivery_excerpt.omitted_fields.includes('checks.evidence'), 'dropped fields are named, not silently lost');
  }
  // The continuation reads PAST this item (no stall on the same offset).
  const next = await collectBatchCompact({ config: cfg, batchId, cursor: page.next_cursor, limit: 2, maxBytes: COMPACT_MIN_BYTES });
  assert.ok(next.page.next_offset >= page.page.next_offset);
  assert.equal(next.changed, false);
});

test('a compact cursor re-delivers a SAME-ID result update instead of silently missing it', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const batchId = randomUUID();
  const cfg = { stateDir: f.config.stateDir };
  const rec = (summary, status, rev) => ({
    ...compactResult('one', summary, rev), delivery_status: status,
  });
  const write = over => atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), {
    schema: 'cwr.acp.batch-index/1', batch_id: batchId, status: 'running', revision: 1,
    started_at: new Date().toISOString(), total: 1, planned: ['one'], jobs: [],
    results: [rec('first', 'ready', 1)], missing: null, ...over,
  });
  await write();
  const first = await collectBatchCompact({ config: cfg, batchId, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].delivery_excerpt.summary, 'first');
  // The SAME job id, the SAME results.length, but NEW content and a higher
  // revision — a late settlement / reconciliation, not an append.
  await write({ revision: 2, results: [rec('updated', 'needs_input', 2)], status: 'complete', missing: [] });
  const after = await collectBatchCompact({ config: cfg, batchId, limit: 5, cursor: first.next_cursor });
  assert.equal(after.revision, 2);
  assert.equal(after.changed, true, 'an in-place update must not be reported as unchanged');
  assert.deepEqual(after.items.map(i => i.id), ['one']);
  assert.equal(after.items[0].delivery_excerpt.summary, 'updated');
  assert.equal(after.items[0].delivery_status, 'needs_input');
  assert.equal(after.items[0].rev, 2, 'the consumer can merge replayed items by their publication revision');
  // A cursor from before the update never overwrites the newer state.
  const stale = await collectBatchCompact({ config: cfg, batchId, limit: 5, cursor: first.next_cursor });
  assert.equal(stale.items[0].delivery_excerpt.summary, 'updated');
});

test('decision impacts survive compact collection and expand by exact job identity', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const batchId = randomUUID(), sid = randomUUID(), req = randomUUID();
  const zh = n => '判'.repeat(n);
  const impacts = [{
    target: `目标-${zh(80)}`,
    finding: `发现-${zh(240)}`,
    consequence: `影响-${zh(240)}`,
    evidence_refs: ['src/决定.mjs:42', 'tests/decision.test.mjs'],
  }];
  const text = blockFor(req, sid, {
    summary: 'decision impact retained',
    decision_impacts: impacts,
  });
  const { sidecar } = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: sid, requestId: req,
    finishedAt: new Date().toISOString(), text,
  });
  assert.equal(sidecar.worker.status, 'ready');
  assert.deepEqual(sidecar.worker.block.decision_impacts, impacts);
  const result = {
    ...compactResult('impact', 'decision impact retained', 1),
    session_id: sid, request_id: req,
    delivery_decision_impacts: sidecar.worker.block.decision_impacts,
    delivery_excerpt: deliveryExcerpt(sidecar.worker.block),
  };
  // Force every projection tier; a budget that happens to retain full detail
  // cannot by itself prove the reduced and minimal contracts.
  for (const detail of ['full', 'reduced', 'minimal']) {
    const projected = projectResult(result, { detail });
    assert.equal(projected.delivery_decision_impacts_total, 1);
    assert.equal(projected.delivery_excerpt.source, 'worker_reported');
    assert.equal(projected.delivery_excerpt.decision_impacts.total, 1);
    assert.deepEqual(projected.expand.impacts, { option: '--impacts', job: 'impact' });
    if (detail === 'minimal') {
      assert.deepEqual(projected.delivery_excerpt.decision_impacts.affected_targets, []);
      assert.equal(projected.delivery_excerpt.decision_impacts.omitted, 1);
    } else assert.ok(projected.delivery_excerpt.decision_impacts.affected_targets[0].startsWith('目标-'));
  }
  await atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), {
    schema: 'cwr.acp.batch-index/1', batch_id: batchId, status: 'complete', revision: 1,
    started_at: new Date().toISOString(), total: 1, planned: ['impact'], jobs: [], results: [result], missing: [],
  });
  const page = await collectBatchCompact({ config: { stateDir: f.config.stateDir }, batchId, maxBytes: COMPACT_MIN_BYTES });
  const item = page.items[0];
  assert.equal(item.delivery_decision_impacts_total, 1);
  assert.equal(item.delivery_excerpt.decision_impacts.total, 1);
  assert.ok(['full', 'reduced', 'minimal'].includes(item.detail));
  if (item.detail === 'minimal') {
    assert.deepEqual(item.delivery_excerpt.decision_impacts.affected_targets, []);
    assert.equal(item.delivery_excerpt.decision_impacts.omitted, 1);
  }
  assert.deepEqual(item.expand.impacts, { option: '--impacts', job: 'impact' });
  const expanded = await collectBatchImpacts({ config: { stateDir: f.config.stateDir }, batchId, jobId: 'impact' });
  assert.equal(expanded.schema, 'cwr.acp.batch-impacts/1');
  assert.equal(expanded.source, 'worker_reported');
  assert.equal(expanded.id, 'impact');
  assert.equal(expanded.session_id, sid);
  assert.equal(expanded.request_id, req);
  assert.deepEqual(expanded.impacts, impacts);
});

test('invalid compact options are rejected before config reads or child admission', async t => {
  const base = await jobRoot(t);
  const jobs = [job({ id: 'one', cwd: path.join(base, 'one'), file: path.join(base, 'one', 'o.md') })];
  const { f, manifestFile } = await batchFixture(t, jobs);
  for (const [options, code] of [
    [{ limit: '0' }, 'BAD_LIMIT'],
    [{ 'max-bytes': String(COMPACT_MIN_BYTES - 1) }, 'BAD_BUDGET'],
  ]) {
    let configReads = 0, launches = 0;
    await assert.rejects(runBatch({
      config: { configPath: f.configFile },
      opt: { manifest: manifestFile, compact: true, ...options },
      deps: {
        loadConfig: async () => { configReads++; return f.config; },
        spawnJob: () => { launches++; throw Object.assign(new Error('unexpected launch'), { code: 'SYNTHETIC_LAUNCH' }); },
      },
      output: () => {}, text: () => {}, cliPath: CLI,
    }), { code });
    assert.deepEqual({ configReads, launches }, { configReads: 0, launches: 0 }, 'invalid consumer options must not start authorized work');
  }
});

test('short evidence distinguishes clipped text from omitted entries', () => {
  const excerpt = deliveryExcerpt({
    summary: 'complete',
    criteria: [{ criterion: '条'.repeat(200), state: 'unsatisfied' }],
    checks: [{ name: '检'.repeat(180), state: 'failed', detail: 'failure evidence' }],
    questions: ['问'.repeat(500), 'short question'],
  });
  assert.equal(excerpt.omitted.questions, 0, 'both questions are represented');
  assert.deepEqual(excerpt.questions_truncated, [true, false], 'a represented question can still be a clipped fragment');
  assert.deepEqual(excerpt.criteria.unsatisfied_truncated, [true]);
  assert.deepEqual(excerpt.checks.failing_truncated, [true]);
});

test('minimal detail retains worker provenance and failure counts for expansion decisions', () => {
  const session = randomUUID(), request = randomUUID();
  const item = projectResult({
    id: 'blocked', rev: 2, session_id: session, request_id: request,
    delivery_status: 'needs_input', delivery_questions: ['Which contract applies?'],
    delivery_excerpt: deliveryExcerpt({
      summary: 'A failed check and unsatisfied condition require a decision',
      criteria: [{ criterion: 'contract matches', state: 'unsatisfied' }],
      checks: [{ name: 'negative control', state: 'failed', detail: 'wrong identity was accepted' }],
      questions: ['Which contract applies?'],
    }),
  }, { detail: 'minimal' });
  assert.equal(item.delivery_excerpt?.source, 'worker_reported');
  assert.equal(item.delivery_excerpt.criteria.unsatisfied, 1);
  assert.equal(item.delivery_excerpt.checks.by_state.failed, 1);
  assert.equal(item.delivery_excerpt.questions_total, 1);
  assert.ok(item.delivery_excerpt.omitted_fields.includes('summary'));
  assert.equal(item.expand.session_id, session);
  assert.equal(item.expand.request_id, request);
});

test('full and compact terminals remain partial when the final index publication fails', async t => {
  for (const compact of [false, true]) {
    const cwd = path.join(await jobRoot(t), 'one');
    const { f, manifestFile, out, state } = await batchFixture(t, [job({ id: 'one', cwd, file: path.join(cwd, 'o.md') })]);
    const originalRename = fs.rename;
    fs.rename = async (from, to) => {
      if (path.basename(to) === 'index.json') {
        const record = JSON.parse(await fs.readFile(from, 'utf8'));
        if (record.status === 'complete') throw Object.assign(new Error('synthetic final publication failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    };
    try {
      const code = await runBatch({
        config: { configPath: f.configFile }, opt: { manifest: manifestFile, compact },
        deps: { loadConfig: async () => f.config, spawnJob: fakeSpawner(state, { stateDir: f.config.stateDir }) },
        output: value => out.push(value), text: () => {}, cliPath: CLI,
      });
      assert.equal(code, 1);
      const terminal = out.at(-1);
      assert.equal(terminal.status, 'partial', 'a failed durable publication cannot be reported complete');
      assert.equal((compact ? terminal.batch : terminal).index_warning, 'EIO');
    } finally {
      fs.rename = originalRename;
    }
  }
});

test('missing reports block successors transitively while independent jobs still settle', async t => {
  const base = await jobRoot(t);
  const dir = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(id => [id, path.join(base, id)]));
  const jobs = Object.entries(dir).map(([id, cwd]) => job({ id, cwd, file: path.join(cwd, 'o.md') }));
  const { f, manifestFile, out, state } = await batchFixture(t, jobs, { maxConcurrency: 3 });
  for (const id of Object.keys(dir)) await fs.writeFile(path.join(dir[id], 'o.md'), `Order ${id}.`);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a'];
  manifest.jobs.find(j => j.id === 'c').inputs = [{ job: 'a', report: true }];
  manifest.jobs.find(j => j.id === 'd').depends_on = ['c'];
  manifest.jobs.find(j => j.id === 'd').inputs = [{ job: 'c', report: true }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const started = [];
  const spawner = fakeSpawner(state, { stateDir: f.config.stateDir, delays: { e: 300 }, writeDelivery: false });
  const wrapped = args => { started.push(args.job.id); return spawner(args); };
  const code = await runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile },
    deps: { loadConfig: async () => f.config, spawnJob: wrapped },
    output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
  });
  assert.equal(code, 1);
  const batch = out.at(-1);
  assert.equal(batch.status, 'partial');
  assert.deepEqual([...new Set(started)].sort(), ['a', 'b', 'e']);
  assert.deepEqual(batch.waiting, []);
  assert.equal(batch.blocked.find(x => x.id === 'c')?.code, 'PREDECESSOR_DELIVERY_MISSING');
  assert.equal(batch.blocked.find(x => x.id === 'd')?.code, 'PREDECESSOR_BLOCKED');
  assert.ok(batch.missing.includes('a'));
});

test('partial and needs_input reports retain exact impact expansion without authorizing successors', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const status of ['partial', 'needs_input']) {
    const batchId = randomUUID(), sid = randomUUID(), req = randomUUID();
    const impacts = [{ target: 'recovery', finding: 'old handle is stale', consequence: 'reidentify the page', evidence_refs: ['src/page.mjs:4'] }];
    const { sidecar } = await writeDeliverySidecar({
      stateDir: f.config.stateDir, session: sid, requestId: req,
      finishedAt: new Date().toISOString(), text: blockFor(req, sid, { status, decision_impacts: impacts }),
    });
    assert.equal(sidecar.worker.status, status);
    await atomicJSON(path.join(f.config.stateDir, 'batches', batchId, 'index.json'), {
      schema: 'cwr.acp.batch-index/1', batch_id: batchId, status: 'partial', revision: 1,
      total: 1, planned: ['finding'], jobs: [], missing: [],
      results: [{ id: 'finding', session_id: sid, request_id: req, delivery_decision_impacts: impacts }],
    });
    const expanded = await collectBatchImpacts({ config: f.config, batchId, jobId: 'finding' });
    assert.equal(expanded.source, 'worker_reported');
    assert.equal(expanded.session_id, sid);
    assert.equal(expanded.request_id, req);
    assert.deepEqual(expanded.impacts, impacts);
  }
});

test('failed, cancelled, unconfirmed and partial predecessors block both direct and transitive successors', async t => {
  for (const [behavior, expected] of [
    [{ status: 'failed' }, 'PREDECESSOR_RUNTIME_FAILED'],
    [{ status: 'cancelled' }, 'PREDECESSOR_RUNTIME_CANCELLED'],
    [{ cleanup: 'unconfirmed' }, 'PREDECESSOR_CLEANUP_UNCONFIRMED'],
    [{ deliverStatus: 'partial' }, 'PREDECESSOR_DELIVERY_PARTIAL'],
    [{ deliverStatus: 'needs_input' }, 'PREDECESSOR_DELIVERY_NEEDS_INPUT'],
  ]) {
    const base = await jobRoot(t);
    const jobs = ['a', 'c', 'd', 'independent'].map(id => job({ id, cwd: path.join(base, id), file: path.join(base, id, 'o.md') }));
    const { f, manifestFile, out, state } = await batchFixture(t, jobs);
    for (const j of jobs) await fs.writeFile(j.file, 'Synthetic order.');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    Object.assign(manifest.jobs.find(j => j.id === 'c'), { depends_on: ['a'], inputs: [{ job: 'a', report: true }] });
    Object.assign(manifest.jobs.find(j => j.id === 'd'), { depends_on: ['c'], inputs: [{ job: 'c', report: true }] });
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const started = [];
    const valid = fakeSpawner(state, { stateDir: f.config.stateDir });
    const invalid = fakeSpawner(state, { stateDir: f.config.stateDir, ...behavior });
    assert.equal(await run(f, manifestFile, out, args => {
      started.push(args.job.id);
      return (args.job.id === 'a' ? invalid : valid)(args);
    }), 1);
    assert.deepEqual(started.sort(), ['a', 'independent']);
    assert.equal(out.at(-1).blocked.find(j => j.id === 'c').code, expected);
    assert.equal(out.at(-1).blocked.find(j => j.id === 'd').code, 'PREDECESSOR_BLOCKED');
    assert.equal(out.at(-1).jobs.find(j => j.id === 'independent').runtime_status, 'completed');
  }
});

test('collect publishes transitive blocked states while an unrelated child remains unsettled', async t => {
  const base = await jobRoot(t);
  const jobs = ['a', 'c', 'd', 'e'].map(id => job({ id, route: id === 'd' ? 'backup' : 'worker', cwd: path.join(base, id), file: path.join(base, id, 'o.md') }));
  const { f, manifestFile, out, state } = await batchFixture(t, jobs, { maxConcurrency: 2 });
  // D has a disjoint synthetic HOME, so the existing resource admission allows
  // it to run while A is held. No real adapter concurrency claim is made.
  f.config.routes.backup = { ...f.config.routes.worker, workerHome: f.raw.routes.backup.workerHome };
  for (const j of jobs) await fs.writeFile(j.file, 'Synthetic order.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  Object.assign(manifest.jobs.find(j => j.id === 'c'), { depends_on: ['a'], inputs: [{ job: 'a', report: true }] });
  Object.assign(manifest.jobs.find(j => j.id === 'e'), { depends_on: ['c'], inputs: [{ job: 'c', report: true }] });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const gate = deferred(), predecessorGate = deferred(), handleFile = path.join(f.root, 'start.json');
  const valid = fakeSpawner(state, { stateDir: f.config.stateDir });
  const missing = fakeSpawner(state, { stateDir: f.config.stateDir, writeDelivery: false });
  const running = runBatch({
    config: { configPath: f.configFile }, opt: { manifest: manifestFile, 'start-handle': handleFile },
    deps: { loadConfig: async () => f.config, spawnJob: args => {
      const handle = (args.job.id === 'a' ? missing : valid)(args);
      if (args.job.id === 'a') handle.done = handle.done.then(async value => { await predecessorGate.promise; return value; });
      if (args.job.id === 'd') handle.done = handle.done.then(async value => { await gate.promise; return value; });
      return handle;
    } }, output: value => out.push(value), text: () => {}, cliPath: 'cli.mjs',
  });
  try {
    // Capture both handles first. Otherwise a late D-handle publication could
    // accidentally publish the blocked map and let the pre-fix runner pass.
    let handle;
    const handleDeadline = Date.now() + 5000;
    while (Date.now() < handleDeadline) {
      try {
        handle = JSON.parse(await fs.readFile(handleFile, 'utf8'));
        const collected = await collectBatch({ config: f.config, batchId: handle.batch_id });
        if (collected.handles === 2) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sleep(10);
    }
    assert.equal((await collectBatch({ config: f.config, batchId: handle.batch_id })).handles, 2);
    predecessorGate.resolve();
    let mid;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const collected = await collectBatch({ config: f.config, batchId: handle.batch_id });
        if (collected.blocked.some(j => j.id === 'e')) { mid = collected; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sleep(10);
    }
    assert.ok(mid, 'blocked states must be durable before D is released');
    assert.equal(mid.status, 'running');
    assert.ok(!mid.results.some(j => j.id === 'd'));
    assert.deepEqual(mid.unresolved.blocked.sort(), ['c', 'e']);
    assert.ok(!mid.unresolved.awaiting_handle.includes('c'));
  } finally { predecessorGate.resolve(); gate.resolve(); await running; }
});

test('cancellation during dependency binding fences a just-ready successor', async t => {
  const base = await jobRoot(t), a = path.join(base, 'a'), c = path.join(base, 'c');
  const { f, manifestFile, out, state } = await batchFixture(t, [
    job({ id: 'a', cwd: a, file: path.join(a, 'o.md') }),
    job({ id: 'c', cwd: c, file: path.join(c, 'o.md') }),
  ]);
  await fs.writeFile(path.join(c, 'o.md'), 'Must not launch after cancellation.');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.jobs.find(j => j.id === 'c').depends_on = ['a'];
  manifest.jobs.find(j => j.id === 'c').inputs = [{ job: 'a', report: true }];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const started = [];
  const spawner = fakeSpawner(state, { stateDir: f.config.stateDir });
  const originalWrite = fs.writeFile;
  let boundWriteSeen = false, code;
  fs.writeFile = async (file, ...args) => {
    const result = await originalWrite(file, ...args);
    if (path.basename(String(file)) === 'c.order.md') {
      boundWriteSeen = true;
      process.emit('SIGINT');
    }
    return result;
  };
  try {
    code = await runBatch({
      config: { configPath: f.configFile }, opt: { manifest: manifestFile },
      deps: { loadConfig: async () => f.config, spawnJob: args => { started.push(args.job.id); return spawner(args); } },
      output: r => out.push(r), text: () => {}, cliPath: 'cli.mjs',
    });
  } finally { fs.writeFile = originalWrite; }
  assert.equal(code, 1);
  assert.equal(boundWriteSeen, true, 'cancel must arrive during the actual bound-order write');
  assert.deepEqual(started, ['a'], 'cancellation before dependency admission must not spawn C');
  assert.equal(out.at(-1).cancelled, true);
  assert.ok(out.at(-1).waiting.includes('c'));
});
