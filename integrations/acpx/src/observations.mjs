// SPDX-License-Identifier: SUL-1.0
// Truthful runtime observations for a single ACP turn.
//
// The collector records ONLY verified structured fields that the installed
// acpx@0.15.1 runtime actually exposes on its terminal result. It never parses
// prose, never copies a raw message/header/path, and never upgrades a
// text/log/worker quote into a structured claim.
//
// CAPABILITY FINDING (acpx 0.15.1):
//   `AcpRuntimeTurnResult` for `status:'failed'` is
//     { status:'failed', error:{ message, code?, detailCode?, retryable? } }
//   where `code` is one of the runtime OUTPUT_ERROR_CODES
//     NO_SESSION | TIMEOUT | PERMISSION_DENIED | PERMISSION_PROMPT_UNAVAILABLE |
//     RUNTIME | USAGE
//   and `detailCode` is a stable enum string. There is NO provider HTTP status
//   field and NO `retry_after`. A JSON-RPC numeric code may exist deep inside the
//   adapter error, and the runtime's own `retryable` boolean is derived from it,
//   but that is NOT a confirmed HTTP status. `429` never appears as a structured
//   field anywhere on the public surface, so `http_status` and `retry_after_ms`
//   are intentionally never populated. Coverage is therefore
//   'runtime_codes_only', and a zero HTTP-429 count is a capability limit, not
//   evidence that no provider rate limiting occurred.

export const OBSERVATION_SCHEMA = 'cwr.dispatch.observations/1';
// Coverage values describe how much structured runtime detail was actually
// available for a receipt. 'runtime_codes_only' is the honest acpx 0.15.1 state.
export const OBSERVATION_COVERAGE = Object.freeze(['none', 'runtime_codes_only']);
// Facts we CAN verify from the terminal result.
const RUNTIME_CODES = Object.freeze(['NO_SESSION', 'TIMEOUT', 'PERMISSION_DENIED', 'PERMISSION_PROMPT_UNAVAILABLE', 'RUNTIME', 'USAGE']);
const RUNTIME_CODE_RE = /^[A-Z0-9_]{1,80}$/;
const DETAIL_CODE_RE = /^[A-Z0-9_]{1,80}$/;
const SOURCE = 'acpx.runtime';
// A single turn cannot accumulate more observations than this. The bound keeps
// the receipt small even under a pathological adapter.
export const MAX_OBSERVATIONS = 16;

const isoOrNull = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

/**
 * A bounded, nonthrowing observation collector for ONE turn.
 *
 * It runs on the engine's existing event loop and does no provider calls, no
 * writes and no asynchronous work, so it can never alter the terminal result or
 * require a review stamp. Its event API intentionally accepts only typed,
 * pre-validated facts; there is deliberately no `note(text)` entry point.
 */
