// Delivery collection contracts use the synthetic runtime double and a real
// temporary state root. No adapter, provider, account or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { executeTurn, loadWorkerContract, workOrder } from '../src/engine.mjs';
import { extractDelivery, normalizeDelivery, readDelivery, writeDeliverySidecar, deliveryFile, deliveryDir, validateSidecar, collectArtifactReference, MAX_MESSAGE_BYTES, MAX_SERIALIZED_BYTES } from '../src/delivery.mjs';
import { readJSON, Fault } from '../src/state.mjs';
import { fixture, fakeAcpx } from './helpers.mjs';
import { createAdmissionOwner, initializeLifecycleJournal, createLifecycleJournal } from '../src/lock-recovery.mjs';
import { digest } from '../src/state.mjs';

async function setup(t, behavior = {}) {
  const f = await fixture(); t.after(f.cleanup);
  const pid = f.syntheticPid;
  f.processEvidence = (await import('./helpers.mjs')).lifecycleEvidence(pid);
  return { ...f, api: fakeAcpx({ ...behavior, pid }) };
}
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const block = obj => '```cwr-delivery\n' + JSON.stringify(obj) + '\n```';
const READY = { schema: 'cwr.acp.delivery/1', status: 'ready', summary: 'done', criteria: [{ criterion: 'x', state: 'satisfied' }], checks: [], artifacts: [], questions: [] };
const READY_A = { ...READY, request_id: UUID_A, session_id: UUID_A };
// A ready block whose ids match a given live session and request UUID_A.
const readyFor = (sid, over = {}) => block({ ...READY, request_id: UUID_A, session_id: sid, ...over });
// The runtime double echoes a well-formed block carrying the ACTUAL per-turn ids.
const echoBlock = f => input => [{ type: 'text_delta', stream: 'output', text: '```cwr-delivery\n' + JSON.stringify({ ...READY, request_id: input.requestId, session_id: f.binding.id }) + '\n```' }];
let deliveryRequestSerial = 0;
async function turn(f, extra = {}) {
  const requestId = `30000000-0000-0000-0000-${String(++deliveryRequestSerial).padStart(12, '0')}`;
  const owner = await createAdmissionOwner({ session: f.binding.id, requestId, cwd: f.cwd,
    route: 'worker', permissions: 'read', workspaceKey: digest(f.cwd), processEvidence: f.processEvidence });
  await initializeLifecycleJournal({ config: f.config, owner });
  return executeTurn({ config: f.config, selection: f.selection, binding: f.binding, text: 'Report.',
    isNew: true, acpx: f.api, deliver: true, requestId,
    lifecycleJournal: createLifecycleJournal({ config: f.config, owner }), processEvidence: f.processEvidence, ...extra });
}
const run = (f, extra = {}) => turn(f, extra);

// --- Contract delivery -----------------------------------------------------

test('the always-delivered work order contains the packaged contract and no delivery schema', () => {
  const wo = workOrder('Do the thing.', 'read');
  assert.ok(wo.includes(loadWorkerContract()), 'the packaged worker contract must be delivered verbatim');
  assert.ok(!wo.includes('cwr.acp.delivery/1'), 'ordinary work orders must not ingest the delivery schema');
  const deliver = workOrder('Do the thing.', 'read', { deliver: true, requestId: UUID_A, sessionId: UUID_B });
  const sample = JSON.parse(deliver.split('\n').find(line => line.startsWith('{"schema":"cwr.acp.delivery/1"')));
  assert.equal(sample.request_id, UUID_A);
  assert.equal(sample.session_id, UUID_B);
  assert.ok(!deliver.includes('CURRENT_REQUEST_ID'));
  assert.ok(deliver.includes(`"request_id":"${UUID_A}"`));
  assert.ok(deliver.includes(`"session_id":"${UUID_B}"`));
});

