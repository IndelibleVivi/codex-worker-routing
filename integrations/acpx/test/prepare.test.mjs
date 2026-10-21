// Order-spec preparation: strict validation, mechanical assembly, no launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseSpec, assembleOrder, runPrepare, SPEC_SCHEMA } from '../src/prepare.mjs';
import { parseManifest, MANIFEST_SCHEMA } from '../src/batch.mjs';
import { parseArgs, main } from '../src/cli.mjs';
import { atomicJSON, paths, exposesPosixModes } from '../src/state.mjs';
import { fixture } from './helpers.mjs';

const SPEC = SPEC_SCHEMA;
function spec(over = {}, jobOver = {}) {
  return { schema: SPEC, shared: 'Common background.', jobs: [{ id: 'a', verb: 'run', cwd: '/abs/ws', permissions: 'read', task: 'Do A.', ...jobOver }], ...over };
}

test('spec validation is strict: schema, unknown fields, jobs bounds, explicit permissions', () => {
  assert.throws(() => parseSpec({}), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ schema: 'x' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ bogus: 1 })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ jobs: [] })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ jobs: Array.from({ length: 33 }, (_, i) => ({ id: `j${i}`, verb: 'run', cwd: '/abs/ws', permissions: 'read', task: 't' })) })), { code: 'BAD_SPEC' });
  // Permissions are explicit per item; omitting them is the same fixable
  // pre-submission error the CLI reports, never a category inference.
  assert.throws(() => parseSpec(spec({}, { permissions: undefined })), { code: 'PERMISSIONS_REQUIRED' });
  assert.throws(() => parseSpec(spec({}, { permissions: 'write', category: 'implementation' })), { code: 'PERMISSIONS_REQUIRED' });
});

test('spec assembly carries explicit dependency inputs into the generated manifest', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const result = await runPrepare({
    config: f.config,
    spec: {
      schema: SPEC,
      jobs: [
        { id: 'a', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'A.' },
        { id: 'b', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'B.' },
        {
          id: 'c', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'C.',
          depends_on: ['a', 'b'],
          inputs: [{ job: 'a', report: true }, { job: 'b', report: true, artifacts: ['out/report.md'] }],
        },
      ],
    },
  });
  const manifest = parseManifest(JSON.parse(await fs.readFile(result.manifest_path, 'utf8')));
  assert.deepEqual(manifest.jobs.find(j => j.id === 'c').depends_on, ['a', 'b']);
  assert.deepEqual(manifest.jobs.find(j => j.id === 'c').inputs, [
    { job: 'a', report: true, artifacts: [] },
    { job: 'b', report: true, artifacts: ['out/report.md'] },
  ]);
  // Invalid edges are rejected by prepare before creating any output.
  const out = path.join(f.root, 'invalid-orders');
  await assert.rejects(runPrepare({
    config: f.config, out,
    spec: {
      schema: SPEC,
      jobs: [
        { id: 'a', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'A.' },
        { id: 'b', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'B.', depends_on: ['a'], inputs: [] },
      ],
    },
  }), { code: 'BAD_DEPENDENCIES' });
  await assert.rejects(fs.stat(out), { code: 'ENOENT' });
});

test('spec validation: job identity, verbs, continue rules, sizes', () => {
  assert.throws(() => parseSpec(spec({}, { id: 'bad id!' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ jobs: [
    { id: 'a', verb: 'run', cwd: '/abs/ws', permissions: 'read', task: 't' },
    { id: 'a', verb: 'run', cwd: '/abs/ws', permissions: 'read', task: 't' },
  ] })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { verb: 'stop' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { task: '' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { task: 'x'.repeat(33 * 1024) })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ shared: 'x'.repeat(33 * 1024) })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { cwd: 'relative' })), { code: 'BAD_SPEC' });
  // continue: session required, route/title/category forbidden; run: session forbidden, cwd required.
  assert.throws(() => parseSpec(spec({}, { verb: 'continue' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { verb: 'continue', session: randomUUID(), route: 'worker' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { verb: 'continue', session: randomUUID(), title: 'x' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { session: randomUUID() })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { cwd: undefined })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { title: 'x'.repeat(161) })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { category: 'magic' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { resources: ['bad token!'] })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { deliver: 'yes' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({}, { sharedHomeValidation: 'assumed' })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ maxConcurrency: 0 })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ maxConcurrency: 9 })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ capabilities: { sharedWorkerHome: 'assumed' } })), { code: 'BAD_SPEC' });
  assert.throws(() => parseSpec(spec({ outDir: 'relative' })), { code: 'BAD_SPEC' });
});

