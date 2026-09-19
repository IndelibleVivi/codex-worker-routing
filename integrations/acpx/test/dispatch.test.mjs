// SPDX-License-Identifier: SUL-1.0
// Dispatch projection/event tests. All fixtures are synthetic; nothing here
// reads an operator config, receipt directory or external machine path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicJSON, paths, lock, digest } from '../src/state.mjs';
import {
  EVENT_SCHEMA, PROJECTION_SCHEMA, BINDING_SCHEMA, validateEventInput, normalizeStoredEvent, foldEvents, recordEvent,
  eventDir, eventFile, requestOrderFile, classifyTurn, planSessionMetadata, planContinuation,
  captureParentMetadata, writeRequestOrder, normalizeSince, createSessionAccounting, createProjectionReader,
  listPendingSessions, deriveReviewState,
} from '../src/dispatch.mjs';
import { parseArgs, main, renderStatsText } from '../src/cli.mjs';
import { fixture, fakeAcpx } from './helpers.mjs';

const at = ms => new Date(ms).toISOString();
const T = '2026-09-01T00:00:00.000Z';
const usage = total => ({ cumulative: { inputTokens: total, outputTokens: null, thoughtTokens: null, totalTokens: total } });

async function syntheticState() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-dispatch-')));
  await fs.chmod(root, 0o700);
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  return { root, stateDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
function bindingFor(id, over = {}) {
  return { schema: 'cwr.acp.binding/1', id, route: 'worker', routeFingerprint: 'fp', cwd: '/synthetic/worktree', closed: false, createdAt: T, handle: null, ...over };
}
function receiptFor(id, requestId, over = {}) {
  return {
    schema: 'cwr.acp.receipt/1', backend: 'acpx', session_id: id, request_id: requestId, route: 'worker',
    runtime_status: over.runtime_status ?? 'completed', task_acceptance: 'unverified', cleanup: over.cleanup ?? 'confirmed',
    started_at: over.started_at ?? at(Date.parse('2026-08-01T00:00:00Z')),
    finished_at: over.finished_at ?? at(Date.parse('2026-08-01T01:00:00Z')),
    adapter_reported_session_usage: over.usage === undefined ? null : over.usage,
    output_excerpt: over.output_excerpt ?? 'SYNTHETIC OUTPUT', receipt_path: 'UNUSED', diagnostic_path: null,
  };
}
async function writeBinding(stateDir, binding) {
  await fs.mkdir(path.dirname(paths(stateDir, binding.id).binding), { recursive: true, mode: 0o700 });
  await atomicJSON(paths(stateDir, binding.id).binding, binding);
  return binding;
}
async function writeReceipt(stateDir, id, receipt) {
  const dir = paths(stateDir, id).receipts;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicJSON(path.join(dir, `${receipt.request_id}.json`), receipt);
}
function eventInput(session, over = {}) {
  return { schema: EVENT_SCHEMA, event_id: over.event_id ?? randomUUID(), session_id: session, kind: over.kind ?? 'submitted', request_id: over.request_id ?? null, reason: over.reason ?? null, summary: over.summary ?? null, evidence: over.evidence ?? [], supersedes: over.supersedes ?? null };
}

// ---------------------------------------------------------------------------
// (1) Event schema
// ---------------------------------------------------------------------------
test('event schema rejects raw/unknown fields, bad enums and over-long text', () => {
  const s = randomUUID();
  const base = eventInput(s);
  assert.equal(validateEventInput(base).kind, 'submitted');
  assert.throws(() => validateEventInput({ ...base, transcript: 'raw' }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateEventInput({ ...base, kind: 'completed' }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, at: at(Date.now()) }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateEventInput({ ...base, reason: 'uncertain' }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, summary: 'x'.repeat(1001) }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, event_id: 'no' }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, request_id: 'a/b' }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, evidence: [{ source: 'worker', kind: 'test' }] }), { code: 'BAD_EVENT' });
  assert.throws(() => validateEventInput({ ...base, evidence: [{ source: 'worker', kind: 'test', summary: 'ok', raw: 'x' }] }), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => validateEventInput({ ...base, kind: 'revision_requested' }), { code: 'BAD_EVENT' });
  assert.equal(validateEventInput({ ...base, kind: 'revision_requested', reason: 'requirement_missed' }).reason, 'requirement_missed');
  assert.equal(validateEventInput({ ...base, kind: 'taken_over', reason: 'uncertain' }).reason, 'uncertain');
});

// ---------------------------------------------------------------------------
// (2) recordEvent: binding required, session match, supersedes validation
// ---------------------------------------------------------------------------
test('record requires an existing binding and matching session id', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await assert.rejects(recordEvent(stateDir, id, eventInput(id, { kind: 'note' })), { code: 'UNKNOWN_SESSION' });
  await writeBinding(stateDir, bindingFor(id));
  await assert.rejects(recordEvent(stateDir, id, eventInput(randomUUID(), { kind: 'note' })), { code: 'BAD_EVENT' });
});

test('record is idempotent by event_id and a conflicting retry is rejected', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  const eventId = randomUUID();
  const input = eventInput(id, { event_id: eventId, kind: 'note', summary: 'original' });
  const first = await recordEvent(stateDir, id, input, { stamp: at(Date.parse('2026-08-20T10:00:00Z')) });
  assert.equal(first.recorded, true);
  const retry = await recordEvent(stateDir, id, input, { stamp: at(Date.parse('2026-09-19T10:00:00Z')) });
  assert.equal(retry.idempotent, true); assert.equal(retry.event.at, first.event.at);
  await assert.rejects(recordEvent(stateDir, id, eventInput(id, { event_id: eventId, kind: 'note', summary: 'tampered' })), { code: 'EVENT_CONFLICT' });
  assert.equal(JSON.parse(await fs.readFile(eventFile(stateDir, id, eventId), 'utf8')).summary, 'original');
});

test('concurrent event writers do not lose events', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  const ids = Array.from({ length: 16 }, () => randomUUID());
  await Promise.all(ids.map(event_id => recordEvent(stateDir, id, eventInput(id, { event_id, kind: 'note', summary: event_id }))));
  assert.equal((await fs.readdir(eventDir(stateDir, id))).filter(n => n.endsWith('.json')).length, 16);
  assert.equal((await createProjectionReader(stateDir).read()).warnings.length, 0);
});

test('a correction reclassifies a mistaken event while retaining history', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  const wrong = randomUUID(), fixed = randomUUID();
  await recordEvent(stateDir, id, eventInput(id, { event_id: wrong, kind: 'revision_requested', reason: 'requirement_missed', summary: 'mistaken revision' }), { stamp: at(Date.parse('2026-08-01T00:00:00Z')) });
  await recordEvent(stateDir, id, eventInput(id, { event_id: fixed, kind: 'note', summary: 'actually just an annotation', supersedes: wrong }), { stamp: at(Date.parse('2026-08-02T00:00:00Z')) });
  const projection = await createProjectionReader(stateDir).read();
  const session = projection.sessions.find(s => s.id === id);
  // The correction changes the KIND but classification is by base identity; the
  // corrected note does not count as a revision.
  assert.equal(projection.summary.revisions, 0);
  assert.ok(session.timeline.some(e => e.kind === 'note'));
  const detail = await createProjectionReader(stateDir).detail(id);
  assert.equal(detail.events.filter(e => e.kind === 'revision_requested').length, 1); // history retained
  assert.equal(detail.events.filter(e => e.kind === 'note').length, 1);
});

test('supersedes rejects dangling, future and already-superseded targets before write', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  const base = randomUUID();
  await recordEvent(stateDir, id, eventInput(id, { event_id: base, kind: 'note', summary: 'base' }), { stamp: at(Date.parse('2026-08-10T00:00:00Z')) });
  await assert.rejects(recordEvent(stateDir, id, eventInput(id, { kind: 'note', supersedes: randomUUID() })), { code: 'BAD_EVENT' });
  const first = randomUUID();
  await recordEvent(stateDir, id, eventInput(id, { event_id: first, kind: 'note', summary: 'first correction', supersedes: base }), { stamp: at(Date.parse('2026-08-11T00:00:00Z')) });
  // base is already superseded by `first`; another root correction of base is refused.
  await assert.rejects(recordEvent(stateDir, id, eventInput(id, { kind: 'note', supersedes: base })), { code: 'BAD_EVENT' });
  // No partial file was written by the rejected corrections.
  assert.equal((await fs.readdir(eventDir(stateDir, id))).filter(n => n.endsWith('.json')).length, 2);
});

