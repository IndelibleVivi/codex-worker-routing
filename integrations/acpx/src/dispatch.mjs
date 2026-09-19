// SPDX-License-Identifier: SUL-1.0
// Dispatch: the private append-only collaboration event store and the
// read-only projection derived from bindings, receipts and events.
//
// Runtime receipts stay runtime truth. Collaboration events are a separate,
// coordinator-authored append-only record: nothing here rewrites a receipt,
// converts runtime completion into engineering acceptance, or fabricates an
// accepted state. Every projection field is allowlisted metadata; work-order and
// output text are reachable only through detail().
//
// Public projection interface (async methods):
//   createProjectionReader(stateDir) -> {
//     read({ since = 'all', now = Date.now() } = {}),
//     detail(sessionId),
//   }
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, atomicJSON, privateDir, regular, readJSON, lock, sessionId } from './state.mjs';

export const EVENT_SCHEMA = 'cwr.dispatch.event/1';
export const PROJECTION_SCHEMA = 'cwr.dispatch/1';
export const BINDING_SCHEMA = 'cwr.dispatch.binding/1';
export const PARENT_SCHEMA = 'cwr.dispatch.parent/1';
export const ORDER_SCHEMA = 'cwr.dispatch.order/1';
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPAQUE_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const EVENT_KINDS = Object.freeze(['submitted', 'revision_requested', 'accepted', 'taken_over', 'note']);
export const REASON_VALUES = Object.freeze(['requirement_missed', 'validation_failed', 'scope_changed', 'constraint_added', 'environment_blocked', 'uncertain']);
const EVIDENCE_SOURCES = Object.freeze(['coordinator', 'worker']);
const EVIDENCE_KINDS = Object.freeze(['diff', 'test', 'manual', 'other']);
const CATEGORIES = Object.freeze(['investigation', 'implementation', 'review', 'other']);
// Mutually exclusive review states, derived only from source evidence. This is
// the interface main uses as `session.review_state` / `session.review.state` and
// `summary.review.<state>`; every key is always present, including zeros.
// `not_requested` is the ordinary, common state: runtime facts are automatic and
// no review was asked for. Statistics stay light and observational — no stamp is
// required after every delegation.
const REVIEW_STATES = Object.freeze([
  'accepted', 'taken_over', 'awaiting_review', 'changes_requested', 'needs_attention',
  'no_receipt', 'not_requested', 'legacy_untracked',
]);
// On-demand, read-only actionable review records that `pending` returns, newest
// first: an explicit review request, an unreturned correction, or a compromised
// open runtime. Ordinary completion or closure without a review annotation is
// normal and is NOT an outstanding review obligation.
const ACTIONABLE_REVIEW_STATES = Object.freeze(['awaiting_review', 'changes_requested', 'needs_attention']);
// Kinds that are explicit review evidence: they establish tracking on a legacy
// binding, and they participate in the chronological review derivation.
// `accepted`/`taken_over` set a decision; `submitted` is an explicit review
// request; `revision_requested` is an explicit correction. `note` is an
// observation only and never creates a review obligation or tracking.
const REVIEW_TRACKING_KINDS = Object.freeze(['submitted', 'revision_requested', 'accepted', 'taken_over']);
const EVENT_FIELDS = Object.freeze(['schema', 'event_id', 'session_id', 'kind', 'request_id', 'reason', 'summary', 'evidence', 'supersedes']);
const EVENT_FILE_FIELDS = Object.freeze([...EVENT_FIELDS, 'at']);
const EVIDENCE_FIELDS = Object.freeze(['source', 'kind', 'summary']);
const MAX_SUMMARY = 1000;
const MAX_TITLE = 160;
const MAX_EVENT_FILE = 256 * 1024;
const MAX_RECORD_FILE = 32 * 1024 * 1024;

const isPlainObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isoOrNull = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
// Strict ISO date/day validation: never accept a permissive Date.parse('1'),
// a bare year, or any string that is not an explicit ISO 8601 date/instant.
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function strictIso(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!STRICT_ISO.test(trimmed)) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  // Reject calendar overflow such as 2026-02-31 that Date.parse silently rolls.
  const dayPart = trimmed.slice(0, 10);
  if (new Date(`${dayPart}T00:00:00Z`).toISOString().slice(0, 10) !== dayPart) return null;
  return new Date(ms).toISOString();
}
function boundedString(value, max, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Fault('BAD_EVENT', `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new Fault('BAD_EVENT', `${field} must be a string.`);
  if (required && !value.trim()) throw new Fault('BAD_EVENT', `${field} cannot be empty.`);
  if ([...value].length > max) throw new Fault('BAD_EVENT', `${field} exceeds ${max} characters.`);
  return value;
}
function assertNoUnknown(obj, allowed, where) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new Fault('UNKNOWN_FIELD', `Unknown field in ${where}: only the documented schema is stored.`);
}
function opaqueOrNull(value, field, re = OPAQUE_RE) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !re.test(value)) throw new Fault('BAD_EVENT', `${field} must be a short opaque identifier.`);
  return value;
}
// A reader must tolerate a bad identifier in one record without throwing away
// valid neighbor records. `safeOpaque` returns null instead of raising.
const safeOpaque = (value, re = OPAQUE_RE) => typeof value === 'string' && re.test(value) ? value : null;

const eventDir = (stateDir, id) => path.join(stateDir, 'events', id);
const eventFile = (stateDir, id, eventId) => path.join(eventDir(stateDir, id), `${eventId}.json`);
const bindingFile = (stateDir, id) => path.join(stateDir, 'bindings', id, 'binding.json');
const receiptsDir = (stateDir, id) => path.join(stateDir, 'bindings', id, 'receipts');
const requestOrderDir = (stateDir, id) => path.join(stateDir, 'requests', id);
const requestOrderFile = (stateDir, id, requestId) => path.join(requestOrderDir(stateDir, id), `${requestId}.order.txt`);
export { eventDir, eventFile, requestOrderFile };

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------
export function validateEventInput(raw) {
  if (!isPlainObject(raw)) throw new Fault('BAD_EVENT', 'Event JSON must be an object.');
  assertNoUnknown(raw, EVENT_FIELDS, 'event');
  if (raw.schema !== EVENT_SCHEMA) throw new Fault('BAD_EVENT', `schema must be "${EVENT_SCHEMA}".`);
  if (typeof raw.event_id !== 'string' || !UUID_RE.test(raw.event_id)) throw new Fault('BAD_EVENT', 'event_id must be an opaque UUID; it is the idempotency key.');
  if (typeof raw.session_id !== 'string' || !UUID_RE.test(raw.session_id)) throw new Fault('BAD_EVENT', 'session_id must be the integration session UUID.');
  if (!EVENT_KINDS.includes(raw.kind)) throw new Fault('BAD_EVENT', `kind must be one of ${EVENT_KINDS.join(', ')}.`);
  const request_id = opaqueOrNull(raw.request_id, 'request_id');
  const reason = raw.reason ?? null;
  if (raw.kind === 'revision_requested' || raw.kind === 'taken_over') {
    if (!REASON_VALUES.includes(reason)) throw new Fault('BAD_EVENT', `reason is required for ${raw.kind} and must be one of ${REASON_VALUES.join(', ')}.`);
  } else if (reason !== null) {
    throw new Fault('BAD_EVENT', `reason is only recorded for revision_requested or taken_over, not ${raw.kind}.`);
  }
  const summary = boundedString(raw.summary, MAX_SUMMARY, 'summary');
  let evidence = [];
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 64) throw new Fault('BAD_EVENT', 'evidence must be an array of at most 64 entries.');
    evidence = raw.evidence.map((entry, i) => {
      if (!isPlainObject(entry)) throw new Fault('BAD_EVENT', `evidence[${i}] must be an object.`);
      assertNoUnknown(entry, EVIDENCE_FIELDS, `evidence[${i}]`);
      if (!EVIDENCE_SOURCES.includes(entry.source)) throw new Fault('BAD_EVENT', `evidence[${i}].source must be coordinator or worker.`);
      if (!EVIDENCE_KINDS.includes(entry.kind)) throw new Fault('BAD_EVENT', `evidence[${i}].kind must be one of ${EVIDENCE_KINDS.join(', ')}.`);
      return { source: entry.source, kind: entry.kind, summary: boundedString(entry.summary, MAX_SUMMARY, `evidence[${i}].summary`, { required: true }) };
    });
  }
  const supersedes = raw.supersedes === undefined || raw.supersedes === null ? null : raw.supersedes;
  if (supersedes !== null && (typeof supersedes !== 'string' || !UUID_RE.test(supersedes))) throw new Fault('BAD_EVENT', 'supersedes must be an event_id UUID.');
  return { schema: EVENT_SCHEMA, event_id: raw.event_id, session_id: raw.session_id, kind: raw.kind, request_id, reason, summary, evidence, supersedes };
}

export function normalizeStoredEvent(raw) {
  if (!isPlainObject(raw)) return null;
  if (Object.keys(raw).some(k => !EVENT_FILE_FIELDS.includes(k))) return null;
  const input = { ...raw };
  delete input.at;
  let checked;
  try { checked = validateEventInput(input); } catch { return null; }
  if (typeof raw.at !== 'string' || !strictIso(raw.at)) return null;
  return { ...checked, at: strictIso(raw.at) };
}

// ---------------------------------------------------------------------------
// Event folding
//
// A base event has no `supersedes` reference; a
// `supersedes` record resolves into (replaces) the base it corrects. Exactly one
// effective record survives per base, so a correction never double-counts.
// Malformed, dangling, cyclic or future-dated references are excluded from the
// effective set and reported as warnings; history stays readable in detail.
// ---------------------------------------------------------------------------
export function foldEvents(records, now = Infinity) {
  const byId = new Map();
  for (const record of records) if (Date.parse(record.at) <= now && !byId.has(record.event_id)) byId.set(record.event_id, record);
  const warnings = [];
  // A ROOT is a record that is not itself a correction. A correction that points at
  // a live root replaces it. Cyclic references leave every member pointing at a
  // live node with no root, so they are detected explicitly.
  const roots = [...byId.values()].filter(r => r.supersedes === null);
  const effectiveBase = new Map(); // root id -> effective record
  const historyBase = new Map();   // root id -> ordered chain

  for (const base of roots) {
    // Build the linear correction chain starting at this base. Each step must
    // reference the previous record, be same-session, and not precede its
    // target. A correction MAY reclassify (change the kind); that is the point
    // of a correction. Anything invalid excludes the whole chain with a warning.
    const chain = [base];
    const seen = new Set([base.event_id]);
    let cursor = base;
    let broken = false;
    while (true) {
      const corrections = [...byId.values()].filter(r => r.supersedes === cursor.event_id && r.event_id !== cursor.event_id);
      if (!corrections.length) break;
      if (corrections.length > 1) { warnings.push('event_supersedes_branch'); broken = true; break; }
      // Deterministic order: by timestamp, then by event_id.
      corrections.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.event_id.localeCompare(b.event_id));
      const next = corrections[0];
      if (seen.has(next.event_id)) { warnings.push('event_supersedes_cycle'); broken = true; break; }
      if (Date.parse(next.at) < Date.parse(cursor.at) || next.session_id !== base.session_id) {
        warnings.push('event_supersedes_invalid'); broken = true; break;
      }
      chain.push(next); seen.add(next.event_id); cursor = next;
    }
    if (broken) continue; // exclude the ambiguous base entirely rather than guess
    effectiveBase.set(base.event_id, chain.at(-1));
    historyBase.set(base.event_id, chain);
  }
  // Members of a supersedes cycle have no root, so they never appear above.
  // Detect the cycle explicitly and exclude it from the effective set.
  const cyclic = new Set();
  for (const record of byId.values()) {
    if (record.supersedes === null || !byId.has(record.supersedes)) continue;
    const seen = new Set();
    let cursor = record;
    while (cursor && cursor.supersedes !== null && byId.has(cursor.supersedes)) {
      if (seen.has(cursor.event_id)) { for (const id of seen) cyclic.add(id); cyclic.add(cursor.event_id); break; }
      seen.add(cursor.event_id);
      cursor = byId.get(cursor.supersedes);
    }
  }
  if (cyclic.size && !warnings.includes('event_supersedes_cycle')) warnings.push('event_supersedes_cycle');
  for (const id of cyclic) { historyBase.delete(id); effectiveBase.delete(id); }
  // A record whose target is unknown (dangling) is excluded with a warning.
  for (const record of byId.values()) {
    if (record.supersedes !== null && !byId.has(record.supersedes)) warnings.push('event_supersedes_invalid');
  }
  return { effective: effectiveBase, history: historyBase, warnings };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function readJSONIfPresent(file, options) {
  try { return await readJSON(file, options); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}

/**
 * Append one validated event to the private per-session event directory.
 *
 * Idempotent by event_id: an identical retry is a no-op that preserves the
 * originally recorded `at`; the same id with different content is rejected.
 * `supersedes` must name an event that already exists in the SAME session, is
 * not in the future, is not itself already superseded, and produces no cycle;
 * these are checked before the write so a correction cannot corrupt history.
 * The lock is the existing managed primitive; a lock-cleanup failure is
 * surfaced, never silently swallowed.
 */
export async function recordEvent(stateDir, sessionIdValue, raw, { stamp } = {}) {
  const id = sessionId(sessionIdValue);
  const event = validateEventInput(raw);
  if (event.session_id !== id) throw new Fault('BAD_EVENT', 'The event session_id must match --session.');
  // A collaboration event annotates an existing responsibility, never invents one.
  try { await privateDir(path.dirname(bindingFile(stateDir, id)), { create: false }); }
  catch (e) { if (e.code === 'STATE_MISSING') throw new Fault('UNKNOWN_SESSION', 'No binding exists for this session.'); throw e; }
  const bindingRead = await readJSONIfPresent(bindingFile(stateDir, id), { privateFile: true, maxBytes: MAX_RECORD_FILE });
  if (bindingRead === undefined) throw new Fault('UNKNOWN_SESSION', 'No binding exists for this session; collaboration events annotate an existing responsibility.');
  if (!isPlainObject(bindingRead) || bindingRead.schema !== 'cwr.acp.binding/1' || bindingRead.id !== id)
    throw new Fault('BAD_BINDING', 'The stored binding for this session is invalid.');
  const dir = eventDir(stateDir, id);
  await privateDir(dir);
  const file = eventFile(stateDir, id, event.event_id);
  const release = await lock(path.join(dir, `${event.event_id}.lock`), { nonce: randomUUID(), pid: process.pid, kind: 'dispatch-event' });
  let result;
  try {
    const existing = await readJSONIfPresent(file, { privateFile: true, maxBytes: MAX_EVENT_FILE });
    if (existing !== undefined) {
      const normalized = normalizeStoredEvent(existing);
      const same = normalized && JSON.stringify({ ...normalized, at: undefined }) === JSON.stringify({ ...event, at: undefined });
      if (!normalized || !same) throw new Fault('EVENT_CONFLICT', 'This event_id is already recorded with different content.');
      result = { schema: EVENT_SCHEMA, recorded: false, idempotent: true, event: normalized };
    } else {
      const recorded = { ...event, at: strictIso(stamp) ?? new Date().toISOString() };
      if (event.request_id !== null) {
        await privateDir(receiptsDir(stateDir, id), { create: false });
        const receipt = await readJSONIfPresent(path.join(receiptsDir(stateDir, id), `${event.request_id}.json`), { privateFile: true, maxBytes: MAX_RECORD_FILE });
        if (receipt?.session_id !== id || receipt?.request_id !== event.request_id) throw new Fault('BAD_EVENT', 'request_id must reference a receipt in this session.');
      }
      // Different event ids can append concurrently. Corrections additionally
      // serialize on their target so two writers cannot create a fork.
      const releaseTarget = event.supersedes === null ? null : await lock(path.join(dir, `${event.supersedes}.correction.lock`), { nonce: randomUUID(), pid: process.pid, kind: 'dispatch-correction' });
      try {
        if (event.supersedes !== null) await assertValidSupersede(stateDir, id, recorded);
        await atomicJSON(file, recorded);
      } finally { if (releaseTarget) await releaseTarget(); }
      result = { schema: EVENT_SCHEMA, recorded: true, idempotent: false, event: recorded };
    }
  } finally {
    // A release failure means the lock may still be held. Surface it; a retained
    // lock is the operator's reconciliation signal, not something to erase.
    await release();
  }
  return result;
}

async function loadEventRecords(stateDir, id) {
  const records = [];
  let names;
  try { names = await fs.readdir(eventDir(stateDir, id), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return records; throw e; }
  for (const entry of names) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue;
    let raw;
    try { raw = JSON.parse(await regular(path.join(eventDir(stateDir, id), entry.name), { privateFile: true, maxBytes: MAX_EVENT_FILE })); }
    catch { continue; }
    const normalized = normalizeStoredEvent(raw);
    if (normalized && `${normalized.event_id}.json` === entry.name) records.push(normalized);
  }
  return records;
}

async function assertValidSupersede(stateDir, id, event) {
  const records = await loadEventRecords(stateDir, id);
  const byId = new Map(records.map(r => [r.event_id, r]));
  if (!byId.has(event.event_id) && await readJSONIfPresent(eventFile(stateDir, id, event.event_id), { privateFile: true, maxBytes: MAX_EVENT_FILE }) !== undefined)
    throw new Fault('EVENT_CONFLICT', 'This event_id is already recorded with different content.');
  const target = byId.get(event.supersedes);
  if (!target) throw new Fault('BAD_EVENT', 'supersedes must reference an existing event in this session.');
  if (target.session_id !== event.session_id) throw new Fault('BAD_EVENT', 'supersedes must reference an event in the same session.');
  // The stamp is assigned at write time; compare against the current instant as
  // a conservative "not in the future" guard plus the chain's own ordering.
  if (Date.parse(target.at) > Date.parse(event.at)) throw new Fault('BAD_EVENT', 'A correction cannot precede its target.');
  let cursor = target;
  const guard = new Set([event.event_id]);
  while (cursor) {
    if (guard.has(cursor.event_id)) throw new Fault('BAD_EVENT', 'supersedes would create a cycle.');
    guard.add(cursor.event_id);
    const nextCursor = byId.get(cursor.supersedes);
    if (cursor.supersedes !== null && !nextCursor) throw new Fault('BAD_EVENT', 'The correction chain has a missing target.');
    cursor = nextCursor;
    if (!cursor) break;
  }
  if (records.some(r => r.supersedes === event.supersedes)) throw new Fault('BAD_EVENT', 'This event is already superseded; correct the latest record instead.');
}

// ---------------------------------------------------------------------------
// Recording metadata used by the CLI while a turn is genuinely happening
// ---------------------------------------------------------------------------
export function classifyTurn(binding, { titleProvided = false, title, categoryProvided = false, category } = {}) {
  const meta = isPlainObject(binding?.dispatch) ? binding.dispatch : {};
  const isNew = !meta.type;
  return {
    type: isNew ? 'dispatched' : 'continued',
    title: titleProvided ? title : (meta.title ?? null),
    category: categoryProvided ? category : (meta.category ?? (isNew ? 'other' : undefined)),
    titleInferred: false,
    legacy: !isNew,
  };
}
export function planSessionMetadata(binding, plan, { legacy = false } = {}) {
  const resolvedTitle = typeof plan.title === 'string' && plan.title.trim()
    ? plan.title
    : legacy ? null : `Worker session ${String(binding?.id ?? '').slice(0, 8)}`;
  const meta = { schema: BINDING_SCHEMA, type: plan.type, category: plan.category ?? 'other', title: resolvedTitle };
  // Prospective tracking starts now. A legacy continuation adopts tracking at
  // the moment it is CONTINUED under a current version; turns observed before
  // this instant must never be retroactively treated as reviewed.
  if (legacy) meta.tracking_started_at = new Date().toISOString();
  return meta;
}
export function planContinuation(binding) {
  const meta = isPlainObject(binding?.dispatch) ? binding.dispatch : {};
  if (meta.type) return null;
  // A legacy binding has no `type`; continuing it starts prospective tracking
  // from this instant rather than claiming all past turns were reviewed.
  return { schema: BINDING_SCHEMA, type: 'continued', category: meta.category ?? 'other', title: meta.title ?? null, tracking_started_at: new Date().toISOString() };
}

export function captureParentMetadata(env, platform = process.platform) {
  const read = name => {
    if (env?.[name] !== undefined) return env[name];
    if (platform !== 'win32') return undefined;
    const matched = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase());
    return matched === undefined ? undefined : env[matched];
  };
  const safe = name => safeOpaque(read(name));
  const thread_id = safe('CODEX_THREAD_ID');
  const session_id = safe('CODEX_SESSION_ID');
  return thread_id || session_id ? { schema: PARENT_SCHEMA, thread_id, session_id } : null;
}

export async function writeRequestOrder(stateDir, session, requestId, text) {
  const id = sessionId(session);
  const safeRequest = safeOpaque(requestId);
  if (!safeRequest) throw new Fault('BAD_EVENT', 'A request id is required to retain the work order.');
  const file = requestOrderFile(stateDir, id, safeRequest);
  await privateDir(path.dirname(file));
  await atomicJSON(file, { schema: ORDER_SCHEMA, text: String(text) });
  return file;
}

// ---------------------------------------------------------------------------
// Period accounting
// ---------------------------------------------------------------------------
// Normalize a `--since` value to an ISO instant, or null for "all". Uses the
// caller-supplied `now` so a relative window and the read's clock agree.
export function normalizeSince(since, now = Date.now()) {
  if (since === undefined || since === null || since === 'all') return null;
  if (typeof since !== 'string' || since === '') throw new Fault('BAD_PERIOD', 'since must be all, Nd/Nm/Nh/Nw or an ISO date.');
  const relative = /^(\d+)([dwmh])$/.exec(since);
  if (relative) {
    const n = Number(relative[1]);
    const unit = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 }[relative[2]];
    if (!Number.isSafeInteger(n) || n <= 0) throw new Fault('BAD_PERIOD', 'Relative period must be a positive whole number of units.');
    const span = n * unit;
    if (!Number.isFinite(new Date(now - span).getTime())) throw new Fault('BAD_PERIOD', 'Relative period is out of range.');
    return new Date(now - span).toISOString();
  }
  const iso = strictIso(since);
  if (!iso) throw new Fault('BAD_PERIOD', 'since must be all, Nd/Nm/Nh/Nw or a strict ISO 8601 date.');
  return iso;
}

const usageFromAdapter = usage => {
  const c = isPlainObject(usage) ? usage.cumulative : null;
  if (!isPlainObject(c)) return null;
  const pick = key => (Number.isSafeInteger(c[key]) && c[key] >= 0) ? c[key] : null;
  const observed = { input: pick('inputTokens'), output: pick('outputTokens'), thought: pick('thoughtTokens'), total: pick('totalTokens') };
  return Object.values(observed).every(v => v === null) ? null : observed;
};

// Cumulative snapshots are deduplicated per session. A bounded period requires
// a baseline before the boundary, or a session created inside it. A turn that
// crosses the boundary cannot be split. Unknown totals never become zero.
export function createSessionAccounting({ sinceIso, now = Infinity }) {
  return {
    summary: { external_tokens: 0, usage_sessions: 0, usage_total_sessions: 0, covered: false },
    observeSession({ observations, createdInPeriod = false, warnings = [] }) {
      const visible = observations.filter(o => Number.isFinite(Date.parse(o.at)) && Date.parse(o.at) <= now);
      const inside = visible.filter(o => o.inPeriod);
      if (!inside.length) return { total: null, covered: false, periodDelta: 0, warnings };
      this.summary.usage_total_sessions += 1;
      const baseline = sinceIso ? visible.filter(o => !o.inPeriod).at(-1)?.usage : null;
      const zero = !sinceIso || createdInPeriod;
      const last = inside.at(-1)?.usage;
      const totalKnown = v => Number.isSafeInteger(v) && v >= 0;
      let invalid = !totalKnown(last?.total);
      if ((!zero && !totalKnown(baseline?.total)) || inside.some(o => o.straddlesBoundary)) {
        warnings.push('usage_baseline_unknown'); invalid = true;
      }
      let prev = baseline?.total ?? (zero ? 0 : null);
      for (const o of inside) {
        if (!totalKnown(o.usage?.total)) continue; // a later snapshot may bridge
        if (prev !== null && o.usage.total < prev) invalid = true;
        prev = o.usage.total;
      }
      if (invalid) {
        warnings.push('usage_unknown');
        return { total: null, covered: false, periodDelta: 0, warnings };
      }
      const delta = last.total - (zero ? 0 : baseline.total);
      const components = {};
      for (const key of ['input', 'output', 'thought']) {
        const start = zero ? 0 : baseline?.[key];
        components[key] = totalKnown(last[key]) && totalKnown(start) && last[key] >= start ? last[key] - start : null;
      }
      this.summary.usage_sessions += 1;
      this.summary.external_tokens += delta;
      this.summary.covered = true;
      return { total: last.total, covered: true, periodDelta: delta, components, warnings };
    },
  };
}

// ---------------------------------------------------------------------------
// Projection reader
// ---------------------------------------------------------------------------
const JSON_FILE_RE = /\.json$/;
const DIAGNOSTIC_RE = /\.diagnostic\.json$/;

// Read a managed private JSON file without surfacing its path or content.
// A missing file is `absent`; an unsafe/oversized/unreadable file records a
// warning code so partial coverage stays visible across repeated reads.
async function readManagedJSON(file, warnings, code) {
  let text;
  try {
    await privateDir(path.dirname(file), { create: false });
    text = await regular(file, { privateFile: true, maxBytes: MAX_RECORD_FILE }); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') return { status: 'absent' };
    warnings.push(code);
    return { status: 'error' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_FILE) { warnings.push('oversized_record'); return { status: 'error' }; }
  try { return { status: 'ok', value: JSON.parse(text) }; }
  catch { warnings.push('malformed_json'); return { status: 'error' }; }
}

// List a managed directory while REFUSING to follow a directory symlink and
// without creating or repairing anything. An unsafe entry (symlink, non-regular,
// or wrong extension) is counted as a warning, never silently dropped, and never
// crashes the whole read.
async function listEntries(dir, warnings, { jsonOnly = true } = {}) {
  // Refuse to list through a symlinked directory: readdir would follow it and
  // attribute foreign files to this responsibility. Never create or repair.
  try { await privateDir(dir, { create: false }); }
  catch (e) { if (e.code === 'STATE_MISSING') return []; warnings.push('unsafe_entry'); return []; }
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') return []; throw e; }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { warnings.push('unsafe_entry'); continue; }
    if (jsonOnly && !JSON_FILE_RE.test(entry.name)) continue;
    if (!entry.isFile()) { if (jsonOnly) warnings.push('unsafe_entry'); continue; }
    files.push(entry.name);
  }
  return files.sort();
}

export function createProjectionReader(stateDir) {
  const cache = new Map(); // absolute file path -> { mtimeMs, size, value, warnings }
  const indexPath = path.join(stateDir, 'bindings');

  // Parse a managed file once per (mtime,size) and replay the SAME warning codes
  // on every subsequent read, so a malformed/unsafe record stays visibly partial
  // rather than silently "healing" on a cache hit.
  const readCached = async file => {
    let st;
    try { await privateDir(path.dirname(file), { create: false }); st = await fs.lstat(file); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') { cache.delete(file); return { status: 'absent', warnings: [] }; } throw e; }
    const hit = cache.get(file);
    if (st.isFile() && st.nlink === 1 && hit && hit.ctimeMs === st.ctimeMs && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ...hit.value, warnings: hit.warnings };
    const warnings = [];
    const value = await readManagedJSON(file, warnings, 'unreadable_record');
    cache.set(file, { ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs, size: st.size, value, warnings });
    return { ...value, warnings };
  };

  const indexSessions = async () => {
    let entries;
    try { await privateDir(indexPath, { create: false }); entries = await fs.readdir(indexPath, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') return []; throw e; }
    const ids = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && UUID_RE.test(entry.name)) ids.push(entry.name);
    }
    return ids.sort();
  };

  const loadSession = async (id, warnings, nowMs) => {
    const take = result => { for (const code of result.warnings) warnings.push(code); return result; };
    const bindingRead = take(await readCached(bindingFile(stateDir, id)));
    const binding = bindingRead?.status === 'ok' && isPlainObject(bindingRead.value) ? bindingRead.value : null;
    const bindingValid = binding && binding.schema === 'cwr.acp.binding/1' && binding.id === id;
    if (!bindingValid) warnings.push('malformed_binding');
    const meta = bindingValid && isPlainObject(binding.dispatch) && binding.dispatch.schema === BINDING_SCHEMA ? binding.dispatch : null;
    const parent = bindingValid && isPlainObject(binding.parent) ? binding.parent : null;
    if (parent && ['thread_id','session_id'].some(k => parent[k] != null && !safeOpaque(parent[k]))) warnings.push('malformed_parent');

    const receipts = [];
    for (const name of await listEntries(receiptsDir(stateDir, id), warnings)) {
      if (DIAGNOSTIC_RE.test(name)) continue; // diagnostics are not receipts
      const file = path.join(receiptsDir(stateDir, id), name);
      const read = take(await readCached(file));
      if (!read || read.status !== 'ok' || !isPlainObject(read.value)) { warnings.push('malformed_receipt'); continue; }
      const receipt = read.value;
      if (receipt.schema !== 'cwr.acp.receipt/1') { warnings.push('malformed_receipt'); continue; }
      // Validate the receipt belongs to this session and that its filename
      // matches its request_id, so a foreign file is never attributed here.
      if (receipt.session_id !== id) { warnings.push('foreign_receipt'); continue; }
      const requestId = safeOpaque(receipt.request_id);
      if (!requestId || `${requestId}.json` !== name) { warnings.push('malformed_receipt'); continue; }
      if (receipt.dispatch_warning) warnings.push('work_order_unavailable');
      receipts.push({
        request_id: requestId,
        started_at: isoOrNull(receipt.started_at),
        finished_at: isoOrNull(receipt.finished_at),
        runtime_status: ['completed', 'failed', 'cancelled'].includes(receipt.runtime_status) ? receipt.runtime_status : null,
        cleanup: ['confirmed', 'unconfirmed'].includes(receipt.cleanup) ? receipt.cleanup : 'unknown',
        usage: usageFromAdapter(receipt.adapter_reported_session_usage),
      });
    }
    receipts.sort((a, b) => String(a.finished_at ?? a.started_at ?? '').localeCompare(String(b.finished_at ?? b.started_at ?? '')));

    const stored = [];
    for (const name of await listEntries(eventDir(stateDir, id), warnings)) {
      const file = path.join(eventDir(stateDir, id), name);
      const read = take(await readCached(file));
      if (!read || read.status !== 'ok') continue;
      const normalized = normalizeStoredEvent(read.value);
      if (!normalized || `${normalized.event_id}.json` !== name) { warnings.push('malformed_event'); continue; }
      if (normalized.session_id !== id) { warnings.push('foreign_event'); continue; }
      stored.push(normalized);
    }
    const folded = foldEvents(stored, nowMs);
    for (const code of folded.warnings) warnings.push(code);
    return { id, binding: bindingValid ? binding : null, meta, parent, receipts, effective: folded.effective, history: folded.history };
  };

  const read = async ({ since = 'all', now } = {}) => {
    const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
    const sinceIso = normalizeSince(since, nowMs);
    const observedAt = new Date(nowMs).toISOString();
    const limit = sinceIso ? Date.parse(sinceIso) : -Infinity;
    const counts = new Map();
    const addWarning = (code, count = 1) => counts.set(code, (counts.get(code) ?? 0) + count);
    const drain = list => { for (const code of list.splice(0)) addWarning(code); };
    const inPeriod = at => at !== null && at !== undefined && Date.parse(at) >= limit && Date.parse(at) <= nowMs;

    let ids;
    try { ids = await indexSessions(); }
    catch { addWarning('unreadable_state'); ids = []; }

    const accounting = createSessionAccounting({ sinceIso, now: nowMs });
    const sessions = [];
    const summary = { responsibilities: 0, worker_turns: 0, runtime_completed: 0, failed: 0, cancelled: 0, submissions: 0, revisions: 0, accepted: 0, taken_over: 0, review: emptyReviewCounts(), usage_sessions: 0, usage_total_sessions: 0, external_tokens: null };
    const routes = new Map();
    const activity = new Map();

    for (const id of ids) {
      const warnings = [];
      let loaded;
      try { loaded = await loadSession(id, warnings, nowMs); }
      catch { addWarning('unreadable_session'); continue; }
      drain(warnings);

      loaded.receipts = loaded.receipts.filter(r => Date.parse(r.finished_at ?? r.started_at) <= nowMs);
      const turnReceipts = loaded.receipts.filter(r => inPeriod(r.finished_at ?? r.started_at));
      const effectiveEvents = [...loaded.effective.values()];
      const periodEvents = effectiveEvents.filter(e => inPeriod(e.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const closed = loaded.binding?.closed === true;
      const closedInPeriod = closed && inPeriod(loaded.binding?.closedAt);
      const latestMeaningful = latestTimestamp([...loaded.receipts.map(r => r.finished_at ?? r.started_at), ...effectiveEvents.map(e => e.at), loaded.binding?.closedAt]);
      const relevant = inPeriod(loaded.binding?.createdAt) || turnReceipts.length > 0 || periodEvents.length > 0 || closedInPeriod;
      if (!relevant) continue;

      // Accounting observations include pre-boundary receipts so a stored
      // cumulative counter has a measurable baseline. A turn straddles the
      // boundary when its start precedes it while its finish lands inside.
      const observations = loaded.receipts.map(r => ({
        at: r.finished_at ?? r.started_at,
        usage: r.usage,
        inPeriod: inPeriod(r.finished_at ?? r.started_at),
        straddlesBoundary: r.started_at !== null && Date.parse(r.started_at) < limit && inPeriod(r.finished_at ?? r.started_at),
      })).filter(o => o.at !== null);
      const usageState = accounting.observeSession({ observations, createdInPeriod: inPeriod(loaded.binding?.createdAt), warnings: [] });
      for (const code of usageState.warnings ?? []) addWarning(code);

      const submissions = periodEvents.filter(e => e.kind === 'submitted').length;
      const revisions = periodEvents.filter(e => e.kind === 'revision_requested').length;
      const evidenceCount = periodEvents.reduce((n, e) => n + e.evidence.filter(v => v.source === 'coordinator').length, 0);
      // review_state is derived from ALL recorded evidence (not just the period),
      // so a decision recorded before this window still classifies the record.
      const review = reviewSummaryFor({ meta: loaded.meta, effective: effectiveEvents, turns: loaded.receipts, closed, nowMs });
      const acceptance = review.state === 'accepted' || review.state === 'taken_over' ? review.state : 'unverified';
      summary.review[review.state] += 1;
      // Keep the compatible acceptance counters and review view derived from
      // the same current explicit decision, including legacy bindings.
      if (acceptance === 'accepted') summary.accepted += 1;
      if (acceptance === 'taken_over') summary.taken_over += 1;

      summary.responsibilities += 1;
      summary.worker_turns += turnReceipts.length;
      // Runtime outcome is the LATEST in-period runtime status, once per session.
      const latestTurn = turnReceipts.at(-1);
      if (latestTurn?.runtime_status === 'completed') summary.runtime_completed += 1;
      else if (latestTurn?.runtime_status === 'failed') summary.failed += 1;
      else if (latestTurn?.runtime_status === 'cancelled') summary.cancelled += 1;
      summary.submissions += submissions;
      summary.revisions += revisions;

      const timeline = buildTimeline({ binding: loaded.binding, turns: loaded.receipts, history: loaded.history, closed, limit, nowMs });
      sessions.push({
        id,
        title: titleOf(loaded.meta),
        category: categoryOf(loaded.meta),
        route: typeof loaded.binding?.route === 'string' ? loaded.binding.route : null,
        created_at: isoOrNull(loaded.binding?.createdAt),
        updated_at: latestMeaningful ?? isoOrNull(loaded.binding?.createdAt),
        closed,
        runtime_status: latestTurn?.runtime_status ?? null,
        cleanup: latestTurn?.cleanup ?? 'unknown',
        parent: projectParent(loaded.parent),
        turns: turnReceipts.length,
        submissions,
        revisions,
        acceptance,
        review_state: review.state,
        review: { state: review.state, tracked: review.tracked, decision: review.decision, decision_at: review.decision_at },
        evidence_count: evidenceCount,
        usage: usageForProjection(usageState),
        timeline,
      });

      const routeName = typeof loaded.binding?.route === 'string' ? loaded.binding.route : null;
      if (routeName) {
        const stat = routes.get(routeName) ?? { name: routeName, responsibilities: 0, worker_turns: 0, external_tokens: 0, usage_sessions: 0, usage_total_sessions: 0, elapsed: [], covered: false };
        stat.responsibilities += 1;
        stat.worker_turns += turnReceipts.length;
        if (turnReceipts.length) stat.usage_total_sessions += 1;
        if (usageState.covered && usageState.total !== null) { stat.external_tokens += usageState.periodDelta; stat.usage_sessions += 1; stat.covered = true; }
        for (const turn of turnReceipts) {
          const ms = Date.parse(turn.finished_at) - Date.parse(turn.started_at);
          if (Number.isFinite(ms) && ms >= 0) stat.elapsed.push(ms);
        }
        routes.set(routeName, stat);
      }
      for (const turn of turnReceipts) {
        const date = (turn.finished_at ?? turn.started_at ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) activity.set(date, (activity.get(date) ?? 0) + 1);
      }
    }

    summary.usage_sessions = accounting.summary.usage_sessions;
    summary.usage_total_sessions = accounting.summary.usage_total_sessions;
    summary.external_tokens = accounting.summary.covered ? accounting.summary.external_tokens : null;

    return {
      schema: PROJECTION_SCHEMA,
      observed_at: observedAt,
      period: { since: sinceIso, until: observedAt },
      scope: 'acp',
      summary,
      routes: [...routes.values()].sort((a, b) => a.name.localeCompare(b.name)).map(stat => ({
        name: stat.name,
        responsibilities: stat.responsibilities,
        worker_turns: stat.worker_turns,
        external_tokens: stat.covered ? stat.external_tokens : null,
        usage_sessions: stat.usage_sessions,
        usage_total_sessions: stat.usage_total_sessions,
        median_elapsed_ms: median(stat.elapsed),
      })),
      activity: [...activity.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, turns]) => ({ date, turns })),
      // Most recently meaningful responsibility first; a legacy record still
      // appears with an honest fallback title rather than being hidden.
      sessions: sessions.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))),
      warnings: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    };
  };

  const detail = async sessionIdValue => {
    const id = sessionId(sessionIdValue);
    const codes = new Set();
    const warnings = [];
    await privateDir(path.join(stateDir, 'bindings', id), { create: false });
    const bindingRead = await readManagedJSON(bindingFile(stateDir, id), warnings, 'unreadable_binding');
    const binding = bindingRead.status === 'ok' ? bindingRead.value : null;
    if (!isPlainObject(binding) || binding.schema !== 'cwr.acp.binding/1' || binding.id !== id) throw new Fault('BAD_BINDING', 'Invalid integration binding.');
    const meta = isPlainObject(binding.dispatch) && binding.dispatch.schema === BINDING_SCHEMA ? binding.dispatch : null;

    const turns = [];
    for (const name of await listEntries(receiptsDir(stateDir, id), warnings)) {
      if (DIAGNOSTIC_RE.test(name)) continue;
      const read = await readManagedJSON(path.join(receiptsDir(stateDir, id), name), warnings, 'unreadable_receipt');
      if (read.status !== 'ok' || !isPlainObject(read.value) || read.value.schema !== 'cwr.acp.receipt/1') { warnings.push('malformed_receipt'); continue; }
      if (read.value.session_id !== id) { warnings.push('foreign_receipt'); continue; }
      const requestId = safeOpaque(read.value.request_id);
      if (!requestId || `${requestId}.json` !== name) { warnings.push('malformed_receipt'); continue; }
      if (read.value.dispatch_warning) warnings.push('work_order_unavailable');
      const order = await readManagedJSON(requestOrderFile(stateDir, id, requestId), warnings, 'unreadable_order');
      turns.push({
        request_id: requestId,
        started_at: isoOrNull(read.value.started_at),
        finished_at: isoOrNull(read.value.finished_at),
        runtime_status: ['completed', 'failed', 'cancelled'].includes(read.value.runtime_status) ? read.value.runtime_status : null,
        cleanup: ['confirmed', 'unconfirmed'].includes(read.value.cleanup) ? read.value.cleanup : 'unknown',
        work_order: order.status === 'ok' && isPlainObject(order.value) && typeof order.value.text === 'string' ? order.value.text : null,
        output_excerpt: typeof read.value.output_excerpt === 'string' ? read.value.output_excerpt : null,
      });
    }
    turns.sort((a, b) => String(a.finished_at ?? a.started_at ?? '').localeCompare(String(b.finished_at ?? b.started_at ?? '')));

    const stored = [];
    for (const name of await listEntries(eventDir(stateDir, id), warnings)) {
      const read = await readManagedJSON(path.join(eventDir(stateDir, id), name), warnings, 'unreadable_event');
      if (read.status !== 'ok') continue;
      const normalized = normalizeStoredEvent(read.value);
      if (!normalized || `${normalized.event_id}.json` !== name) { warnings.push('malformed_event'); continue; }
      if (normalized.session_id !== id) { warnings.push('foreign_event'); continue; }
      stored.push(normalized);
    }
    const folded = foldEvents(stored, Date.now());
    for (const code of folded.warnings) codes.add(code);

    const effective = [...folded.effective.values()];
    const latestTurn = [...turns].reverse().find(t => t.runtime_status !== null) ?? turns.at(-1) ?? null;
    const review = reviewSummaryFor({ meta, effective, turns, closed: binding.closed === true, nowMs: Date.now() });
    const session = {
      id,
      title: titleOf(meta),
      category: categoryOf(meta),
      route: typeof binding.route === 'string' ? binding.route : null,
      created_at: isoOrNull(binding.createdAt),
      updated_at: latestTimestamp([...turns.map(t => t.finished_at ?? t.started_at), ...effective.map(e => e.at), binding.closedAt]) ?? isoOrNull(binding.createdAt),
      closed: binding.closed === true,
      runtime_status: latestTurn?.runtime_status ?? null,
      cleanup: latestTurn?.cleanup ?? 'unknown',
      parent: projectParent(binding.parent),
      turns: turns.length,
      submissions: effective.filter(e => e.kind === 'submitted').length,
      revisions: effective.filter(e => e.kind === 'revision_requested').length,
      acceptance: review.state === 'accepted' || review.state === 'taken_over' ? review.state : 'unverified',
      review_state: review.state,
      review: { state: review.state, tracked: review.tracked, decision: review.decision, decision_at: review.decision_at },
      evidence_count: effective.reduce((n, e) => n + e.evidence.filter(v => v.source === 'coordinator').length, 0),
      usage: { input: null, output: null, thought: null, total: null },
      timeline: buildTimeline({ binding, turns: turns.map(t => ({ ...t, usage: null })), history: folded.history, closed: binding.closed === true, limit: -Infinity, nowMs: Date.now() }),
    };
    for (const code of warnings) codes.add(code);
    return {
      schema: PROJECTION_SCHEMA,
      session,
      turns,
      events: stored.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
      warnings: [...codes].sort().map(code => ({ code, count: 1 })),
    };
  };

  return { read, detail, indexPath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Derive the single mutually exclusive review_state from source evidence only.
 *
 * Tracking is prospective: a binding with a `type` is tracked from its metadata,
 * and an EXPLICIT review event (accepted/taken_over/submitted/revision_requested)
 * establishes tracking even on a legacy binding that predates the metadata. A
 * plain note alone never establishes tracking, so a legacy binding with only
 * notes stays `legacy_untracked` — quietly historical, never an obligation.
 *
 * The state follows one chronological walk over source events and terminal turns:
 * - `accepted`/`taken_over` set the current decision.
 * - `revision_requested` sets `changes_requested` (an explicit correction).
 * - `submitted` is an explicit review request: it invalidates a standing decision
 *   and puts the record in `awaiting_review`.
 * - A later successful (`completed`) turn clears an outstanding
 *   `changes_requested`/`awaiting_review` back to `not_requested` (the rework came
 *   back and nobody re-requested review); it also invalidates a standing
 *   acceptance. A later failed/cancelled/unconfirmed turn on OPEN work marks the
 *   record `needs_attention`.
 * - `completed` is never evidence of acceptance by itself. Future observations
 *   are ignored.
 *
 * `awaiting_review` therefore requires an explicit `submitted` event, not merely
 * a turn. End state for a tracked record with no obligation: `no_receipt` if no
 * receipt exists yet (never proof of a running process); `needs_attention` if the
 * latest runtime is compromised and the work is open; otherwise `not_requested`
 * (including intentionally closed work). Closing is ordinary lifecycle, never a
 * review obligation.
 */
function reviewStateOf({ meta, effective, turns = [], receipts = [], closed = false, nowMs = Infinity }) {
  const visible = at => typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) <= nowMs;
  // Explicit review evidence establishes tracking even without metadata.
  const metaTracked = isPlainObject(meta) && typeof meta.type === 'string' && meta.type !== '';
  const explicit = effective.some(e => REVIEW_TRACKING_KINDS.includes(e.kind) && visible(e.at));
  if (!metaTracked && !explicit) return { state: 'legacy_untracked', decision_at: null, tracked: false };
  const start = metaTracked ? trackedStart(meta) : null;
  const prospective = at => visible(at) && (start === null || Date.parse(at) >= start);

  // One chronological sequence of review-relevant observations. A decision
  // (accepted/taken_over/revision) is a decision; a submission is a re-delivery;
  // a terminal turn returns the work for a fresh look.
  const observations = [];
  for (const e of effective) {
    if (!prospective(e.at)) continue;
    if (REVIEW_TRACKING_KINDS.includes(e.kind)) observations.push({ at: e.at, kind: e.kind });
  }
  for (const t of turns) {
    const at = t.finished_at ?? t.started_at ?? null;
    if (!prospective(at)) continue;
    observations.push({ at, kind: 'turn', status: t.runtime_status ?? null, cleanup: t.cleanup ?? null });
  }
  observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind));

  let decision = null;         // 'accepted' | 'taken_over' | 'changes_requested' | null
  let decisionAt = null;
  let reviewRequested = false; // an explicit `submitted` is outstanding
  let compromised = false;     // latest terminal runtime is failed/cancelled/unconfirmed
  for (const o of observations) {
    if (o.kind === 'accepted' || o.kind === 'taken_over') { decision = o.kind; decisionAt = o.at; reviewRequested = false; compromised = false; }
    else if (o.kind === 'revision_requested') { decision = 'changes_requested'; decisionAt = o.at; reviewRequested = false; compromised = false; }
    else if (o.kind === 'submitted') { decision = null; decisionAt = null; reviewRequested = true; compromised = false; }
    else if (o.kind === 'turn') {
      if (o.status === 'failed' || o.status === 'cancelled' || o.cleanup === 'unconfirmed') {
        compromised = true;
        // A later failed result also invalidates the older accepted result.
        if (decision === 'accepted' || decision === 'taken_over') { decision = null; decisionAt = null; }
      }
      else if (o.status === 'completed') {
        // A successful turn invalidates a standing acceptance and clears an
        // outstanding correction/review request: the work came back and nobody
        // has re-requested review or re-decided.
        if (decision !== null) { decision = null; decisionAt = null; }
        reviewRequested = false;
        compromised = false;
      }
    }
  }

  let state;
  // A compromised runtime only matters while the work is still open; an
  // intentionally closed responsibility is not an outstanding obligation.
  if (compromised && !closed) state = 'needs_attention';
  else if (decision !== null) state = decision;
  else if (reviewRequested) state = 'awaiting_review';
  else if (!closed && !hasReceipt(turns, receipts, prospective)) state = 'no_receipt';
  else state = 'not_requested';
  return { state, decision_at: decision !== null ? decisionAt : null, tracked: true };
}
function hasReceipt(turns, receipts, prospective) {
  if (turns.some(t => prospective(t.finished_at ?? t.started_at))) return true;
  return receipts.some(r => prospective(r.finished_at ?? r.started_at));
}
// The instant prospective tracking began, or null for a binding that predates
// the metadata field (type present but no timestamp). A null start means "all
// recorded turns count", never a fabricated retroactive review.
function trackedStart(meta) {
  return typeof meta?.tracking_started_at === 'string' && !Number.isNaN(Date.parse(meta.tracking_started_at))
    ? Date.parse(meta.tracking_started_at) : null;
}
function emptyReviewCounts() {
  const counts = {};
  for (const state of REVIEW_STATES) counts[state] = 0;
  return counts;
}
// A bounded, source-only review view for the list projection. No text: only the
// derived state, tracking flag, and the timestamp of the current decision.
function reviewSummaryFor({ meta, effective, turns, receipts, closed, nowMs }) {
  const derived = reviewStateOf({ meta, effective, turns, receipts, closed, nowMs });
  const tracked = derived.state !== 'legacy_untracked';
  return {
    state: derived.state,
    tracked,
    decision: derived.state === 'accepted' || derived.state === 'taken_over' || derived.state === 'changes_requested' ? derived.state : null,
    decision_at: derived.decision_at,
  };
}
export { reviewStateOf as deriveReviewState };
function usageForProjection(usageState) {
  if (!usageState.covered || usageState.total === null) return { input: null, output: null, thought: null, total: null };
  return {
    input: usageState.components?.input ?? null,
    output: usageState.components?.output ?? null,
    thought: usageState.components?.thought ?? null,
    // The period delta, not the lifetime cumulative: this is what the selected
    // window can attribute to the responsibility.
    total: usageState.periodDelta,
  };
}
function latestTimestamp(values) {
  const valid = values.filter(v => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
  return valid.length ? valid.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
}
function categoryOf(meta) { return meta && CATEGORIES.includes(meta.category) ? meta.category : 'other'; }
function titleOf(meta) {
  if (!meta || typeof meta.title !== 'string' || !meta.title.trim()) return null;
  return [...meta.title].slice(0, MAX_TITLE).join('');
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function buildTimeline({ binding, turns, history, closed, limit, nowMs }) {
  const entries = [];
  const beforeEnd = at => at && Date.parse(at) <= nowMs;
  const push = entry => { if (entry.at && Date.parse(entry.at) >= limit && beforeEnd(entry.at)) entries.push(entry); };
  const blank = (kind, at, extra = {}) => push({ kind, at, request_id: null, reason: null, summary: null, evidence: [], event_id: null, ...extra });
  if (binding?.createdAt) blank('dispatch', binding.createdAt);
  let previousStarted = null;
  for (const turn of turns) {
    // `continued` marks a follow-up turn on an already-dispatched responsibility.
    if (previousStarted !== null) blank('continued', turn.started_at, { request_id: turn.request_id ?? null });
    blank('runtime_started', turn.started_at, { request_id: turn.request_id ?? null });
    previousStarted = turn.started_at;
    if (turn.finished_at) {
      const kind = turn.runtime_status === 'completed' ? 'runtime_completed' : turn.runtime_status === 'cancelled' ? 'runtime_cancelled' : turn.runtime_status === 'failed' ? 'runtime_failed' : 'runtime_unknown';
      blank(kind, turn.finished_at, { request_id: turn.request_id ?? null });
    }
  }
  // `history` is keyed by each logical event's ROOT id, so iterating it emits
  // exactly one timeline entry per logical event (its latest correction).
  for (const [id, chain] of history) {
    const event = chain.at(-1);
    push({
      kind: event.kind, at: event.at, request_id: event.request_id, reason: event.reason, summary: event.summary,
      evidence: event.evidence.map(e => ({ source: e.source, kind: e.kind, summary: e.summary })),
      event_id: id, superseded_count: chain.length - 1,
    });
  }
  if (closed && binding?.closedAt) blank('closed', binding.closedAt);
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return entries;
}

function projectParent(parent) {
  return isPlainObject(parent) ? { thread_id: safeOpaque(parent.thread_id), session_id: safeOpaque(parent.session_id), observed_at: isoOrNull(parent.observed_at) } : null;
}

// ---------------------------------------------------------------------------
// Actionable review backlog (`pending`)
// ---------------------------------------------------------------------------
/**
 * Read-only, aggregate-safe list of ACTIONABLE review records only, returned
 * ON DEMAND — it is never a mandatory backlog for ordinary completion. Only
 * responsibilities with an explicit review request (`awaiting_review`), an
 * unreturned correction (`changes_requested`), or a compromised open runtime
 * (`needs_attention`) appear; ordinary completion or closure without a review
 * annotation is not an obligation and never appears. Only safe opaque ids, the
 * derived state, closed flag, latest runtime status and the bound title are
 * returned — never work-order text, output or paths. No adapter is loaded.
 */
export async function listPendingSessions(stateDir, { now = Date.now() } = {}) {
  const projection = await createProjectionReader(stateDir).read({ now });
  const records = projection.sessions
    .filter(s => ACTIONABLE_REVIEW_STATES.includes(s.review_state))
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .map(s => ({
      session_id: s.id,
      review_state: s.review_state,
      closed: s.closed === true,
      status: s.runtime_status,
      title: s.title,
      updated_at: s.updated_at,
    }));
  return {
    schema: 'cwr.dispatch.pending/1',
    observed_at: projection.observed_at,
    count: records.length,
    records,
    warnings: projection.warnings,
  };
}