test('the packaged contract file is the single semantic source', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const text = await fs.readFile(path.resolve(here, '../../../plugins/worker-routing/skills/worker-routing/references/worker-contract.md'), 'utf8');
  assert.equal(text.trim(), loadWorkerContract());
  assert.ok(!text.includes('cwr-delivery'), 'the optional block schema must live with its delivery owner, not the core contract');
  assert.match(text, /Own the complete authorized responsibility/);
});

test('a missing packaged contract refuses to build a work order instead of inventing one', async () => {
  // Explicit loader injection — no ambient environment override exists.
  assert.throws(() => loadWorkerContract(['/nonexistent/worker-contract.md']), { code: 'CONTRACT_UNAVAILABLE' });
});

// --- Extraction and normalization ------------------------------------------

test('extractDelivery accepts one well-formed block and reports its status', () => {
  const r = extractDelivery(`Work done.\n${block({ ...READY_A, status: 'partial' })}`);
  assert.equal(r.status, 'partial');
  assert.equal(r.block.summary, 'done');
});
test('optional decision impacts are bounded, identity-preserving and reject malformed entries', () => {
  const impacts = [{
    target: 'webhook retry policy',
    finding: 'The current timeout drops a delivery after the provider accepted it.',
    consequence: 'Changing the timeout without an idempotency key can duplicate effects.',
    evidence_refs: ['src/webhook.mjs:42', 'tests/webhook.test.mjs'],
  }];
  const valid = normalizeDelivery({ ...READY_A, decision_impacts: impacts });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.block.decision_impacts, impacts);
  assert.equal(valid.block.request_id, UUID_A);
  assert.equal(valid.block.session_id, UUID_A);
  assert.deepEqual(normalizeDelivery({ ...READY_A }).block.decision_impacts, []);
  for (const impact of [
    { ...impacts[0], extra: 'unknown' },
    { ...impacts[0], target: 7 },
    { ...impacts[0], evidence_refs: ['x'.repeat(501)] },
    { ...impacts[0], evidence_refs: Array.from({ length: 9 }, (_, i) => `e${i}`) },
  ]) {
    const rejected = normalizeDelivery({ ...READY_A, decision_impacts: [impact] });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'BAD_DECISION_IMPACTS');
  }
  assert.equal(normalizeDelivery({ ...READY_A, decision_impacts: Array.from({ length: 9 }, () => impacts[0]) }).code, 'BAD_DECISION_IMPACTS');
  assert.equal(extractDelivery(block({ ...READY, request_id: UUID_A, session_id: UUID_A, decision_impacts: [{ target: 'x' }] })).code, 'BAD_DECISION_IMPACTS');
});
test('extractDelivery rejects missing, multiple, malformed and oversized blocks', () => {
  assert.equal(extractDelivery('no block here').status, 'missing');
  assert.equal(extractDelivery(block(READY_A) + block(READY_A)).status, 'malformed');
  assert.equal(extractDelivery('```cwr-delivery\n{not json}\n```').status, 'malformed');
  const huge = { ...READY_A, summary: 'x'.repeat(70 * 1024) };
  assert.equal(extractDelivery(block(huge)).status, 'oversized');
});
test('normalizeDelivery rejects unknown fields, bad schema, bad status and wrong identity', () => {
  assert.equal(normalizeDelivery({ ...READY_A, extra: 1 }).code, 'UNKNOWN_FIELD');
  assert.equal(normalizeDelivery({ ...READY_A, schema: 'x' }).code, 'BAD_SCHEMA');
  assert.equal(normalizeDelivery({ ...READY_A, status: 'done' }).code, 'BAD_STATUS');
  assert.equal(normalizeDelivery({ ...READY_A, request_id: UUID_B }, { requestId: UUID_A }).code, 'WRONG_REQUEST_ID');
  assert.equal(normalizeDelivery({ ...READY_A, request_id: 'other' }, { requestId: UUID_A }).code, 'WRONG_REQUEST_ID');
});
test('delivery ids stay bounded without an expected identity', () => {
  const badIds = [
    { request_id: { x: 'x' } },
    { request_id: 7 },
    { session_id: { x: 'x' } },
    { session_id: false },
    { session_id: `${UUID_A}0` },
  ];
  for (const ids of badIds) {
    const normalized = normalizeDelivery({ ...READY, ...ids });
    assert.equal(normalized.ok, false);
    assert.equal(normalized.code, 'BAD_IDENTITY');
    assert.equal(normalized.block, undefined);
    const extracted = extractDelivery(block({ ...READY, ...ids }));
    assert.equal(extracted.status, 'malformed');
    assert.equal(extracted.code, 'BAD_IDENTITY');
    assert.equal(extracted.block, null);
    assert.ok(JSON.stringify(extracted).length < 1024, 'invalid ids are not echoed');
  }
  for (const text of [
    block({ ...READY, request_id: { x: 'x'.repeat(80 * 1024) } }),
    block({ ...READY, request_id: 'x'.repeat(80 * 1024) }),
  ]) {
    const extracted = extractDelivery(text);
    assert.equal(extracted.status, 'oversized');
    assert.ok(['BLOCK_TOO_LARGE', 'MESSAGE_TOO_LARGE'].includes(extracted.code));
    assert.equal(extracted.block, null);
    assert.ok(JSON.stringify(extracted).length < 1024, 'oversized ids are not echoed');
  }
  const valid = normalizeDelivery({ ...READY, request_id: UUID_A, session_id: UUID_B });
  assert.equal(valid.ok, true);
  assert.equal(valid.block.request_id, UUID_A);
  assert.equal(valid.block.session_id, UUID_B);
});
test('a delivery block MUST carry the current ids; missing or stale ids are wrong_identity', () => {
  const noIds = { ...READY };
  delete noIds.request_id; delete noIds.session_id;
  assert.equal(extractDelivery(block(noIds), { requestId: UUID_A, session: UUID_B }).status, 'wrong_identity');
  assert.equal(extractDelivery(block(READY_A), { requestId: UUID_B, session: UUID_A }).status, 'wrong_identity');
  assert.equal(extractDelivery(block(READY_A), { requestId: UUID_A, session: UUID_A }).status, 'ready');
});