test('foldEvents keeps one effective record per logical chain', () => {
  const id = randomUUID();
  const base = { event_id: randomUUID(), session_id: id, kind: 'submitted', at: at(1), summary: 'a', evidence: [{ source: 'coordinator', kind: 'manual', summary: 'x' }], request_id: null, reason: null, supersedes: null };
  const c1 = { ...base, event_id: randomUUID(), kind: 'submitted', at: at(2), summary: 'b', supersedes: base.event_id };
  const c2 = { ...base, event_id: randomUUID(), kind: 'submitted', at: at(3), summary: 'c', supersedes: c1.event_id };
  const folded = foldEvents([base, c1, c2]);
  assert.equal(folded.effective.size, 1);
  assert.equal([...folded.effective.values()][0].summary, 'c');
  assert.deepEqual(folded.warnings, []);
});

test('foldEvents excludes cyclic references with a warning instead of stack overflow', () => {
  const id = randomUUID();
  const a = { event_id: randomUUID(), session_id: id, kind: 'note', at: at(2), summary: 'a', evidence: [], request_id: null, reason: null, supersedes: null };
  const b = { ...a, event_id: randomUUID(), at: at(3), summary: 'b', supersedes: a.event_id };
  // Force a cycle by pointing `a` at `b`.
  a.supersedes = b.event_id;
  const folded = foldEvents([a, b]);
  assert.ok(folded.warnings.includes('event_supersedes_cycle'));
  // A cyclic base is excluded from the effective set, never resolved blindly.
  assert.equal(folded.effective.size, 0);
});

// ---------------------------------------------------------------------------
// (1) Accounting: baseline, straddle, reset, missing, zero, accumulation
// ---------------------------------------------------------------------------
function observe(list, { sinceIso = null, now, createdInPeriod = true } = {}) {
  const acc = createSessionAccounting({ sinceIso, now });
  const bySession = new Map();
  for (const o of list) { if (!bySession.has(o.session)) bySession.set(o.session, []); bySession.get(o.session).push(o); }
  const per = new Map();
  for (const [session, obs] of bySession) per.set(session, acc.observeSession({ observations: obs, createdInPeriod, warnings: [] }));
  return { acc, per };
}
const obs = (session, ms, total, { inPeriod = true, straddlesBoundary = false } = {}) => ({ session, at: at(ms), usage: total === null ? { input: 3, output: null, thought: null, total: null } : { input: null, output: null, thought: null, total }, inPeriod, straddlesBoundary });

test('old session with no baseline is unknown, not counted as full usage', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc, per } = observe([obs('s1', Date.parse('2026-09-11T00:00:00Z'), 250)], { sinceIso: since, createdInPeriod: false });
  assert.equal(per.get('s1').covered, false);
  assert.equal(acc.summary.external_tokens, 0);
  assert.equal(acc.summary.usage_sessions, 0);
  assert.equal(acc.summary.usage_total_sessions, 1);
});

test('created-in-period session starts from zero and de-duplicates cumulative snapshots', () => {
  const { acc } = observe([
    obs('new', Date.parse('2026-09-11T00:00:00Z'), 100),
    obs('new', Date.parse('2026-09-11T01:00:00Z'), 180),
    obs('new', Date.parse('2026-09-11T02:00:00Z'), 250),
  ], { sinceIso: at(Date.parse('2026-09-10T00:00:00Z')) });
  assert.equal(acc.summary.external_tokens, 250);
  assert.equal(acc.summary.usage_sessions, 1);
});

test('period attribution uses the pre-boundary baseline, not the lifetime total', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc } = observe([
    obs('old', Date.parse('2026-09-01T00:00:00Z'), 100, { inPeriod: false }),
    obs('old', Date.parse('2026-09-11T00:00:00Z'), 250),
  ], { sinceIso: since, createdInPeriod: false });
  assert.equal(acc.summary.external_tokens, 150);
  assert.equal(acc.summary.usage_sessions, 1);
});

test('a known reset is excluded and its subtotal removed, not counted as zero coverage', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc, per } = observe([
    obs('reset', Date.parse('2026-09-01T00:00:00Z'), 500, { inPeriod: false }),
    obs('reset', Date.parse('2026-09-11T00:00:00Z'), 20),
  ], { sinceIso: since, createdInPeriod: false });
  assert.equal(per.get('reset').covered, false);
  assert.equal(acc.summary.usage_sessions, 0);
  assert.equal(acc.summary.external_tokens, 0);
});

test('a reset after a covered subtotal removes the whole session subtotal', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc } = observe([
    obs('mixed', Date.parse('2026-09-01T00:00:00Z'), 100, { inPeriod: false }),
    obs('mixed', Date.parse('2026-09-11T00:00:00Z'), 220),
    obs('mixed', Date.parse('2026-09-12T00:00:00Z'), 20), // reset
  ], { sinceIso: since });
  assert.equal(acc.summary.usage_sessions, 0);
  assert.equal(acc.summary.external_tokens, 0);
});

test('zero is a known zero; missing totals stay unknown', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc } = observe([obs('zero', Date.parse('2026-09-11T00:00:00Z'), 0)], { sinceIso: since });
  assert.equal(acc.summary.usage_sessions, 1);
  assert.equal(acc.summary.external_tokens, 0);

  const missing = observe([obs('missing', Date.parse('2026-09-11T00:00:00Z'), null)], { sinceIso: since });
  assert.equal(missing.per.get('missing').covered, false);
  assert.equal(missing.acc.summary.usage_sessions, 0);
});

test('a snapshot after a missing intermediate bridges when totals stay known', () => {
  const since = at(Date.parse('2026-09-10T00:00:00Z'));
  const { acc } = observe([
    obs('bridge', Date.parse('2026-09-11T00:00:00Z'), 100),
    obs('bridge', Date.parse('2026-09-11T01:00:00Z'), null), // missing intermediate
    obs('bridge', Date.parse('2026-09-11T02:00:00Z'), 300),
  ], { sinceIso: since });
  // 0->100 then unknown intermediate; the missing snapshot is not fabricated,
  // but a later complete total still bridges (300-100 => further 200).
  assert.equal(acc.summary.external_tokens, 300);
});

test('future observations beyond now are excluded', () => {
  const now = Date.parse('2026-09-11T00:00:00Z');
  const { acc } = observe([obs('future', Date.parse('2026-09-20T00:00:00Z'), 900)], { sinceIso: null, now });
  assert.equal(acc.summary.usage_sessions, 0);
});

// ---------------------------------------------------------------------------
// (2/3) fold effective counts, acceptance, evidence
// ---------------------------------------------------------------------------
test('runtime completed is not acceptance; corrections do not double count', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  const submitted = randomUUID();
  await recordEvent(stateDir, id, eventInput(id, { event_id: submitted, kind: 'submitted', summary: 'first delivery' }), { stamp: at(2) });
  await recordEvent(stateDir, id, eventInput(id, { kind: 'submitted', summary: 'corrected label', supersedes: submitted }), { stamp: at(3) });
  const projection = await createProjectionReader(stateDir).read();
  const session = projection.sessions.find(s => s.id === id);
  assert.equal(session.runtime_status, 'completed');
  assert.equal(session.acceptance, 'unverified');
  assert.equal(session.submissions, 1); // not 2
  assert.equal(projection.summary.submissions, 1);
});

test('a later revision invalidates a stale accepted status', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted', summary: 'looked done' }), { stamp: at(2) });
  await recordEvent(stateDir, id, eventInput(id, { kind: 'revision_requested', reason: 'validation_failed', summary: 'actually not' }), { stamp: at(3) });
  const projection = await createProjectionReader(stateDir).read();
  assert.equal(projection.sessions.find(s => s.id === id).acceptance, 'unverified');
  assert.equal(projection.summary.accepted, 0);
  assert.equal(projection.summary.revisions, 1);
});

