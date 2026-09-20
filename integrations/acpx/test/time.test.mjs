// SPDX-License-Identifier: SUL-1.0
// Pure time-zone helper tests. No filesystem, no fixtures, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeZone, dayKey } from '../src/time.mjs';

test('resolveTimeZone canonicalizes an IANA zone and defaults to UTC', () => {
  assert.equal(resolveTimeZone(undefined), 'UTC');
  assert.equal(resolveTimeZone(null), 'UTC');
  assert.equal(resolveTimeZone(''), 'UTC');
  assert.equal(resolveTimeZone('utc'), 'UTC');
  assert.equal(resolveTimeZone('UTC'), 'UTC');
  assert.equal(resolveTimeZone('asia/singapore'), 'Asia/Singapore');
  assert.equal(resolveTimeZone('Asia/Singapore'), 'Asia/Singapore');
  assert.equal(resolveTimeZone(undefined, 'Asia/Singapore'), 'Asia/Singapore');
});

test('an invalid explicit zone throws rather than silently becoming UTC', () => {
  for (const bad of ['Not/AZone', 'Mars/Olympus', 'FooBar', 42, {}, ' ']) {
    assert.throws(() => resolveTimeZone(bad), RangeError);
  }
});

test('dayKey places a UTC instant on the +08 calendar day (cross-midnight)', () => {
  // 2026-09-19T20:00:00Z is 2026-09-20 04:00 in Singapore.
  assert.equal(dayKey('2026-09-19T20:00:00.000Z', 'Asia/Singapore'), '2026-09-20');
  // 2026-09-19T16:00:00Z is 2026-09-20 00:00 in Singapore.
  assert.equal(dayKey('2026-09-19T16:00:00.000Z', 'Asia/Singapore'), '2026-09-20');
  // 2026-09-19T15:59:59Z is still 2026-09-19 23:59 in Singapore.
  assert.equal(dayKey('2026-09-19T15:59:59.000Z', 'Asia/Singapore'), '2026-09-19');
});

test('dayKey handles fractional offsets and the UTC default', () => {
  // Kolkata is UTC+05:30.
  assert.equal(dayKey('2026-09-19T18:29:00.000Z', 'Asia/Kolkata'), '2026-09-19');
  assert.equal(dayKey('2026-09-19T18:30:00.000Z', 'Asia/Kolkata'), '2026-09-20');
  assert.equal(dayKey('2026-09-19T23:30:00.000Z', 'UTC'), '2026-09-19');
  assert.equal(dayKey('2026-09-19T23:30:00.000Z'), '2026-09-19');
});

test('dayKey follows DST transitions on the wall clock', () => {
  // US DST begins 2026-03-08 at 02:00 local (America/New_York, UTC-5 -> UTC-4).
  assert.equal(dayKey('2026-03-08T06:30:00.000Z', 'America/New_York'), '2026-03-08');
  assert.equal(dayKey('2026-03-08T04:30:00.000Z', 'America/New_York'), '2026-03-07');
  // US DST ends 2026-11-01 at 02:00 local.
  assert.equal(dayKey('2026-11-01T05:30:00.000Z', 'America/New_York'), '2026-11-01');
  assert.equal(dayKey('2026-11-01T03:30:00.000Z', 'America/New_York'), '2026-10-31');
});

test('dayKey returns null for an unparseable instant instead of guessing today', () => {
  for (const bad of [undefined, null, '', 'not-a-date', 0, {}]) assert.equal(dayKey(bad, 'Asia/Singapore'), null);
});

test('changing the display zone does not move the canonical instant', () => {
  const instant = '2026-09-19T20:00:00.000Z';
  assert.equal(Date.parse(instant), Date.parse(new Date(instant).toISOString()));
  assert.equal(dayKey(instant, 'UTC'), '2026-09-19');
  assert.equal(dayKey(instant, 'Asia/Singapore'), '2026-09-20');
});