// --- Sidecar integration through a real turn -------------------------------

test('a --deliver turn writes a sidecar collected independently of the excerpt', async t => {
  const f = await setup(t);
  f.api = fakeAcpx({ events: echoBlock(f) });
  const r = await run(f, { events: undefined });
  assert.equal(r.runtime_status, 'completed');
  const side = await readJSON(deliveryFile(f.config.stateDir, f.binding.id, r.request_id), { privateFile: true });
  assert.equal(side.worker.status, 'ready');
  assert.equal(side.worker.block.summary, 'done');
  // Observed runtime facts come from the ACTUAL receipt, not a caller field.
  assert.equal(side.observed.runtime_status, 'completed');
  assert.equal(side.observed.cleanup, 'confirmed');
  assert.equal(side.observed.checks_source, 'runner_observed');
});

test('an ordinary (non --deliver) turn writes no sidecar', async t => {
  const f = await setup(t, { events: input => [{ type: 'text_delta', stream: 'output', text: '```cwr-delivery\n' + JSON.stringify({ ...READY, request_id: input.requestId, session_id: f.binding.id }) + '\n```' }] });
  const r = await turn(f, { deliver: false, text: 'x' });
  await assert.rejects(fs.stat(deliveryFile(f.config.stateDir, f.binding.id, r.request_id)), { code: 'ENOENT' });
});