test('taken_over after accepted wins; summary counts responsibilities not markers', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted', summary: 'ok' }), { stamp: at(2) });
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted', summary: 'still ok' }), { stamp: at(3) });
  await recordEvent(stateDir, id, eventInput(id, { kind: 'taken_over', reason: 'environment_blocked', summary: 'taking it back' }), { stamp: at(4) });
  const projection = await createProjectionReader(stateDir).read();
  assert.equal(projection.sessions.find(s => s.id === id).acceptance, 'taken_over');
  assert.equal(projection.summary.accepted, 0);
  assert.equal(projection.summary.taken_over, 1);
});

test('runtime outcome counts the latest in-period status once per session', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  const base = Date.parse('2026-08-01T00:00:00Z');
  await writeBinding(stateDir, bindingFor(id));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(base), finished_at: at(base + 1000) }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-2', { started_at: at(base + 2000), finished_at: at(base + 3000) }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-3', { started_at: at(base + 4000), finished_at: at(base + 5000) }));
  const projection = await createProjectionReader(stateDir).read();
  assert.equal(projection.summary.runtime_completed, 1); // one responsibility, not three turns
  assert.equal(projection.summary.worker_turns, 3);
});

test('evidence_count counts coordinator evidence only', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'submitted', evidence: [
    { source: 'worker', kind: 'test', summary: 'worker says pass' },
    { source: 'coordinator', kind: 'test', summary: 'reran suite' },
    { source: 'coordinator', kind: 'diff', summary: 'inspected diff' },
  ] }), { stamp: at(2) });
  const projection = await createProjectionReader(stateDir).read();
  assert.equal(projection.sessions[0].evidence_count, 2);
});

// ---------------------------------------------------------------------------
// (4) cache warnings persist; foreign/malformed never attributes wrongly
// ---------------------------------------------------------------------------
test('malformed and unsafe records stay visible across repeated reads', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const good = randomUUID(), bad = randomUUID();
  await writeBinding(stateDir, bindingFor(good));
  await writeReceipt(stateDir, good, receiptFor(good, 'req-1'));
  await writeBinding(stateDir, bindingFor(bad));
  await fs.mkdir(paths(stateDir, bad).receipts, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(paths(stateDir, bad).receipts, 'broken.json'), '{ not json', { mode: 0o600 });
  const reader = createProjectionReader(stateDir);
  const first = await reader.read();
  const second = await reader.read();
  assert.ok(first.warnings.some(w => w.code === 'malformed_json'));
  assert.ok(second.warnings.some(w => w.code === 'malformed_json'));
  assert.equal(second.warnings.find(w => w.code === 'malformed_json').count, first.warnings.find(w => w.code === 'malformed_json').count);
  assert.ok(second.sessions.some(s => s.id === good));
});

test('diagnostic files are ignored, not counted as malformed receipts', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  await fs.writeFile(path.join(paths(stateDir, id).receipts, 'req-1.diagnostic.json'), JSON.stringify({ schema: 'cwr.acp.diagnostic/1' }), { mode: 0o600 });
  const projection = await createProjectionReader(stateDir).read();
  assert.ok(!projection.warnings.some(w => ['malformed_receipt', 'unreadable_receipt'].includes(w.code)));
  assert.equal(projection.sessions.find(s => s.id === id).turns, 1);
});

test('a foreign receipt is never attributed to another responsibility', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const mine = randomUUID(), other = randomUUID();
  await writeBinding(stateDir, bindingFor(mine));
  await writeBinding(stateDir, bindingFor(other));
  // A receipt whose session_id belongs elsewhere, dropped into `mine`.
  await writeReceipt(stateDir, mine, { ...receiptFor(other, 'req-1'), session_id: other });
  const read = await createProjectionReader(stateDir).read();
  assert.equal(read.sessions.find(s => s.id === mine).turns, 0);
  assert.ok(read.warnings.some(w => w.code === 'foreign_receipt'));
});

test('a malformed opaque parent/request identifier warns but keeps sibling data', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { parent: { thread_id: 'bad value with spaces', session_id: 'ok-id' } }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  const read = await createProjectionReader(stateDir).read();
  assert.equal(read.sessions.find(s => s.id === id).turns, 1);
  assert.deepEqual(read.sessions.find(s => s.id === id).parent, { thread_id: null, session_id: 'ok-id', observed_at: null });
});

// ---------------------------------------------------------------------------
// (5) unsafe directory handling / no auto-create
// ---------------------------------------------------------------------------
test('a symlinked receipts directory is not followed and never auto-created', async t => {
  const { stateDir, root, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, 'x.json'), JSON.stringify(receiptFor(id, 'x')), { mode: 0o600 });
  await fs.mkdir(paths(stateDir, id).dir, { recursive: true, mode: 0o700 });
  await fs.symlink(outside, paths(stateDir, id).receipts);
  const reader = createProjectionReader(stateDir);
  const read = await reader.read();
  assert.equal(read.sessions.find(s => s.id === id).turns, 0);
  assert.ok(read.warnings.some(w => w.code === 'unsafe_entry' || w.code === 'unreadable_receipt'));
  // A read never repairs or creates a missing directory.
  const missing = randomUUID();
  await writeBinding(stateDir, bindingFor(missing));
  await reader.read();
  await assert.rejects(fs.lstat(paths(stateDir, missing).receipts), { code: 'ENOENT' });
});

// ---------------------------------------------------------------------------
// (4/6) sorting, legacy, no inference
// ---------------------------------------------------------------------------
test('sessions sort by latest meaningful activity, newest first', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const old = randomUUID(), recent = randomUUID();
  await writeBinding(stateDir, bindingFor(old));
  await writeBinding(stateDir, bindingFor(recent));
  await writeReceipt(stateDir, old, receiptFor(old, 'req-1', { started_at: at(Date.parse('2026-08-01T00:00:00Z')), finished_at: at(Date.parse('2026-08-01T01:00:00Z')) }));
  await writeReceipt(stateDir, recent, receiptFor(recent, 'req-1', { started_at: at(Date.parse('2026-08-05T00:00:00Z')), finished_at: at(Date.parse('2026-08-05T01:00:00Z')) }));
  const read = await createProjectionReader(stateDir).read();
  assert.equal(read.sessions[0].id, recent);
  assert.equal(read.sessions[1].id, old);
});

test('legacy records are usable with a generic fallback and honest nulls', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  const projection = await createProjectionReader(stateDir).read();
  const session = projection.sessions.find(s => s.id === id);
  assert.equal(session.title, null);
  assert.equal(session.category, 'other');
  assert.equal(session.acceptance, 'unverified');
  assert.deepEqual(session.usage, { input: null, output: null, thought: null, total: null });
  assert.equal(renderStatsText(projection).includes('score'), false);
});

test('normalizeSince is strict and shares the caller clock', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  assert.equal(normalizeSince('all', now), null);
  assert.equal(normalizeSince('7d', now), at(now - 7 * 86400000));
  assert.equal(normalizeSince('2026-09-01', now), at(Date.parse('2026-09-01T00:00:00Z')));
  for (const bad of ['', '-1d', 'forever', '7x', 'd7', '1', '2026-02-31', '2026-13-01']) assert.throws(() => normalizeSince(bad, now), { code: 'BAD_PERIOD' });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------
test('read never exposes work-order text, output, paths or diagnostics', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id));
  await writeReceipt(stateDir, id, { ...receiptFor(id, 'req-1', { output_excerpt: 'RAW_OUTPUT_SECRET' }),
    adapter_reported_per_request_usage_omitted: true, perRequest: { 'req-1': { inputTokens: 3 } },
    transcript_state_dir: '/synthetic/private/acpx', receipt_path: '/synthetic/private/receipt.json', diagnostic_path: '/synthetic/private/diag.json' });
  await writeRequestOrder(stateDir, id, 'req-1', 'WORK_ORDER_SECRET');
  const projection = await createProjectionReader(stateDir).read();
  const serialized = JSON.stringify(projection);
  for (const secret of ['RAW_OUTPUT_SECRET', 'WORK_ORDER_SECRET', '/synthetic/private', 'perRequest', 'UNUSED']) assert.ok(!serialized.includes(secret), `projection leaked ${secret}`);
  const detail = await createProjectionReader(stateDir).detail(id);
  const detailText = JSON.stringify(detail);
  assert.ok(detailText.includes('WORK_ORDER_SECRET'));
  assert.ok(!detailText.includes('/synthetic/private'));
});