export function createObservationCollector({ requestId = null, now = () => new Date().toISOString() } = {}) {
  const events = [];
  const seen = new Set();
  let omitted = 0;

  const push = event => {
    const key = `${event.kind}|${event.code ?? ''}|${event.detail_code ?? ''}|${event.at}`;
    if (seen.has(key)) return; // dedup identical observations
    if (events.length >= MAX_OBSERVATIONS) { omitted += 1; return; }
    seen.add(key);
    events.push(event);
  };

  return {
    /**
     * Record the runtime's terminal failure classification. Only an explicit,
     * allowlisted runtime/output code is copied; `retryable` is copied verbatim
     * as a boolean. A bare message, a provider name or a text quote is IGNORED.
     */
    observeTurnResult(result) {
      const error = result && typeof result === 'object' ? result.error : null;
      if (!error || typeof error !== 'object') return;
      const code = typeof error.code === 'string' && RUNTIME_CODE_RE.test(error.code) ? error.code : null;
      const detailCode = typeof error.detailCode === 'string' && DETAIL_CODE_RE.test(error.detailCode) ? error.detailCode : null;
      const retryable = typeof error.retryable === 'boolean' ? error.retryable : undefined;
      // If the runtime exposed nothing structured, record nothing: an unstructured
      // failure is visible through the existing receipt.error_code.
      // Only the runtime's own OUTPUT_ERROR_CODES are recorded as `code`. A LOCAL
      // integration code (e.g. STREAM_ERROR, CONTINUITY_LOST) is not a runtime or
      // provider classification and is never promoted into a runtime observation;
      // a `detailCode` may still be recorded when the runtime classified the turn.
      const runtimeCode = RUNTIME_CODES.includes(code) ? code : null;
      if (!runtimeCode && !detailCode) return;
      const event = { at: isoOrNull(now()) ?? new Date().toISOString(), source: SOURCE, kind: 'runtime_code', request_id: requestId };
      if (runtimeCode !== null) event.code = runtimeCode;
      if (detailCode !== null) event.detail_code = detailCode;
      if (retryable !== undefined) event.retryable = retryable;
      // http_status / retry_after_ms are NEVER set here: acpx 0.15.1 exposes no
      // verified HTTP field. The keys are documented for forward compatibility.
      push(event);
    },
    /** Shrink to the persisted receipt shape; coverage reflects what was seen. */
    snapshot() {
      return {
        coverage: events.length ? 'runtime_codes_only' : 'none',
        events: events.map(event => ({ ...event })),
        omitted,
      };
    },
  };
}

/**
 * Normalize a stored `receipt.observations` for the projection. Only shape-valid
 * fields survive; anything unrecognized (including a hand-edited file or a future
 * adapter) is dropped rather than trusted. Prose, paths and raw messages are never
 * present in the shape, so they cannot leak even if a file contains them.
 */
export function normalizeObservations(raw, { requestId = null } = {}) {
  const result = { coverage: 'none', events: [], omitted: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  if (raw.coverage === 'runtime_codes_only' || raw.coverage === 'none') result.coverage = raw.coverage;
  if (Number.isSafeInteger(raw.omitted) && raw.omitted >= 0) result.omitted = raw.omitted;
  const events = Array.isArray(raw.events) ? raw.events : [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const at = isoOrNull(event.at);
    if (!at) continue;
    const kind = event.kind === 'runtime_code' ? event.kind : null;
    if (!kind) continue;
    const normalized = { at, source: typeof event.source === 'string' && event.source.length <= 40 ? event.source : SOURCE, kind, request_id: typeof event.request_id === 'string' && event.request_id.length <= 160 ? event.request_id : (requestId ?? null) };
    if (typeof event.code === 'string' && RUNTIME_CODE_RE.test(event.code)) normalized.code = event.code;
    if (typeof event.detail_code === 'string' && DETAIL_CODE_RE.test(event.detail_code)) normalized.detail_code = event.detail_code;
    // acpx 0.15.1 has no verified HTTP/retry fields; unsupported stored fields stay excluded.
    if (typeof event.retryable === 'boolean') normalized.retryable = event.retryable;
    result.events.push(normalized);
  }
  result.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (result.coverage === 'none' && result.events.length) result.coverage = 'runtime_codes_only';
  return result;
}

// Bounded aggregate for the snapshot. This counts OBSERVATIONS, never inferred
// requests: a repeated code is not proof of a retry, and a completed turn after a
// transient observation does not prove causation or recovery.
export function aggregateObservations(perSession) {
  let events = 0, omitted = 0, http429 = 0, sessions = 0;
  let anyRuntimeCodes = false;
  for (const entry of perSession) {
    const normalized = entry.observations;
    if (!normalized) continue;
    if (normalized.events.length) sessions += 1;
    events += normalized.events.length;
    omitted += Number.isSafeInteger(normalized.omitted) ? normalized.omitted : 0;
    if (normalized.coverage === 'runtime_codes_only') anyRuntimeCodes = true;
    for (const event of normalized.events) if (event.http_status === 429) http429 += 1;
  }
  return {
    coverage: anyRuntimeCodes ? 'runtime_codes_only' : 'none',
    events,
    session_count: sessions,
    http_429_count: http429,
    omitted,
  };
}