test('a missing block is recorded as missing and never changes runtime status', async t => {
  const f = await setup(t, { events: [{ type: 'text_delta', stream: 'output', text: 'No structured block.' }] });
  const r = await run(f);
  assert.equal(r.runtime_status, 'completed');
  const side = await readJSON(deliveryFile(f.config.stateDir, f.binding.id, r.request_id), { privateFile: true });
  assert.equal(side.worker.status, 'missing');
  assert.equal(side.worker.code, 'NO_BLOCK');
  const receipt = await readJSON(r.receipt_path, { privateFile: true });
  assert.equal(receipt.runtime_status, 'completed');
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, r.request_id)).worker.status, 'missing');
});

test('an oversized delivery cannot truncate into a fake ready', async t => {
  const f = await setup(t, { events: [{ type: 'text_delta', stream: 'output', text: 'a'.repeat(200 * 1024) }] });
  const r = await run(f);
  const side = await readJSON(deliveryFile(f.config.stateDir, f.binding.id, r.request_id), { privateFile: true });
  assert.equal(side.worker.status, 'oversized');
  assert.equal(side.message_truncated, true);
});

// --- Path safety and validation --------------------------------------------

test('a raw request id cannot escape the deliveries directory', async t => {
  const f = await setup(t);
  const evil = '../../receipts/secret';
  assert.throws(() => deliveryFile(f.config.stateDir, f.binding.id, evil), { code: 'BAD_REQUEST_ID' });
  await assert.rejects(readDelivery(f.config.stateDir, f.binding.id, evil), { code: 'BAD_REQUEST_ID' });
  await assert.rejects(writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id, requestId: evil, text: readyFor(f.binding.id) }), { code: 'BAD_REQUEST_ID' });
});

test('an explicitly named corrupted sidecar fails rather than becoming a pass', async t => {
  const f = await setup(t);
  const file = deliveryFile(f.config.stateDir, f.binding.id, UUID_A);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Wrong schema/session: a corrupted named sidecar must be surfaced, not trusted.
  await fs.writeFile(file, JSON.stringify({ schema: 'x', session_id: UUID_B, request_id: UUID_A, finished_at: 'nope' }), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  await assert.rejects(readDelivery(f.config.stateDir, f.binding.id, UUID_A), { code: 'CORRUPT_DELIVERY' });
  assert.equal(validateSidecar({ schema: 'x' }, { session: f.binding.id, requestId: UUID_A }).ok, false);
});

test('sidecar validation rejects a wrong session/request and bad timestamps', async t => {
  const f = await setup(t);
  const good = { schema: 'cwr.acp.delivery-sidecar/1', session_id: f.binding.id, request_id: UUID_A, finished_at: new Date().toISOString(), at: new Date().toISOString(), worker: { status: 'missing', code: 'NO_BLOCK', block: null }, observed: { checks_source: 'runner_observed' }, message: '', message_truncated: false };
  assert.equal(validateSidecar(good, { session: f.binding.id, requestId: UUID_A }).ok, true);
  assert.equal(validateSidecar({ ...good, session_id: UUID_B }, { session: f.binding.id, requestId: UUID_A }).reason, 'WRONG_SESSION');
  assert.equal(validateSidecar({ ...good, request_id: UUID_B }, { session: f.binding.id, requestId: UUID_A }).reason, 'WRONG_REQUEST');
  assert.equal(validateSidecar({ ...good, finished_at: 'not-a-date' }, { session: f.binding.id, requestId: UUID_A }).reason, 'BAD_TIMESTAMP');
});

test('stored delivery blocks must repeat the exact outer request and session identity', async t => {
  const f = await setup(t);
  for (const status of ['ready', 'partial', 'needs_input']) {
    const written = await writeDeliverySidecar({
      stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
      finishedAt: '2026-01-02T00:00:00.000Z',
      text: block({ ...READY, request_id: UUID_A, session_id: f.binding.id, status }),
    });
    assert.equal(written.sidecar.worker.block.request_id, UUID_A);
    assert.equal(written.sidecar.worker.block.session_id, f.binding.id);
    assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.status, status);
    await fs.rm(written.file);
  }

  // Shape a synthetic pre-change sidecar after the real writer and remove both
  // block ids. Historical outer identity was already checked at write time.
  const historical = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
    finishedAt: '2026-01-02T00:00:00.000Z', text: readyFor(f.binding.id),
  });
  const legacy = await readJSON(historical.file, { privateFile: true });
  delete legacy.worker.block.request_id;
  delete legacy.worker.block.session_id;
  await fs.writeFile(historical.file, JSON.stringify(legacy), { mode: 0o600 });
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.status, 'ready');
  await fs.rm(historical.file);

  const mismatches = [
    ['wrong block request', { request_id: UUID_B }],
    ['wrong block session', { session_id: UUID_B }],
    ['removed block request', { request_id: undefined }],
    ['removed block session', { session_id: undefined }],
  ];
  const controls = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
    finishedAt: '2026-01-02T00:00:00.000Z', text: readyFor(f.binding.id),
  });
  const control = await readJSON(controls.file, { privateFile: true });
  delete control.worker.block.request_id;
  delete control.worker.block.session_id;
  await fs.writeFile(controls.file, JSON.stringify(control), { mode: 0o600 });
  assert.equal(validateSidecar(control, { session: f.binding.id, requestId: UUID_A }).ok, true);
  await fs.rm(controls.file);

  for (const [name, change] of mismatches) {
    const written = await writeDeliverySidecar({
      stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
      finishedAt: '2026-01-02T00:00:00.000Z',
      text: readyFor(f.binding.id),
    });
    const stored = await readJSON(written.file, { privateFile: true });
    assert.equal(stored.worker.block.request_id, UUID_A, 'normal writer retains validated request identity');
    assert.equal(stored.worker.block.session_id, f.binding.id, 'normal writer retains validated session identity');
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete stored.worker.block[key];
      else stored.worker.block[key] = value;
    }
    await fs.writeFile(written.file, JSON.stringify(stored), { mode: 0o600 });
    await assert.rejects(readDelivery(f.config.stateDir, f.binding.id, UUID_A), { code: 'CORRUPT_DELIVERY' }, name);
    assert.equal(validateSidecar(stored, { session: f.binding.id, requestId: UUID_A }).reason, 'BAD_BLOCK', name);
    await fs.rm(written.file);
  }
});