// ---------------------------------------------------------------------------
// CLI: stats / record never load an adapter
// ---------------------------------------------------------------------------
test('stats --json emits a projection without loading or scrubbing an adapter', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let imported = false, scrubbed = false;
  const out = [];
  const code = await main(['stats', '--config', f.configFile, '--json'], {
    loadAcpx: async () => { imported = true; }, replaceEnvironment: () => { scrubbed = true; }, output: r => out.push(r),
  });
  assert.equal(code, 0); assert.equal(imported, false); assert.equal(scrubbed, false);
  assert.equal(out.at(-1).schema, PROJECTION_SCHEMA);
});
test('stats text is the default and never prints a filesystem path', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const lines = [];
  const code = await main(['stats', '--config', f.configFile], {
    text: s => lines.push(s),
    loadAcpx: async () => { throw new Error('adapter must not load'); }, replaceEnvironment: () => { throw new Error('env must not scrub'); },
  });
  assert.equal(code, 0);
  assert.ok(!lines.join('').includes(f.config.stateDir));
});
test('record appends one event and rejects unknown fields without loading an adapter', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const eventPath = path.join(f.root, 'event.json');
  await fs.writeFile(eventPath, JSON.stringify(eventInput(f.binding.id, { kind: 'accepted', summary: 'checked diff' })), { mode: 0o600 });
  const out = [];
  assert.equal(await main(['record', '--config', f.configFile, '--session', f.binding.id, '--file', eventPath], { output: r => out.push(r), loadAcpx: async () => { throw new Error('no adapter'); } }), 0);
  assert.equal(out.at(-1).recorded, true);
  await fs.writeFile(eventPath, JSON.stringify({ ...eventInput(f.binding.id, {}), transcript: 'secret' }), { mode: 0o600 });
  await assert.rejects(main(['record', '--config', f.configFile, '--session', f.binding.id, '--file', eventPath], { output: () => {} }), { code: 'UNKNOWN_FIELD' });
});

// ---------------------------------------------------------------------------
// CLI parser / dashboard wiring
// ---------------------------------------------------------------------------
test('CLI parser handles the boolean --json flag and new commands', () => {
  assert.deepEqual(parseArgs(['stats', '--config', '/x.json', '--json']), { command: 'stats', config: '/x.json', json: true });
  assert.equal(parseArgs(['stats', '--config', '/x', '--since', '7d']).since, '7d');
  assert.throws(() => parseArgs(['stats', '--config', '/x', '--json', '--json']), { code: 'USAGE' });
  assert.equal(parseArgs(['dashboard', '--config', '/x', '--port', '0']).port, '0');
  assert.equal(parseArgs(['run', '--config', 'c', '--route', 'r', '--cwd', 'd', '--file', 'f', '--title', 'T', '--category', 'review']).category, 'review');
  assert.throws(() => parseArgs(['run', '--config', 'c', '--route', 'r', '--cwd', 'd', '--file', 'f', '--json']), { code: 'USAGE' });
});
test('dashboard resolves on server close and on SIGINT, removing handlers', async t => {
  const { EventEmitter } = await import('node:events');
  const f = await fixture(); t.after(f.cleanup);
  const server = new EventEmitter();
  let closed = false;
  const fake = { startDashboard: async options => { assert.equal(options.since, 'all'); return { url: 'http://127.0.0.1:0/', server, close: async () => { closed = true; } }; } };
  const before = process.listenerCount('SIGINT');
  const lines = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = main(['dashboard', '--config', f.configFile], { text: s => { lines.push(s); ready(); }, output: () => {}, loadDashboard: async () => fake });
  await started;
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  server.emit('close'); // the server's own lifecycle ends the CLI
  assert.equal(await pending, 0);
  assert.equal(process.listenerCount('SIGINT'), before);
  assert.ok(lines.join('').includes('http://127.0.0.1:0/'));

  let ready2;
  const started2 = new Promise(resolve => { ready2 = resolve; });
  const pending2 = main(['dashboard', '--config', f.configFile], { text: () => ready2(), output: () => {}, loadDashboard: async () => ({ ...fake, startDashboard: async () => ({ url: 'u', server: new EventEmitter(), close: async () => { closed = true; } }) }) });
  await started2;
  process.emit('SIGINT');
  assert.equal(await pending2, 0);
  assert.equal(closed, true);
});
test('dashboard fails closed when the module is absent', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(main(['dashboard', '--config', f.configFile], { text: () => {}, output: () => {}, loadDashboard: async () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); } }), { code: 'DASHBOARD_UNAVAILABLE' });
});

// ---------------------------------------------------------------------------
// (6) Lifecycle: order retained for run AND continue; metadata durable
// ---------------------------------------------------------------------------
test('run and continue retain each submitted work order in a private file', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} };
  await fs.writeFile(f.orderFile, 'Investigate the synthetic importer.');
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = results.at(-1).session_id;
  await fs.writeFile(f.orderFile, 'Now implement the fix.');
  assert.equal(await main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), 0);
  const detail = await createProjectionReader(f.config.stateDir).detail(id);
  assert.equal(detail.turns.length, 2);
  assert.ok(detail.turns[0].work_order.includes('Investigate the synthetic importer'));
  assert.ok(detail.turns[1].work_order.includes('Now implement the fix'));
});

test('title/category/parent are visible while active and durable after', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const saved = { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID };
  process.env.CODEX_THREAD_ID = 'synthetic-thread-id';
  let seenEnv = null, createdId, bindingAtRunStart;
  try {
    const code = await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile, '--title', 'Synthetic', '--category', 'investigation'], {
      loadAcpx: async () => api,
      replaceEnvironment: env => { seenEnv = env; },
      output: r => results.push(r),
      progress: noop => { createdId = noop.match(/session ([a-f0-9-]+)/)[1]; },
    });
    assert.equal(code, 0);
    bindingAtRunStart = JSON.parse(await fs.readFile(paths(f.config.stateDir, createdId).binding, 'utf8'));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // The child environment never carries the parent identifiers.
  assert.equal(seenEnv.CODEX_THREAD_ID, undefined);
  // Metadata was written before the turn finished (visible while active).
  assert.equal(bindingAtRunStart.dispatch.category, 'investigation');
  assert.equal(bindingAtRunStart.dispatch.title, 'Synthetic');
  assert.equal(bindingAtRunStart.parent.thread_id, 'synthetic-thread-id');
  assert.equal(bindingAtRunStart.parent.observed_at, undefined); // new run binds directly
  const projection = await createProjectionReader(f.config.stateDir).read();
  assert.deepEqual(projection.sessions.find(s => s.id === createdId).parent.thread_id, 'synthetic-thread-id');
});

test('a failed order retention leaves runtime behavior intact but warns durably', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  // Force retention to fail by making the requests directory un-creatable: point
  // stateDir's requests path at a file.
  const requestsParent = path.join(f.config.stateDir, 'requests');
  await fs.writeFile(requestsParent, 'blocked', { mode: 0o600 });
  const code = await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], {
    loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {},
  });
  assert.equal(code, 0);
  const receipt = results.at(-1);
  assert.equal(receipt.runtime_status, 'completed');
  assert.equal(receipt.dispatch_warning, 'ORDER_NOT_RETAINED');
  const detail = await createProjectionReader(f.config.stateDir).detail(receipt.session_id);
  assert.equal(detail.turns[0].work_order, null); // nothing retained, honest null
});