test('assembleOrder joins shared background and task verbatim, with a bound', () => {
  assert.equal(assembleOrder('Common background.\n', 'Do A.\n'), 'Common background.\n\n---\n\nDo A.\n');
  assert.equal(assembleOrder('', 'Do A.'), 'Do A.\n');
  assert.throws(() => assembleOrder('x'.repeat(40 * 1024), 'y'.repeat(40 * 1024)), { code: 'ORDER_TOO_LARGE' });
});

test('runPrepare writes exact order files and a manifest the real batch validator accepts', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const config = { ...f.config, routing: { default: 'worker', fallbacks: [] } };
  const result = await runPrepare({
    config,
    spec: spec({ maxConcurrency: 3, jobs: [
      { id: 'a', verb: 'run', cwd: f.cwd, permissions: 'read', task: 'Do A.', title: 'alpha' },
      { id: 'b', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'full', task: 'Do B.', deliver: false, resources: ['port:1'] },
    ] }),
  });
  assert.equal(result.schema, 'cwr.acp.order-spec-result/1');
  assert.deepEqual(result.defaulted_jobs, ['a']);
  assert.ok(result.manifest_path.startsWith(path.join(config.stateDir, 'prepare') + path.sep));
  const orderA = await fs.readFile(result.orders[0].file, 'utf8');
  assert.equal(orderA, 'Common background.\n\n---\n\nDo A.\n');
  const orderB = await fs.readFile(result.orders[1].file, 'utf8');
  assert.equal(orderB, 'Common background.\n\n---\n\nDo B.\n');
  // POSIX mode bits prove owner-only permissions where exposed; Windows's
  // synthesized mode does not encode ACL privacy (the shared state contract).
  if (exposesPosixModes()) {
    assert.equal((await fs.stat(result.orders[0].file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.manifest_path)).mode & 0o777, 0o600);
  }
  const manifest = JSON.parse(await fs.readFile(result.manifest_path, 'utf8'));
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.maxConcurrency, 3);
  // Round-trip through the real batch validator: a generated manifest is an
  // ordinary manifest, with the canonical workspace path filled in.
  const parsed = parseManifest(manifest);
  assert.equal(parsed.jobs.length, 2);
  assert.equal(parsed.jobs[0].route, 'worker');
  assert.equal(parsed.jobs[0].cwd, f.config.routes.worker.workspaces[0]);
  assert.equal(parsed.jobs[0].permissions, 'read');
  assert.equal(parsed.jobs[0].deliver, true);
  assert.equal(parsed.jobs[1].deliver, false);
  assert.deepEqual(parsed.jobs[1].resources, ['port:1']);
  assert.ok(path.isAbsolute(parsed.jobs[0].file));
});

test('runPrepare continue jobs bind the recorded session and its canonical workspace', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const result = await runPrepare({
    config: f.config,
    spec: { schema: SPEC, jobs: [{ id: 'c', verb: 'continue', session: f.binding.id, permissions: 'read', task: 'Pick up the remaining check.' }] },
  });
  const parsed = parseManifest(JSON.parse(await fs.readFile(result.manifest_path, 'utf8')));
  assert.equal(parsed.jobs[0].verb, 'continue');
  assert.equal(parsed.jobs[0].session, f.binding.id);
  assert.equal(parsed.jobs[0].cwd, f.binding.cwd);
  assert.equal(parsed.jobs[0].route, null); // the bound route comes from the session
  // An explicit cwd must match the bound workspace canonically.
  await assert.rejects(runPrepare({
    config: f.config,
    spec: { schema: SPEC, jobs: [{ id: 'c', verb: 'continue', session: f.binding.id, cwd: path.dirname(f.binding.cwd), permissions: 'read', task: 'elsewhere' }] },
  }), { code: 'BAD_SPEC' });
  // A closed responsibility is not continuable.
  await atomicJSON(paths(f.config.stateDir, f.binding.id).binding, { ...f.binding, closed: true });
  await assert.rejects(runPrepare({
    config: f.config,
    spec: { schema: SPEC, jobs: [{ id: 'c', verb: 'continue', session: f.binding.id, permissions: 'read', task: 'again' }] },
  }), { code: 'SESSION_CLOSED' });
});