test('unqualified delivery scan rejects invalid identity records and keeps warnings truthful', async t => {
  const f = await setup(t);
  const one = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
    finishedAt: '2026-01-01T00:00:00.000Z', text: readyFor(f.binding.id),
  });
  const bad = await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_B,
    finishedAt: '2026-01-03T00:00:00.000Z',
    text: block({ ...READY, request_id: UUID_B, session_id: f.binding.id, summary: 'bad newer copy' }),
  });
  const corrupt = await readJSON(bad.file, { privateFile: true });
  corrupt.worker.block.request_id = UUID_A;
  await fs.writeFile(bad.file, JSON.stringify(corrupt), { mode: 0o600 });

  const scanned = await readDelivery(f.config.stateDir, f.binding.id);
  assert.equal(scanned.request_id, UUID_A, 'a corrupt newer record cannot win the scan');
  assert.equal(scanned.worker.block.summary, 'done');
  assert.deepEqual(scanned.collection_warnings, { invalid_sidecars: 1 });

  await fs.rm(one.file);
  await assert.rejects(readDelivery(f.config.stateDir, f.binding.id), { code: 'CORRUPT_DELIVERY' });
});

test('valid delivery history remains readable per request after identity validation', async t => {
  const f = await setup(t);
  await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A,
    finishedAt: '2026-01-01T00:00:00.000Z', text: readyFor(f.binding.id),
  });
  await writeDeliverySidecar({
    stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_B,
    finishedAt: '2026-01-03T00:00:00.000Z',
    text: block({ ...READY, request_id: UUID_B, session_id: f.binding.id, summary: 'second' }),
  });
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.block.summary, 'done');
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_B)).worker.block.summary, 'second');
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id)).worker.block.summary, 'second');
  assert.equal(await readDelivery(f.config.stateDir, f.binding.id, '33333333-3333-4333-8333-333333333333'), null);
});