test('run/continue/close still work and a title never fabricates acceptance', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} };
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile, '--title', 'T', '--category', 'implementation'], deps), 0);
  const sent = results.at(-1);
  assert.equal(sent.task_acceptance, 'unverified');
  assert.equal(await main(['continue', '--config', f.configFile, '--session', sent.session_id, '--file', f.orderFile], deps), 0);
  const binding = JSON.parse(await fs.readFile(paths(f.config.stateDir, sent.session_id).binding, 'utf8'));
  assert.equal(binding.dispatch.type, 'dispatched');
  assert.equal(binding.dispatch.category, 'implementation');
  assert.equal(await main(['close', '--config', f.configFile, '--session', sent.session_id], deps), 0);
});

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------
test('continue keeps bound metadata and never infers a title from output', () => {
  const binding = { id: randomUUID(), dispatch: { schema: 'cwr.dispatch.binding/1', type: 'dispatched', category: 'review', title: 'Bound' } };
  const plan = classifyTurn(binding, { titleProvided: false });
  assert.equal(plan.type, 'continued'); assert.equal(plan.title, 'Bound'); assert.equal(plan.titleInferred, false);
  assert.equal(planContinuation({ id: randomUUID(), dispatch: { type: 'dispatched' } }), null);
  assert.equal(captureParentMetadata({}), null);
  assert.equal(captureParentMetadata({ CODEX_THREAD_ID: 'bad value' }), null);
  assert.deepEqual(captureParentMetadata({ CODEX_SESSION_ID: 'abc-123' }).session_id, 'abc-123');
});

// End-to-end boundaries that small helper-only fixtures cannot prove.
test('old session without baseline never attributes lifetime tokens to a recent turn', async t => {
  const {stateDir,cleanup}=await syntheticState();t.after(cleanup);const id=randomUUID();
  await writeBinding(stateDir,bindingFor(id,{createdAt:'2026-01-01T00:00:00Z'}));
  await writeReceipt(stateDir,id,receiptFor(id,'later',{started_at:'2026-09-11T00:00:00Z',finished_at:'2026-09-11T01:00:00Z',usage:usage(250)}));
  const p=await createProjectionReader(stateDir).read({since:'2026-09-10',now:Date.parse('2026-09-12')});
  assert.equal(p.summary.external_tokens,null);assert.equal(p.summary.usage_sessions,0);assert.equal(p.summary.usage_total_sessions,1);
});
test('known baseline cannot split a boundary-straddling turn; missing final snapshots stay unknown',()=>{
  const since=at(100);
  for(const list of [[obs('s',50,100,{inPeriod:false}),obs('s',150,200,{straddlesBoundary:true})],[obs('s',50,100,{inPeriod:false}),obs('s',150,200),obs('s',170,null)]]){
    const {acc}=observe(list,{sinceIso:since,createdInPeriod:false});assert.equal(acc.summary.usage_sessions,0);
  }
  const acc=createSessionAccounting({sinceIso:since,now:200});
  const v=acc.observeSession({createdInPeriod:false,observations:[{at:at(50),inPeriod:false,usage:{total:100,input:80,output:20,thought:null}},{at:at(150),inPeriod:true,usage:{total:180,input:140,output:40,thought:null}},{at:at(300),inPeriod:true,usage:{total:999,input:900,output:99,thought:0}}]});
  assert.equal(v.periodDelta,80);assert.deepEqual(v.components,{input:60,output:20,thought:null});
});
test('dangling or forked corrections never count as accepted',()=>{
  const id=randomUUID(),base={...eventInput(id,{kind:'note'}),at:at(1)};
  const dangling={...eventInput(id,{kind:'accepted',supersedes:randomUUID()}),at:at(2)};
  const a={...eventInput(id,{kind:'accepted',supersedes:base.event_id}),at:at(2)};
  const b={...eventInput(id,{kind:'note',supersedes:base.event_id}),at:at(3)};
  assert.equal(foldEvents([dangling]).effective.size,0);
  const folded=foldEvents([base,a,b]);assert.equal(folded.effective.size,0);assert.ok(folded.warnings.includes('event_supersedes_branch'));
});
test('two concurrent corrections cannot fork one event and future targets are rejected',async t=>{
  const {stateDir,cleanup}=await syntheticState();t.after(cleanup);const id=randomUUID();await writeBinding(stateDir,bindingFor(id));
  const base=eventInput(id,{kind:'note'});await recordEvent(stateDir,id,base,{stamp:at(10)});
  await assert.rejects(recordEvent(stateDir,id,eventInput(id,{kind:'note',supersedes:base.event_id}),{stamp:at(1)}),{code:'BAD_EVENT'});
  const results=await Promise.allSettled([1,2].map(()=>recordEvent(stateDir,id,eventInput(id,{kind:'accepted',supersedes:base.event_id}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await createProjectionReader(stateDir).detail(id)).events.length,2);
});
test('a later runtime turn invalidates acceptance and future decisions do not affect current state',async t=>{
  const {stateDir,cleanup}=await syntheticState();t.after(cleanup);const id=randomUUID();await writeBinding(stateDir,bindingFor(id,{createdAt:at(1)}));
  await recordEvent(stateDir,id,eventInput(id,{kind:'accepted'}),{stamp:at(10)});
  await recordEvent(stateDir,id,eventInput(id,{kind:'taken_over',reason:'uncertain'}),{stamp:at(900)});
  await writeReceipt(stateDir,id,receiptFor(id,'later',{started_at:at(20),finished_at:at(30),usage:usage(1)}));
  const p=await createProjectionReader(stateDir).read({now:100});assert.equal(p.sessions[0].acceptance,'unverified');assert.equal(p.summary.accepted,0);assert.equal(p.summary.taken_over,0);
  assert.equal(p.sessions[0].updated_at,at(30));
});
test('events alone do not enter the token coverage denominator',async t=>{
  const {stateDir,cleanup}=await syntheticState();t.after(cleanup);const id=randomUUID();await writeBinding(stateDir,bindingFor(id));
  await recordEvent(stateDir,id,eventInput(id,{kind:'note'}));const p=await createProjectionReader(stateDir).read();assert.equal(p.summary.usage_total_sessions,0);
});
test('directory ancestor aliases are refused for reads and event writes',async t=>{
  const {stateDir,root,cleanup}=await syntheticState();t.after(cleanup);const id=randomUUID();await writeBinding(stateDir,bindingFor(id));
  const alias=path.join(root,'alias');await fs.symlink(stateDir,alias,process.platform==='win32'?'junction':'dir');
  const p=await createProjectionReader(alias).read();assert.equal(p.sessions.length,0);assert.ok(p.warnings.length);
  await assert.rejects(recordEvent(alias,id,eventInput(id,{kind:'note'})),{code:'UNSAFE_DIRECTORY'});
});
test('ISO offsets crossing a UTC day are accepted; invalid calendars and enormous windows are rejected',()=>{
  assert.equal(normalizeSince('2026-01-01T01:00:00+08:00'),'2025-12-31T17:00:00.000Z');
  assert.throws(()=>normalizeSince('2026-02-31T01:00:00+08:00'),{code:'BAD_PERIOD'});
  assert.throws(()=>normalizeSince('99999999999999d'),{code:'BAD_PERIOD'});
});

// ---------------------------------------------------------------------------
// Review state (light/observational): tracking, defaults, invalidations
// ---------------------------------------------------------------------------
const dispatchedMeta = (over = {}) => ({ schema: BINDING_SCHEMA, type: 'dispatched', category: 'other', title: 'Synthetic', ...over });

test('summary.review carries every state key including zeros and agrees with sessions', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  const p = await createProjectionReader(stateDir).read();
  assert.deepEqual(Object.keys(p.summary.review).sort(), [
    'accepted', 'awaiting_review', 'changes_requested', 'legacy_untracked', 'needs_attention', 'no_receipt', 'not_requested', 'taken_over',
  ]);
  assert.equal('unreviewed_closed' in p.summary.review, false);
  for (const value of Object.values(p.summary.review)) assert.equal(typeof value, 'number');
  const session = p.sessions.find(s => s.id === id);
  assert.deepEqual(Object.keys(session.review).sort(), ['decision', 'decision_at', 'state', 'tracked']);
  assert.equal(session.review.tracked, true);
  assert.equal(p.summary.review[session.review_state], 1); // counts agree with the session
});

test('ordinary completed work with no review annotation is not_requested, not an obligation', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  const p = await createProjectionReader(stateDir).read();
  const session = p.sessions.find(s => s.id === id);
  assert.equal(session.review_state, 'not_requested');
  assert.equal(session.acceptance, 'unverified');
  assert.equal(session.review.decision, null);
  assert.equal(p.summary.review.not_requested, 1);
  // Ordinary completion is never a pending review obligation.
  assert.equal((await listPendingSessions(stateDir)).count, 0);
});

