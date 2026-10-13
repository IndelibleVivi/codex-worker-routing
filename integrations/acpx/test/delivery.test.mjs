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

async function setup(t, behavior = {}) {
  const f = await fixture(); t.after(f.cleanup);
  return { ...f, api: fakeAcpx(behavior) };
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
const run = (f, extra = {}) => executeTurn({ config: f.config, selection: f.selection, binding: f.binding, text: 'Report.', isNew: true, acpx: f.api, deliver: true, ...extra });

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
  assert.equal(normalizeDelivery({ ...READY_A, request_id: 'other' }, { requestId: UUID_A }).code, 'WRONG_REQUEST_ID');
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
  const r = await executeTurn({ config: f.config, selection: f.selection, binding: f.binding, text: 'x', isNew: true, acpx: f.api });
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