test('runPrepare surfaces fixable authorization problems before any launch', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const jobFor = over => ({ id: 'a', verb: 'run', cwd: f.cwd, permissions: 'read', task: 't', ...over });
  // Unknown route.
  await assert.rejects(runPrepare({ config: f.config, spec: spec({ jobs: [jobFor({ route: 'ghost' })] }) }), { code: 'ROUTE_DISABLED' });
  // cwd outside the registered workspaces.
  await assert.rejects(runPrepare({ config: f.config, spec: spec({ jobs: [jobFor({ route: 'worker', cwd: path.dirname(f.cwd) })] }) }), { code: 'WORKSPACE_NOT_ALLOWED' });
  // Permission above the route's ceiling.
  const readOnly = { ...f.config, routes: { worker: { ...f.config.routes.worker, maxPermissions: 'read' } } };
  await assert.rejects(runPrepare({ config: readOnly, spec: spec({ jobs: [jobFor({ route: 'worker', permissions: 'full' })] }) }), { code: 'PERMISSION_DENIED' });
  // Missing adapter entry.
  const noEntry = { ...f.config, routes: { worker: { ...f.config.routes.worker, argv: [path.join(f.root, 'no-such-entry')] } } };
  await assert.rejects(runPrepare({ config: noEntry, spec: spec({ jobs: [jobFor({ route: 'worker' })] }) }), { code: 'BAD_EXECUTABLE' });
  // No route and no default.
  await assert.rejects(runPrepare({ config: f.config, spec: spec({ jobs: [jobFor()] }) }), { code: 'ROUTE_REQUIRED' });
});

test('runPrepare never overwrites existing outputs', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const out = path.join(f.root, 'orders');
  await fs.mkdir(out, { mode: 0o700 });
  await fs.writeFile(path.join(out, 'a.order.md'), 'occupied');
  await assert.rejects(runPrepare({
    config: f.config, out,
    spec: spec({ jobs: [{ id: 'a', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 't' }] }),
  }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await fs.readFile(path.join(out, 'a.order.md'), 'utf8'), 'occupied');
  // A leftover manifest is likewise refused, even when the order names are fresh.
  const out2 = path.join(f.root, 'orders2');
  await fs.mkdir(out2, { mode: 0o700 });
  await fs.writeFile(path.join(out2, 'batch-manifest.json'), '{}');
  await assert.rejects(runPrepare({
    config: f.config, out: out2,
    spec: spec({ jobs: [{ id: 'b', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 't' }] }),
  }), { code: 'OUTPUT_EXISTS' });
});

test('CLI parses prepare/collect and main runs them without touching an adapter', async t => {
  assert.deepEqual(parseArgs(['prepare', '--config', 'c', '--spec', 's']), { command: 'prepare', config: 'c', spec: 's' });
  assert.deepEqual(parseArgs(['prepare', '--config', 'c', '--spec', 's', '--out', '/tmp/x']), { command: 'prepare', config: 'c', spec: 's', out: '/tmp/x' });
  assert.deepEqual(parseArgs(['collect', '--config', 'c', '--batch', 'b']), { command: 'collect', config: 'c', batch: 'b' });
  for (const bad of [['prepare', '--config', 'c'], ['collect', '--config', 'c'], ['prepare', '--config', 'c', '--spec', 's', '--deliver']])
    assert.throws(() => parseArgs(bad), { code: 'USAGE' });

  const f = await fixture();
  t.after(f.cleanup);
  const specFile = path.join(f.root, 'spec.json');
  await fs.writeFile(specFile, JSON.stringify(spec({ jobs: [{ id: 'a', verb: 'run', route: 'worker', cwd: f.cwd, permissions: 'read', task: 'Do A.' }] })));
  const results = [];
  // No loadAcpx dep at all: importing one would throw a ReferenceError-style
  // failure in this harness, so a clean run proves prepare stays adapter-free.
  const code = await main(['prepare', '--config', f.configFile, '--spec', specFile], { output: r => results.push(r), replaceEnvironment: () => { throw new Error('must not scrub'); }, loadAcpx: async () => { throw new Error('must not load'); } });
  assert.equal(code, 0);
  assert.equal(results.at(-1).schema, 'cwr.acp.order-spec-result/1');
  // collect through main: unknown batch id is an explicit error, not a pass.
  await assert.rejects(
    main(['collect', '--config', f.configFile, '--batch', randomUUID()], { output: () => {}, loadAcpx: async () => { throw new Error('must not load'); } }),
    { code: 'BATCH_NOT_FOUND' });
});