test('a tracked responsibility with no receipt is no_receipt, never proof of a running process', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  const p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'no_receipt');
  assert.equal((await listPendingSessions(stateDir)).count, 0);
});

test('a legacy binding with no tracking and no explicit review event is legacy_untracked', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id)); // no dispatch metadata
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1'));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'note', summary: 'observed' }), { stamp: at(30) });
  const p = await createProjectionReader(stateDir).read();
  const session = p.sessions.find(s => s.id === id);
  assert.equal(session.review_state, 'legacy_untracked');
  assert.equal(session.review.tracked, false);
  assert.equal(p.summary.review.legacy_untracked, 1);
  assert.equal((await listPendingSessions(stateDir)).count, 0);
});

test('each explicit review event kind establishes tracking on a legacy binding', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const accept = randomUUID(), takeover = randomUUID(), submit = randomUUID(), revision = randomUUID(), note = randomUUID();
  for (const id of [accept, takeover, submit, revision, note]) {
    await writeBinding(stateDir, bindingFor(id));
    await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(5), finished_at: at(8) }));
  }
  await recordEvent(stateDir, accept, eventInput(accept, { kind: 'accepted' }), { stamp: at(30) });
  await recordEvent(stateDir, takeover, eventInput(takeover, { kind: 'taken_over', reason: 'uncertain' }), { stamp: at(30) });
  await recordEvent(stateDir, submit, eventInput(submit, { kind: 'submitted' }), { stamp: at(30) });
  await recordEvent(stateDir, revision, eventInput(revision, { kind: 'revision_requested', reason: 'uncertain' }), { stamp: at(30) });
  await recordEvent(stateDir, note, eventInput(note, { kind: 'note' }), { stamp: at(30) });
  const p = await createProjectionReader(stateDir).read();
  const byId = Object.fromEntries(p.sessions.map(s => [s.id, s]));
  assert.equal(byId[accept].review_state, 'accepted');
  assert.equal(byId[accept].review.tracked, true);
  assert.equal(byId[accept].acceptance, 'accepted');
  assert.equal(byId[takeover].review_state, 'taken_over');
  assert.equal(byId[takeover].acceptance, 'taken_over');
  assert.equal(byId[submit].review_state, 'awaiting_review');
  assert.equal(byId[submit].acceptance, 'unverified');
  assert.equal(byId[revision].review_state, 'changes_requested');
  // A plain note alone never establishes tracking.
  assert.equal(byId[note].review_state, 'legacy_untracked');
  assert.equal(p.summary.review.legacy_untracked, 1);
  assert.equal(p.summary.review.accepted, 1);
  assert.equal(p.summary.review.taken_over, 1);
  assert.equal(p.summary.review.awaiting_review, 1);
  assert.equal(p.summary.review.changes_requested, 1);
});

test('awaiting_review requires an explicit submitted event, not merely a turn', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const noEvent = randomUUID(), withEvent = randomUUID();
  await writeBinding(stateDir, bindingFor(noEvent, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, noEvent, receiptFor(noEvent, 'req-1'));
  await writeBinding(stateDir, bindingFor(withEvent, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, withEvent, receiptFor(withEvent, 'req-1', { started_at: at(5), finished_at: at(8) }));
  await recordEvent(stateDir, withEvent, eventInput(withEvent, { kind: 'submitted', summary: 'ready for review' }), { stamp: at(30) });
  const p = await createProjectionReader(stateDir).read();
  const byId = Object.fromEntries(p.sessions.map(s => [s.id, s.review_state]));
  assert.equal(byId[noEvent], 'not_requested');
  assert.equal(byId[withEvent], 'awaiting_review');
});

test('a later submitted event invalidates a standing acceptance', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(5), finished_at: at(8) }));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted' }), { stamp: at(30) });
  let p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'accepted');
  await recordEvent(stateDir, id, eventInput(id, { kind: 'submitted', summary: 'new revision' }), { stamp: at(40) });
  p = await createProjectionReader(stateDir).read();
  const session = p.sessions.find(s => s.id === id);
  assert.equal(session.review_state, 'awaiting_review');
  assert.equal(session.acceptance, 'unverified');
  assert.equal(p.summary.review.accepted, 0);
});

test('an accepted decision is invalidated by a later terminal turn', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(5), finished_at: at(8) }));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted' }), { stamp: at(30) });
  await writeReceipt(stateDir, id, receiptFor(id, 'req-2', { started_at: at(40), finished_at: at(50) }));
  const p = await createProjectionReader(stateDir).read();
  const session = p.sessions.find(s => s.id === id);
  assert.equal(session.review_state, 'not_requested');
  assert.equal(session.acceptance, 'unverified');
  assert.equal(p.summary.review.accepted, 0);
});

test('a later successful turn clears an outstanding correction to not_requested', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(5), finished_at: at(8) }));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'revision_requested', reason: 'validation_failed' }), { stamp: at(30) });
  // A note after the revision never clears it.
  await recordEvent(stateDir, id, eventInput(id, { kind: 'note', summary: 'checked' }), { stamp: at(35) });
  let p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'changes_requested');
  // The reworked turn returns successfully and nobody re-requests review.
  await writeReceipt(stateDir, id, receiptFor(id, 'req-2', { started_at: at(40), finished_at: at(50) }));
  p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'not_requested');
});

test('a newer submitted event after a reworked turn re-requests review', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(5), finished_at: at(8) }));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'revision_requested', reason: 'uncertain' }), { stamp: at(20) });
  await writeReceipt(stateDir, id, receiptFor(id, 'req-2', { started_at: at(30), finished_at: at(40) }));
  let p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'not_requested');
  await recordEvent(stateDir, id, eventInput(id, { kind: 'submitted', summary: 'please look again' }), { stamp: at(50) });
  p = await createProjectionReader(stateDir).read();
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'awaiting_review');
});

test('taken_over beats accepted; failed/cancelled/unconfirmed open work is needs_attention', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const take = randomUUID(), failed = randomUUID(), cancelled = randomUUID(), unconfirmed = randomUUID();
  await writeBinding(stateDir, bindingFor(take, { dispatch: dispatchedMeta({ title: 'Take' }) }));
  await recordEvent(stateDir, take, eventInput(take, { kind: 'accepted' }), { stamp: at(10) });
  await recordEvent(stateDir, take, eventInput(take, { kind: 'taken_over', reason: 'environment_blocked' }), { stamp: at(20) });
  await writeBinding(stateDir, bindingFor(failed, { dispatch: dispatchedMeta({ title: 'Failed' }) }));
  await writeReceipt(stateDir, failed, receiptFor(failed, 'req-1', { runtime_status: 'failed' }));
  await writeBinding(stateDir, bindingFor(cancelled, { dispatch: dispatchedMeta({ title: 'Cancelled' }) }));
  await writeReceipt(stateDir, cancelled, receiptFor(cancelled, 'req-1', { runtime_status: 'cancelled' }));
  await writeBinding(stateDir, bindingFor(unconfirmed, { dispatch: dispatchedMeta({ title: 'Unconfirmed' }) }));
  await writeReceipt(stateDir, unconfirmed, receiptFor(unconfirmed, 'req-1', { cleanup: 'unconfirmed' }));
  const p = await createProjectionReader(stateDir).read();
  const byId = Object.fromEntries(p.sessions.map(s => [s.id, s.review_state]));
  assert.equal(byId[take], 'taken_over');
  assert.equal(byId[failed], 'needs_attention');
  assert.equal(byId[cancelled], 'needs_attention');
  assert.equal(byId[unconfirmed], 'needs_attention');
  assert.equal(p.summary.review.taken_over, 1);
  assert.equal(p.summary.review.needs_attention, 3);
});

