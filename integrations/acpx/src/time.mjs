// SPDX-License-Identifier: SUL-1.0
// Pure time-zone helpers shared by the Node projection and the browser UI.
//
// This module is deliberately dependency-free and side-effect-free so the same
// source can be imported by the dashboard server, the CLI and a browser through
// the existing `/time.mjs` module route. Canonical instants are always UTC; a
// display zone only changes how an instant is placed on a calendar day. It never
// redefines a rolling period boundary.

// Resolve a caller-supplied display zone to a VALID IANA zone name.
//
// - An omitted/empty value falls back to `fallback` (default 'UTC').
// - A syntactically valid IANA zone is returned in the canonical spelling that
//   the runtime reports (`'asia/singapore'` -> `'Asia/Singapore'`), so equality
//   and grouping are stable.
// - A literal 'UTC'/'utc' always resolves to 'UTC' even where the runtime
//   canonicalizes it to 'Etc/UTC'.
// - An explicit but invalid zone THROWS a RangeError rather than silently
//   treating the caller's intent as UTC: a wrong calendar is worse than a
//   surfaced failure. The projection maps this to Fault('BAD_TIME_ZONE').
export function resolveTimeZone(value, fallback = 'UTC') {
  const requested = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof requested !== 'string') throw new RangeError('Time zone must be a string.');
  if (requested.trim() === '') throw new RangeError('Time zone cannot be blank.');
  const spec = requested.trim();
  if (/^utc$/i.test(spec)) return 'UTC';
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: spec }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(`Unknown time zone: ${spec}`);
  }
  if (typeof resolved !== 'string' || !resolved) throw new RangeError(`Unknown time zone: ${spec}`);
  return /^utc$/i.test(resolved) ? 'UTC' : resolved;
}

const formatterCache = new Map();
function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Local calendar day (YYYY-MM-DD) of an ISO instant in the given zone.
//
// Returns null for a value that is not a parseable instant, so an unreadable
// timestamp stays unknown instead of becoming an accidental "today". The zone is
// assumed already resolved; an invalid zone therefore surfaces as a RangeError.
export function dayKey(iso, timeZone = 'UTC') {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null;
  const zone = timeZone === undefined || timeZone === null || timeZone === '' ? 'UTC' : timeZone;
  const parts = partsFormatter(zone).formatToParts(new Date(iso));
  const pick = type => parts.find(p => p.type === type)?.value;
  const year = pick('year'), month = pick('month'), day = pick('day');
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}