// --- Immutability / idempotence / conflict ---------------------------------

test('per-request delivery is immutable: identical replay is idempotent, conflicting rewrite is refused', async t => {
  const f = await setup(t);
  const base = { stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A, finishedAt: '2026-01-02T00:00:00.000Z' };
  const first = await writeDeliverySidecar({ ...base, text: readyFor(f.binding.id) });
  assert.equal(first.sidecar.worker.status, 'ready');
  // Identical replay: idempotent, no change.
  const again = await writeDeliverySidecar({ ...base, text: readyFor(f.binding.id) });
  assert.equal(again.idempotent, true);
  // Same timestamp, different content: refused, original preserved.
  const conflict = await writeDeliverySidecar({ ...base, text: readyFor(f.binding.id, { summary: 'rewritten' }) });
  assert.equal(conflict.conflict, true);
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.block.summary, 'done');
  // Newer replay for the same request also cannot replace the first publication.
  const newer = await writeDeliverySidecar({ ...base, finishedAt: '2026-01-09T00:00:00.000Z', text: readyFor(f.binding.id, { summary: 'newer' }) });
  assert.equal(newer.conflict, true);
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.block.summary, 'done');
});

test('concurrent identical collectors publish one consistent sidecar', async t => {
  const f = await setup(t);
  const args = { stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A, finishedAt: '2026-01-02T00:00:00.000Z', text: readyFor(f.binding.id) };
  const results = await Promise.allSettled([writeDeliverySidecar({ ...args }), writeDeliverySidecar({ ...args }), writeDeliverySidecar({ ...args })]);
  // At least one publishes; every recorded outcome agrees the sidecar is valid.
  const stored = await readDelivery(f.config.stateDir, f.binding.id, UUID_A);
  assert.equal(stored.worker.status, 'ready');
  assert.ok(results.some(r => r.status === 'fulfilled'));
});

test('readDelivery returns the newest delivery across requests by finished_at', async t => {
  const f = await setup(t);
  await writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A, finishedAt: '2026-01-01T00:00:00.000Z', text: readyFor(f.binding.id) });
  await writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_B, finishedAt: '2026-01-03T00:00:00.000Z', text: block({ ...READY, request_id: UUID_B, session_id: f.binding.id, summary: 'second' }) });
  const newest = await readDelivery(f.config.stateDir, f.binding.id);
  assert.equal(newest.worker.block.summary, 'second');
});

// --- Bounded serialized size and UTF-8 -------------------------------------

test('a valid report with heavy JSON escaping is still readable within the serialized bound', async t => {
  const f = await setup(t);
  // Control characters inflate the SERIALIZED size far above the raw size; the
  // write and read bounds must agree so the report stays readable.
  const summary = '\u0001'.repeat(2000) + 'ok';
  const r = await writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A, finishedAt: '2026-01-02T00:00:00.000Z', text: readyFor(f.binding.id, { summary }) });
  const serialized = await fs.readFile(r.file, 'utf8');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_SERIALIZED_BYTES);
  const stored = await readDelivery(f.config.stateDir, f.binding.id, UUID_A);
  assert.equal(stored.worker.status, 'ready');
  assert.ok(stored.worker.block.summary.endsWith('ok'));
});

test('UTF-8 truncation stays within the byte cap and does not split a code point', async t => {
  const f = await setup(t);
  const text = '\u{1F600}'.repeat(60 * 1024); // 4 bytes each, far over the raw cap
  const r = await writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id, requestId: UUID_A, finishedAt: '2026-01-02T00:00:00.000Z', text, oversized: true });
  assert.ok(Buffer.byteLength(r.sidecar.message, 'utf8') <= MAX_MESSAGE_BYTES);
  assert.equal(r.sidecar.message_truncated, true);
  assert.ok(!/[\uD800-\uDBFF]$/.test(r.sidecar.message), 'must not end on a lone surrogate');
});