test('intentionally closed work without a review decision is not_requested, not an obligation', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const closedClean = randomUUID(), closedAccepted = randomUUID(), closedCompromised = randomUUID();
  await writeBinding(stateDir, bindingFor(closedClean, { dispatch: dispatchedMeta({ title: 'ClosedClean' }), closed: true, closedAt: at(60) }));
  await writeReceipt(stateDir, closedClean, receiptFor(closedClean, 'req-1', { started_at: at(10), finished_at: at(20) }));
  await writeBinding(stateDir, bindingFor(closedAccepted, { dispatch: dispatchedMeta({ title: 'ClosedAccepted' }), closed: true, closedAt: at(60) }));
  await writeReceipt(stateDir, closedAccepted, receiptFor(closedAccepted, 'req-1', { started_at: at(10), finished_at: at(20) }));
  await recordEvent(stateDir, closedAccepted, eventInput(closedAccepted, { kind: 'accepted' }), { stamp: at(30) });
  // A closed responsibility whose latest runtime was compromised is still just closed.
  await writeBinding(stateDir, bindingFor(closedCompromised, { dispatch: dispatchedMeta({ title: 'ClosedCompromised' }), closed: true, closedAt: at(60) }));
  await writeReceipt(stateDir, closedCompromised, receiptFor(closedCompromised, 'req-1', { runtime_status: 'failed', started_at: at(10), finished_at: at(20) }));
  const p = await createProjectionReader(stateDir).read();
  const byId = Object.fromEntries(p.sessions.map(s => [s.id, s.review_state]));
  assert.equal(byId[closedClean], 'not_requested');
  assert.equal(byId[closedAccepted], 'accepted');
  assert.equal(byId[closedCompromised], 'not_requested');
  // None of these is a pending review obligation.
  assert.equal((await listPendingSessions(stateDir)).count, 0);
});

test('a closed responsibility can still carry an explicit review request or correction', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const submitted = randomUUID(), revised = randomUUID();
  await writeBinding(stateDir, bindingFor(submitted, { dispatch: dispatchedMeta({ title: 'S' }), closed: true, closedAt: at(60) }));
  await recordEvent(stateDir, submitted, eventInput(submitted, { kind: 'submitted' }), { stamp: at(30) });
  await writeBinding(stateDir, bindingFor(revised, { dispatch: dispatchedMeta({ title: 'R' }), closed: true, closedAt: at(60) }));
  await recordEvent(stateDir, revised, eventInput(revised, { kind: 'revision_requested', reason: 'uncertain' }), { stamp: at(30) });
  const p = await createProjectionReader(stateDir).read();
  const byId = Object.fromEntries(p.sessions.map(s => [s.id, s.review_state]));
  // An explicit review request/correction is still exposed even after closure.
  assert.equal(byId[submitted], 'awaiting_review');
  assert.equal(byId[revised], 'changes_requested');
});

test('future decisions and future turns are ignored by the current review state', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta() }));
  await writeReceipt(stateDir, id, receiptFor(id, 'req-1', { started_at: at(10), finished_at: at(20) }));
  await recordEvent(stateDir, id, eventInput(id, { kind: 'accepted' }), { stamp: at(9000) });
  const p = await createProjectionReader(stateDir).read({ now: Date.parse(at(300)) });
  assert.equal(p.sessions.find(s => s.id === id).review_state, 'not_requested');
  assert.equal(p.summary.review.accepted, 0);
});

test('deriveReviewState is a pure, source-honest projection of the evidence', () => {
  const id = randomUUID();
  const event = (kind, ms) => ({ ...eventInput(id, { kind, reason: kind === 'revision_requested' ? 'uncertain' : null }), at: at(ms) });
  const meta = dispatchedMeta();
  assert.equal(deriveReviewState({ meta: null, effective: [], turns: [] }).state, 'legacy_untracked');
  assert.equal(deriveReviewState({ meta, effective: [], turns: [] }).state, 'no_receipt');
  assert.equal(deriveReviewState({ meta: null, effective: [event('accepted', 10)], turns: [] }).state, 'accepted');
  assert.equal(deriveReviewState({ meta, effective: [event('accepted', 10)], turns: [{ runtime_status: 'completed', started_at: at(20), finished_at: at(30) }] }).state, 'not_requested');
  assert.equal(deriveReviewState({ meta, effective: [event('submitted', 10)], turns: [] }).state, 'awaiting_review');
  assert.equal(deriveReviewState({ meta, effective: [event('accepted', 10)], turns: [], closed: true }).state, 'accepted');
});

// ---------------------------------------------------------------------------
// pending: actionable only, on demand, no legacy backlog
// ---------------------------------------------------------------------------
test('pending returns only actionable records and never legacy or ordinary completion', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const submitted = randomUUID(), legacy = randomUUID(), normal = randomUUID(), accepted = randomUUID(), changes = randomUUID(), needs = randomUUID(), closed = randomUUID();
  await writeBinding(stateDir, bindingFor(submitted, { dispatch: dispatchedMeta({ title: 'Awaiting' }) }));
  await recordEvent(stateDir, submitted, eventInput(submitted, { kind: 'submitted' }), { stamp: at(10) });
  await writeBinding(stateDir, bindingFor(legacy)); // untracked, with a note
  await writeReceipt(stateDir, legacy, receiptFor(legacy, 'req-1'));
  await recordEvent(stateDir, legacy, eventInput(legacy, { kind: 'note' }), { stamp: at(10) });
  await writeBinding(stateDir, bindingFor(normal, { dispatch: dispatchedMeta({ title: 'Normal' }) })); // ordinary completion
  await writeReceipt(stateDir, normal, receiptFor(normal, 'req-1'));
  await writeBinding(stateDir, bindingFor(accepted, { dispatch: dispatchedMeta({ title: 'Done' }) }));
  await recordEvent(stateDir, accepted, eventInput(accepted, { kind: 'accepted' }), { stamp: at(10) });
  await writeBinding(stateDir, bindingFor(changes, { dispatch: dispatchedMeta({ title: 'Rework' }) }));
  await recordEvent(stateDir, changes, eventInput(changes, { kind: 'revision_requested', reason: 'scope_changed' }), { stamp: at(10) });
  await writeBinding(stateDir, bindingFor(needs, { dispatch: dispatchedMeta({ title: 'Broken' }) }));
  await writeReceipt(stateDir, needs, receiptFor(needs, 'req-1', { runtime_status: 'failed' }));
  await writeBinding(stateDir, bindingFor(closed, { dispatch: dispatchedMeta({ title: 'Closed' }), closed: true, closedAt: at(60) }));
  await writeReceipt(stateDir, closed, receiptFor(closed, 'req-1'));
  const pending = await listPendingSessions(stateDir);
  const ids = pending.records.map(r => r.session_id);
  assert.equal(pending.schema, 'cwr.dispatch.pending/1');
  assert.equal(pending.count, 3);
  assert.ok(ids.includes(submitted));
  assert.ok(ids.includes(changes));
  assert.ok(ids.includes(needs));
  assert.ok(!ids.includes(legacy));   // legacy is quietly historical
  assert.ok(!ids.includes(normal));   // ordinary completion is not an obligation
  assert.ok(!ids.includes(accepted)); // a current decision needs no action
  assert.ok(!ids.includes(closed));   // intentional closure is not an obligation
  for (const record of pending.records) {
    assert.deepEqual(Object.keys(record).sort(), ['closed', 'review_state', 'session_id', 'status', 'title', 'updated_at']);
    assert.ok(['awaiting_review', 'changes_requested', 'needs_attention'].includes(record.review_state));
  }
});

test('pending never leaks work-order text, output, paths or diagnostics', async t => {
  const { stateDir, cleanup } = await syntheticState(); t.after(cleanup);
  const id = randomUUID();
  await writeBinding(stateDir, bindingFor(id, { dispatch: dispatchedMeta({ title: 'Safe title' }) }));
  await writeReceipt(stateDir, id, { ...receiptFor(id, 'req-1', { output_excerpt: 'RAW_OUTPUT_SECRET' }), transcript_state_dir: '/synthetic/private/acpx', receipt_path: '/synthetic/private/receipt.json' });
  await writeRequestOrder(stateDir, id, 'req-1', 'WORK_ORDER_SECRET');
  await recordEvent(stateDir, id, eventInput(id, { kind: 'submitted' }), { stamp: at(30) });
  const pending = await listPendingSessions(stateDir);
  const serialized = JSON.stringify(pending);
  for (const secret of ['RAW_OUTPUT_SECRET', 'WORK_ORDER_SECRET', '/synthetic/private']) assert.ok(!serialized.includes(secret), `pending leaked ${secret}`);
});

