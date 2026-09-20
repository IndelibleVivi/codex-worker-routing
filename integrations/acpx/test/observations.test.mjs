// SPDX-License-Identifier: SUL-1.0
// Truthful runtime observation tests. All values are synthetic: no provider call,
// no receipt directory, no real quota or rate-limit data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createObservationCollector, normalizeObservations, aggregateObservations,
  MAX_OBSERVATIONS, OBSERVATION_COVERAGE,
} from '../src/observations.mjs';

const fixedNow = () => '2026-09-19T00:00:00.000Z';

test('a structured runtime failure is captured as a typed runtime code', () => {
  const collector = createObservationCollector({ requestId: 'req-1', now: fixedNow });
  collector.observeTurnResult({ status: 'failed', error: { message: 'raw provider text', code: 'RUNTIME', detailCode: 'AUTH_REQUIRED', retryable: true } });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.coverage, 'runtime_codes_only');
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual(snapshot.events[0], {
    at: '2026-09-19T00:00:00.000Z', source: 'acpx.runtime', kind: 'runtime_code',
    request_id: 'req-1', code: 'RUNTIME', detail_code: 'AUTH_REQUIRED', retryable: true,
  });
});

test('a completion with no structured error records nothing and claims no coverage', () => {
  const collector = createObservationCollector({ requestId: 'req-1', now: fixedNow });
  collector.observeTurnResult({ status: 'completed', stopReason: 'end_turn' });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.coverage, 'none');
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.omitted, 0);
});

test('prose is never parsed into a code: a text/log/worker quote is not an HTTP 429', () => {
  const collector = createObservationCollector({ requestId: 'req-1', now: fixedNow });
  // A message that only LOOKS like a rate limit must not become a structured fact.
  collector.observeTurnResult({ status: 'failed', error: { message: 'HTTP 429 rate limit exceeded, retry after 30s' } });
  collector.observeTurnResult({ status: 'failed', error: { message: '429', code: 'not a code' } });
  collector.observeTurnResult({ status: 'failed', error: { message: 'server said 429' } });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.coverage, 'none');
  // No fabricated HTTP status or retry hint ever appears.
  assert.ok(!JSON.stringify(snapshot).includes('429'));
  assert.ok(!JSON.stringify(snapshot).includes('http_status'));
});

test('a numeric json-rpc code alone is not treated as a confirmed HTTP status', () => {
  const collector = createObservationCollector({ requestId: 'req-1', now: fixedNow });
  // A deep rpc object is not a top-level verified field on the terminal result.
  collector.observeTurnResult({ status: 'failed', error: { message: 'x', acp: { code: 429 } } });
  const snapshot = collector.snapshot();
  assert.equal(snapshot.events.length, 0);
});

test('observation collection is bounded and deduplicates identical events', () => {
  const collector = createObservationCollector({ requestId: 'req-1', now: fixedNow });
  // The same fact repeated (same kind+code+instant) is one observation.
  for (let i = 0; i < 5; i++) collector.observeTurnResult({ status: 'failed', error: { code: 'TIMEOUT', retryable: false } });
  const deduped = collector.snapshot();
  assert.equal(deduped.events.length, 1);

  const bounded = createObservationCollector({ requestId: 'req-2', now: () => new Date().toISOString() });
  for (let i = 0; i < MAX_OBSERVATIONS + 5; i++) bounded.observeTurnResult({ status: 'failed', error: { code: 'RUNTIME', detailCode: `D${i}` } });
  const snapshot = bounded.snapshot();
  assert.equal(snapshot.events.length, MAX_OBSERVATIONS);
  assert.equal(snapshot.omitted, 5);
});

test('observeTurnResult is nonthrowing on hostile inputs', () => {
  const collector = createObservationCollector({});
  for (const bad of [null, undefined, 42, 'text', [], { status: 'failed' }, { status: 'failed', error: null }, { status: 'failed', error: [] }]) {
    assert.doesNotThrow(() => collector.observeTurnResult(bad));
  }
  assert.equal(collector.snapshot().events.length, 0);
});

test('normalizeObservations drops prose/paths and keeps only verified shapes', () => {
  const raw = {
    coverage: 'runtime_codes_only',
    omitted: 2,
    events: [
      { at: '2026-09-19T00:00:00.000Z', source: 'acpx.runtime', kind: 'runtime_code', code: 'TIMEOUT', retryable: false, message: 'SECRET_PATH /home/private', headers: { authorization: 'x' } },
      { at: 'not-a-date', kind: 'runtime_code', code: 'RUNTIME' },
      { at: '2026-09-19T01:00:00.000Z', kind: 'note', text: 'prose is not allowed' },
    ],
  };
  const normalized = normalizeObservations(raw, { requestId: 'req-1' });
  assert.equal(normalized.coverage, 'runtime_codes_only');
  assert.equal(normalized.omitted, 2);
  assert.equal(normalized.events.length, 1);
  assert.equal(normalized.events[0].code, 'TIMEOUT');
  assert.equal(normalized.events[0].request_id, 'req-1');
  const serialized = JSON.stringify(normalized);
  assert.ok(!serialized.includes('SECRET_PATH'));
  assert.ok(!serialized.includes('message'));
  assert.ok(!serialized.includes('headers'));
});

test('unsupported HTTP and retry fields cannot turn a runtime code into confirmed rate limiting', () => {
  const numeric = normalizeObservations({ coverage: 'runtime_codes_only', events: [{ at: '2026-09-19T00:00:00Z', kind: 'runtime_code', code: 'RUNTIME', http_status: 429, retry_after_ms: 30000 }] });
  assert.equal(numeric.events[0].http_status, undefined);
  assert.equal(numeric.events[0].retry_after_ms, undefined);
  assert.equal(aggregateObservations([{observations:numeric}]).http_429_count, 0);
});

test('aggregate observations describe observations, not inferred requests', () => {
  const notes = aggregateObservations([
    { session_id: 'a', observations: normalizeObservations({ coverage: 'runtime_codes_only', events: [{ at: '2026-09-19T00:00:00.000Z', kind: 'runtime_code', code: 'TIMEOUT' }], omitted: 1 }) },
    { session_id: 'b', observations: normalizeObservations({ coverage: 'none', events: [] }) },
  ]);
  assert.deepEqual(notes, { coverage: 'runtime_codes_only', events: 1, session_count: 1, http_429_count: 0, omitted: 1 });
  // An empty aggregate reports absent coverage, which is NOT evidence of no limiting.
  assert.deepEqual(aggregateObservations([]), { coverage: 'none', events: 0, session_count: 0, http_429_count: 0, omitted: 0 });
});

test('the coverage vocabulary is limited to the two honest values', () => {
  assert.deepEqual([...OBSERVATION_COVERAGE], ['none', 'runtime_codes_only']);
});