// --- Bounded artifact reference collection ---------------------------------

test('collectArtifactReference only checks refs inside approved roots and never executes', async t => {
  const f = await setup(t);
  const inside = path.join(f.cwd, 'artifact.txt');
  await fs.writeFile(inside, 'x');
  const ok = await collectArtifactReference(inside, { roots: [f.cwd] });
  assert.equal(ok.status, 'present');
  assert.equal(ok.type, 'file');
  // A file OUTSIDE the approved roots is unsupported, never inspected.
  const outside = path.join(f.root, '..', 'outside.txt');
  assert.equal((await collectArtifactReference(outside, { roots: [f.cwd] })).reason, 'OUTSIDE_ROOT');
  // An external URL is unsupported.
  assert.equal((await collectArtifactReference('https://example.com/x', { roots: [f.cwd] })).reason, 'EXTERNAL_URL');
  // A missing ref inside the root reports missing.
  assert.equal((await collectArtifactReference(path.join(f.cwd, 'nope.txt'), { roots: [f.cwd] })).status, 'missing');
  // A supplied fingerprint is compared for freshness.
  const st = await fs.stat(inside);
  assert.equal((await collectArtifactReference(inside, { roots: [f.cwd], expectedFingerprint: `${st.size}:${Math.trunc(st.mtimeMs)}` })).metadata_matches, true);
  assert.equal((await collectArtifactReference(inside, { roots: [f.cwd], expectedFingerprint: 'x' })).freshness, 'unknown');
});


test('escape-heavy surrounding text preserves a valid report while the stored message is bounded', async t => {
  const f = await setup(t);
  const r = await writeDeliverySidecar({ stateDir: f.config.stateDir, session: f.binding.id,
    requestId: UUID_A, text: String.fromCharCode(0).repeat(90 * 1024) + readyFor(f.binding.id) });
  assert.equal(r.sidecar.worker.status, 'ready');
  assert.equal(r.sidecar.message_truncated, true);
  assert.ok(Buffer.byteLength(await fs.readFile(r.file, 'utf8')) <= MAX_SERIALIZED_BYTES);
  assert.equal((await readDelivery(f.config.stateDir, f.binding.id, UUID_A)).worker.status, 'ready');
});

test('artifact references through a symlink cannot expose an outside-root target', async t => {
  const f = await setup(t), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'hidden.txt'), 'synthetic');
  const link = path.join(f.cwd, 'link');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await collectArtifactReference(path.join(link, 'hidden.txt'), { roots: [f.cwd] });
  assert.equal(r.status, 'unsupported'); assert.equal(r.reason, 'OUTSIDE_ROOT');
});


test('oversized streams stay bounded and report all observed bytes after retention stops', async t => {
  const chunks = ['x'.repeat(MAX_MESSAGE_BYTES), 'y'.repeat(MAX_MESSAGE_BYTES), 'z'.repeat(MAX_MESSAGE_BYTES)];
  const f = await setup(t, { events: chunks.map(text => ({ type: 'text_delta', stream: 'output', text })) });
  const receipt = await run(f);
  const side = await readDelivery(f.config.stateDir, f.binding.id, receipt.request_id);
  assert.equal(side.worker.status, 'oversized');
  assert.equal(side.worker.checks_source, 'worker_reported');
  assert.equal(side.observed.output_bytes, chunks.reduce((n, text) => n + Buffer.byteLength(text), 0));
  assert.equal(side.message_truncated, true);
  assert.ok(Buffer.byteLength(side.message) <= MAX_MESSAGE_BYTES);
  assert.equal(receipt.runtime_status, 'completed');
});