test('pending prints actionable review records without loading an adapter', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const id = randomUUID();
  await writeBinding(f.config.stateDir, bindingFor(id, { dispatch: dispatchedMeta({ title: 'Review me' }) }));
  await recordEvent(f.config.stateDir, id, eventInput(id, { kind: 'submitted' }), { stamp: at(30) });
  let adapterLoads = 0;
  const out = [];
  assert.equal(await main(['pending', '--config', f.configFile], { output: r => out.push(r), loadAcpx: async () => { adapterLoads++; throw new Error('no adapter'); } }), 0);
  const pending = out.at(-1);
  assert.equal(pending.schema, 'cwr.dispatch.pending/1');
  assert.ok(pending.records.some(r => r.session_id === id && r.review_state === 'awaiting_review'));
  assert.equal(adapterLoads, 0);
});

// ---------------------------------------------------------------------------
// continue --revision-reason: optional shortcut, never blocks the task
// ---------------------------------------------------------------------------
test('continue --revision-reason records a revision_requested without a separate file', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} };
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = results.at(-1).session_id;
  assert.equal(await main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile, '--revision-reason', 'requirement_missed'], deps), 0);
  const detail = await createProjectionReader(f.config.stateDir).detail(id);
  assert.equal(detail.events.filter(e => e.kind === 'revision_requested').length, 1);
  assert.equal(detail.session.revisions, 1);
  assert.equal(detail.session.acceptance, 'unverified');
  // The continuation's own successful turn clears the correction to not_requested.
  assert.equal(detail.session.review_state, 'not_requested');
});

test('a plain continue never fabricates a revision', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} };
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = results.at(-1).session_id;
  assert.equal(await main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), 0);
  const detail = await createProjectionReader(f.config.stateDir).detail(id);
  assert.equal(detail.events.length, 0);
  assert.equal(detail.session.review_state, 'not_requested');
});

test('an invalid --revision-reason is rejected before any prompt', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} };
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = results.at(-1).session_id;
  const startsBefore = api.calls.filter(c => c[0] === 'start').length;
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile, '--revision-reason', 'not_a_reason'], deps), { code: 'USAGE' });
  assert.equal(api.calls.filter(c => c[0] === 'start').length, startsBefore);
});

test('a --revision-reason annotation write failure still runs the authorized task exactly once', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  const progress = [];
  const deps = { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: s => progress.push(s) };
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], deps), 0);
  const id = results.at(-1).session_id;
  const startsBefore = api.calls.filter(c => c[0] === 'start').length;
  // Force the revision annotation write to fail: the events path is a file.
  await fs.writeFile(path.join(f.config.stateDir, 'events'), 'blocked', { mode: 0o600 });
  assert.equal(await main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile, '--revision-reason', 'uncertain'], deps), 0);
  // Exactly one turn executed, the receipt exposes the additive warning, and the
  // owned locks were released.
  assert.equal(api.calls.filter(c => c[0] === 'start').length, startsBefore + 1);
  assert.equal(results.at(-1).dispatch_warning, 'REVIEW_NOT_RECORDED');
  assert.ok(progress.join('').includes('revision annotation not recorded'));
  await fs.lstat(paths(f.config.stateDir, id).lock).then(() => { throw new Error('session lock retained'); }, e => assert.equal(e.code, 'ENOENT'));
  await fs.lstat(path.join(f.config.stateDir, 'workspace-locks', digest(f.selection.cwd))).then(() => { throw new Error('workspace lock retained'); }, e => assert.equal(e.code, 'ENOENT'));
});

// ---------------------------------------------------------------------------
// Concurrency: fresh binding read under the lock
// ---------------------------------------------------------------------------
test('a continue whose binding becomes closed before lock acquisition does not prompt or record', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} }), 0);
  const id = results.at(-1).session_id;
  const startsBefore = api.calls.filter(c => c[0] === 'start').length;
  const deps = {
    loadAcpx: async () => api, output: r => results.push(r), progress: () => {},
    replaceEnvironment: async () => {
      const stored = JSON.parse(await fs.readFile(paths(f.config.stateDir, id).binding, 'utf8'));
      await writeBinding(f.config.stateDir, { ...stored, closed: true, closedAt: at(Date.now()) });
    },
  };
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), { code: 'SESSION_CLOSED' });
  // No adapter prompt happened and the owned locks were released.
  assert.equal(api.calls.filter(c => c[0] === 'start').length, startsBefore);
  await fs.lstat(paths(f.config.stateDir, id).lock).then(() => { throw new Error('session lock retained'); }, e => assert.equal(e.code, 'ENOENT'));
  await fs.lstat(path.join(f.config.stateDir, 'workspace-locks', digest(f.selection.cwd))).then(() => { throw new Error('workspace lock retained'); }, e => assert.equal(e.code, 'ENOENT'));
});

test('a continue --revision-reason whose binding becomes closed adds no revision event', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} }), 0);
  const id = results.at(-1).session_id;
  const deps = {
    loadAcpx: async () => api, output: r => results.push(r), progress: () => {},
    replaceEnvironment: async () => {
      const stored = JSON.parse(await fs.readFile(paths(f.config.stateDir, id).binding, 'utf8'));
      await writeBinding(f.config.stateDir, { ...stored, closed: true, closedAt: at(Date.now()) });
    },
  };
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile, '--revision-reason', 'uncertain'], deps), { code: 'SESSION_CLOSED' });
  const detail = await createProjectionReader(f.config.stateDir).detail(id);
  assert.equal(detail.events.length, 0); // no revision event was appended
});

test('a continue whose route fingerprint changes before lock acquisition is refused', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const api = fakeAcpx();
  const results = [];
  assert.equal(await main(['run', '--config', f.configFile, '--route', 'worker', '--cwd', f.cwd, '--file', f.orderFile], { loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} }), 0);
  const id = results.at(-1).session_id;
  const startsBefore = api.calls.filter(c => c[0] === 'start').length;
  const deps = {
    loadAcpx: async () => api, output: r => results.push(r), progress: () => {},
    replaceEnvironment: async () => {
      const stored = JSON.parse(await fs.readFile(paths(f.config.stateDir, id).binding, 'utf8'));
      await writeBinding(f.config.stateDir, { ...stored, routeFingerprint: 'changed-fingerprint' });
    },
  };
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), { code: 'ROUTE_CHANGED' });
  assert.equal(api.calls.filter(c => c[0] === 'start').length, startsBefore);
});

// ---------------------------------------------------------------------------
// CLI parser / removed commands
// ---------------------------------------------------------------------------
test('pending and optional revision reason use their documented parser contracts', () => {
  assert.equal(parseArgs(['continue', '--config', 'c', '--session', 's', '--file', 'f', '--revision-reason', 'uncertain'])['revision-reason'], 'uncertain');
  assert.equal(parseArgs(['pending', '--config', '/x.json']).command, 'pending');
  assert.throws(() => parseArgs(['pending']), { code: 'USAGE' });
  assert.throws(() => parseArgs(['pending', '--config', 'c', '--since', '7d']), { code: 'USAGE' });
});

test('a later failed result cannot revive an old acceptance after closing',()=>{
  const meta={schema:BINDING_SCHEMA,type:'dispatched'};
  const effective=[{kind:'accepted',at:'2026-01-01T01:00:00Z'}];
  const turns=[{runtime_status:'failed',finished_at:'2026-01-01T02:00:00Z',cleanup:'confirmed'}];
  assert.equal(deriveReviewState({meta,effective,turns}).state,'needs_attention');
  assert.equal(deriveReviewState({meta,effective,turns,closed:true}).state,'not_requested');
  assert.equal(deriveReviewState({meta,effective:[],turns:[],closed:true}).state,'not_requested');
});
