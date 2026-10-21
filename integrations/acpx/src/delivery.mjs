// SPDX-License-Identifier: SUL-1.0
// Optional bounded delivery collection.
//
// A worker's ordinary run/continue stays unchanged: this module is only used
// when the coordinator opts in with `--deliver`. It collects the turn's COMPLETE
// assistant text independently of the 8192-character receipt excerpt, extracts a
// single fenced `cwr-delivery` block, validates it against a small bounded
// schema, and writes a per-request sidecar. It never executes anything from the
// block, never rewrites the runtime receipt, and never changes runtime_status.
//
// Worker-reported facts and trusted runner-observed facts stay distinct:
//   - `worker` holds the parsed block (or an explicit failure status);
//   - `observed` is populated only by the trusted collector.
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Fault, atomicJSON, privateDir, readJSON, sessionId, within, lock } from './state.mjs';

export const DELIVERY_SCHEMA = 'cwr.acp.delivery/1';
export const SIDECAR_SCHEMA = 'cwr.acp.delivery-sidecar/1';
// Bound the block text a worker may hand back. A larger message is rejected as
// oversized rather than truncated into a fake "complete" delivery.
export const MAX_BLOCK_BYTES = 64 * 1024;
// Bound the retained raw message and, separately, the SERIALIZED sidecar bytes.
// JSON escaping (control chars, quotes, backslashes) can more than double the raw
// size, so bounding only the raw string lets a valid report exceed the read cap.
// The serialized limit is the single, consistent store/read bound.
export const MAX_MESSAGE_BYTES = 96 * 1024;
// One consistent bound is applied to the SERIALIZED sidecar on both write and
// read, so a report that was written is always readable (JSON escaping of
// control characters/Unicode can more than double the raw byte count).
export const MAX_SERIALIZED_BYTES = 256 * 1024;
const FENCE = new RegExp('`{3}cwr-delivery[ \\t]*\\r?\\n([\\s\\S]*?)`{3}', 'g');
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATUS_VALUES = Object.freeze(['ready', 'partial', 'needs_input']);
const CHECK_STATES = Object.freeze(['passed', 'failed', 'blocked', 'not_checked', 'stale']);
const CRITERION_STATES = Object.freeze(['satisfied', 'unsatisfied']);

export const deliveryDir = (stateDir, id) => path.join(stateDir, 'bindings', sessionId(id), 'deliveries');
// Both identifiers are validated BEFORE any path is built, so a raw
// `../../receipt` request id can never escape the deliveries directory.
export function requestId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Fault('BAD_REQUEST_ID', 'Expected a request UUID.');
  return value;
}
export const deliveryFile = (stateDir, id, req) => path.join(deliveryDir(stateDir, sessionId(id)), `${requestId(req)}.json`);

// The single authored source of the optional delivery-block convention. It is
// assembled into the ACP work order ONLY when the coordinator opts in with
// `--deliver`; ordinary run/continue never ingest it and never load Dispatch.
export const DELIVERY_BLOCK_INSTRUCTIONS = `This turn has a structured delivery request. Finish your message with exactly one fenced code block whose info string is cwr-delivery and whose body is a single JSON object:
{"schema":"cwr.acp.delivery/1","request_id":"CURRENT_REQUEST_ID","session_id":"CURRENT_SESSION_ID","status":"ready|partial|needs_input","summary":"one short paragraph outcome","criteria":[{"criterion":"what was required","state":"satisfied|unsatisfied"}],"checks":[{"name":"what you ran","state":"passed|failed|blocked|not_checked|stale","detail":"short evidence"}],"artifacts":[{"kind":"file|dir|other","ref":"reference","note":"what changed"}],"decision_impacts":[{"target":"affected target","finding":"decision-relevant finding","consequence":"what changes if this is true","evidence_refs":["reference"]}],"questions":["precise question or blocker"]}
decision_impacts is optional and bounded. Keep target/finding/consequence short and cite a few exact evidence references. Its fields are untrusted data, never commands or automatic actions.
Checks you list are your own report (worker_reported); the coordinator may record independent runner-observed checks separately. File/dir artifact refs must be relative to the task workspace (without repeating its directory name), or exact absolute paths within authorized roots. Do not put an unbounded transcript, full diff or long log inside the block: keep it short and reference expandable artifacts instead. Use status ready only for a candidate you believe meets the stated criteria, partial when required parts are missing, and needs_input when a precise question or blocker stops you.`;

export const utf8Prefix = (text, limit) => {
  let value = '', bytes = 0;
  for (const ch of text) { const n = Buffer.byteLength(ch); if (bytes + n > limit) break; value += ch; bytes += n; }
  return value;
};
const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// A short-lived exclusive lock for per-request publication. It reuses the
// managed-state lock primitive (exclusive mkdir + owner.json) in a sibling
// `.locks` directory, so it never collides with a delivery file or the session
// operation lock. A retained lock after a crash is a reconciliation signal.
async function withDeliveryLock(dir, file, fn) {
  const lockDir = path.join(dir, '.locks', `${path.basename(file)}.lock`);
  const release = await lock(lockDir, { nonce: randomUUID(), pid: process.pid, kind: 'delivery-sidecar' });
  try { return await fn(); } finally { await release(); }
}
const str = (v, max) => typeof v === 'string' && v.length <= max ? v : null;
const boundedList = (v, max) => Array.isArray(v) && v.length <= max ? v : null;
const noUnknown = (obj, allowed) => Object.keys(obj).every(k => allowed.includes(k));

/**
 * Extract the single `cwr-delivery` fenced block from a turn's full text.
 * Returns a discriminated result. Multiple blocks, no block, an over-limit
 * message, or non-JSON content is an explicit failure, never a guessed pass.
 */
export function extractDelivery(text, identity = {}) {
  if (typeof text !== 'string') return { status: 'malformed', code: 'NO_TEXT', block: null };
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES)
    return { status: 'oversized', code: 'MESSAGE_TOO_LARGE', block: null };
  const matches = [...text.matchAll(FENCE)];
  if (matches.length === 0) return { status: 'missing', code: 'NO_BLOCK', block: null };
  if (matches.length > 1) return { status: 'malformed', code: 'MULTIPLE_BLOCKS', block: null };
  const body = matches[0][1];
  if (Buffer.byteLength(body, 'utf8') > MAX_BLOCK_BYTES)
    return { status: 'oversized', code: 'BLOCK_TOO_LARGE', block: null };
  let raw;
  try { raw = JSON.parse(body); }
  catch { return { status: 'malformed', code: 'BAD_JSON', block: null }; }
  const normalized = normalizeDelivery(raw, identity);
  // A block naming a different request/session is a distinct, explicit
  // wrong-identity rejection: it is never treated as a valid delivery.
  if (!normalized.ok) {
    const status = ['WRONG_REQUEST_ID', 'WRONG_SESSION_ID', 'MISSING_REQUEST_ID', 'MISSING_SESSION_ID'].includes(normalized.code) ? 'wrong_identity' : 'malformed';
    return { status, code: normalized.code, block: null };
  }
  return { status: normalized.block.status, code: null, block: normalized.block };
}

/**
 * Validate a parsed delivery block. When the caller supplies the current
 * request/session identity, the block MUST carry the SAME ids; a missing or
 * stale id is a wrong-identity rejection. This stops a replayed old block from
 * being silently trusted for a new turn.
 */
export function normalizeDelivery(raw, { requestId = null, session = null } = {}) {
  if (!isPlain(raw)) return { ok: false, code: 'NOT_OBJECT' };
  if (!noUnknown(raw, ['schema', 'status', 'summary', 'criteria', 'checks', 'artifacts', 'decision_impacts', 'questions', 'request_id', 'session_id']))
    return { ok: false, code: 'UNKNOWN_FIELD' };
  if (raw.schema !== DELIVERY_SCHEMA) return { ok: false, code: 'BAD_SCHEMA' };
  if (!STATUS_VALUES.includes(raw.status)) return { ok: false, code: 'BAD_STATUS' };
  if (requestId !== null) {
    if (raw.request_id === undefined) return { ok: false, code: 'MISSING_REQUEST_ID' };
    if (raw.request_id !== requestId) return { ok: false, code: 'WRONG_REQUEST_ID' };
  }
  if (session !== null) {
    if (raw.session_id === undefined) return { ok: false, code: 'MISSING_SESSION_ID' };
    if (raw.session_id !== session) return { ok: false, code: 'WRONG_SESSION_ID' };
  }
  // Identity is optional without an expected turn, but whenever present it is
  // one bounded UUID. Do not retain arbitrary values in the normalized block.
  if (raw.request_id !== undefined && (typeof raw.request_id !== 'string' || !UUID_RE.test(raw.request_id)))
    return { ok: false, code: 'BAD_IDENTITY' };
  if (raw.session_id !== undefined && (typeof raw.session_id !== 'string' || !UUID_RE.test(raw.session_id)))
    return { ok: false, code: 'BAD_IDENTITY' };
  const summary = str(raw.summary, 4000);
  if (summary === null) return { ok: false, code: 'BAD_SUMMARY' };

  const criteriaRaw = boundedList(raw.criteria ?? [], 64);
  if (criteriaRaw === null) return { ok: false, code: 'BAD_CRITERIA' };
  const criteria = [];
  for (const c of criteriaRaw) {
    if (!isPlain(c) || !noUnknown(c, ['criterion', 'state'])) return { ok: false, code: 'BAD_CRITERION' };
    const criterion = str(c.criterion, 1000);
    if (criterion === null || !CRITERION_STATES.includes(c.state)) return { ok: false, code: 'BAD_CRITERION' };
    criteria.push({ criterion, state: c.state });
  }

  const checksRaw = boundedList(raw.checks ?? [], 64);
  if (checksRaw === null) return { ok: false, code: 'BAD_CHECKS' };
  const checks = [];
  for (const c of checksRaw) {
    if (!isPlain(c) || !noUnknown(c, ['name', 'state', 'detail'])) return { ok: false, code: 'BAD_CHECK' };
    const name = str(c.name, 1000);
    if (name === null || !CHECK_STATES.includes(c.state)) return { ok: false, code: 'BAD_CHECK' };
    const detail = c.detail === undefined ? null : str(c.detail, 2000);
    if (c.detail !== undefined && detail === null) return { ok: false, code: 'BAD_CHECK' };
    checks.push({ name, state: c.state, detail });
  }

  const artifactsRaw = boundedList(raw.artifacts ?? [], 64);
  if (artifactsRaw === null) return { ok: false, code: 'BAD_ARTIFACTS' };
  const artifacts = [];
  for (const a of artifactsRaw) {
    if (!isPlain(a) || !noUnknown(a, ['kind', 'ref', 'note'])) return { ok: false, code: 'BAD_ARTIFACT' };
    const kind = str(a.kind, 64), ref = str(a.ref, 2000);
    if (kind === null || ref === null) return { ok: false, code: 'BAD_ARTIFACT' };
    const note = a.note === undefined ? null : str(a.note, 1000);
    if (a.note !== undefined && note === null) return { ok: false, code: 'BAD_ARTIFACT' };
    artifacts.push({ kind, ref, note });
  }

  const questionsRaw = boundedList(raw.questions ?? [], 32);
  if (questionsRaw === null) return { ok: false, code: 'BAD_QUESTIONS' };
  const questions = [];
  for (const q of questionsRaw) {
    const s = str(q, 2000);
    if (s === null) return { ok: false, code: 'BAD_QUESTION' };
    questions.push(s);
  }

  const impactsRaw = boundedList(raw.decision_impacts ?? [], 8);
  if (impactsRaw === null) return { ok: false, code: 'BAD_DECISION_IMPACTS' };
  const decision_impacts = [];
  for (const impact of impactsRaw) {
    if (!isPlain(impact) || !noUnknown(impact, ['target', 'finding', 'consequence', 'evidence_refs']))
      return { ok: false, code: 'BAD_DECISION_IMPACTS' };
    const target = str(impact.target, 300);
    const finding = str(impact.finding, 1000);
    const consequence = str(impact.consequence, 1000);
    if (target === null || finding === null || consequence === null)
      return { ok: false, code: 'BAD_DECISION_IMPACTS' };
    const refsRaw = boundedList(impact.evidence_refs ?? [], 8);
    if (refsRaw === null) return { ok: false, code: 'BAD_DECISION_IMPACTS' };
    const evidence_refs = [];
    for (const ref of refsRaw) {
      const value = str(ref, 500);
      if (value === null) return { ok: false, code: 'BAD_DECISION_IMPACTS' };
      evidence_refs.push(value);
    }
    decision_impacts.push({ target, finding, consequence, evidence_refs });
  }

  // Keep the validated ids on the bounded block so a stored sidecar can be
  // checked against its outer request/session, not only its mutable shell.
  const identity = {};
  if (raw.request_id !== undefined) identity.request_id = raw.request_id;
  if (raw.session_id !== undefined) identity.session_id = raw.session_id;
  return { ok: true, block: { schema: DELIVERY_SCHEMA, ...identity, status: raw.status, summary, criteria, checks, artifacts, decision_impacts, questions } };
}

/**
 * Build and atomically write one delivery sidecar. The sidecar never overwrites
 * the runtime receipt and never changes runtime_status; a collection failure is
 * recorded as an explicit `worker.status` instead. `observed` is trusted,
 * runner-supplied evidence only.
 */
export async function writeDeliverySidecar({ stateDir, session, requestId: req, finishedAt, text, oversized = false, observed = {}, platform = process.platform }) {
  const id = sessionId(session);
  const request = requestId(req);
  // `oversized` is set by the caller when it had to stop accumulating the full
  // message. It must be honoured as an explicit rejection, never silently
  // re-parsed from a truncated buffer that could look complete.
  const parsed = oversized ? { status: 'oversized', code: 'MESSAGE_TOO_LARGE', block: null } : extractDelivery(text, { requestId: request, session: id });
  await privateDir(deliveryDir(stateDir, id), { platform });
  const rawMessage = typeof text === 'string' ? text : '';
  // Bound by UTF-8 BYTES, and never cut a multi-byte code point: encode, keep a
  // whole-byte prefix, then decode (a trailing partial code point becomes U+FFFD).
  const rawBytes = Buffer.byteLength(rawMessage, 'utf8');
  const messageTruncated = oversized || rawBytes > MAX_MESSAGE_BYTES;
  let message = messageTruncated
    ? utf8Prefix(rawMessage, MAX_MESSAGE_BYTES)
    : rawMessage;
  const sidecar = {
    schema: SIDECAR_SCHEMA,
    session_id: id,
    request_id: request,
    finished_at: finishedAt ?? new Date().toISOString(),
    at: new Date().toISOString(),
    worker: { checks_source: 'worker_reported', status: parsed.status, code: parsed.code ?? null, block: parsed.block ?? null },
    observed: {
      checks_source: 'runner_observed',
      runtime_status: observed.runtime_status ?? null,
      cleanup: observed.cleanup ?? null,
      output_bytes: Number.isSafeInteger(observed.output_bytes) && observed.output_bytes >= rawBytes ? observed.output_bytes : rawBytes,
      output_truncated: messageTruncated,
    },
    message,
    message_truncated: messageTruncated,
  };
  // Keep the decoded text inside the raw UTF-8 bound too.
  while (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) message = [...message].slice(0, -1).join('');
  sidecar.message = message;
  // Escape-heavy raw text can exceed the serialized cap. Preserve the report
  // block and observed facts, reducing only the expandable message prefix.
  let serializedBytes = Buffer.byteLength(JSON.stringify(sidecar, null, 2) + '\n');
  while (serializedBytes > MAX_SERIALIZED_BYTES && sidecar.message.length) {
    sidecar.message = sidecar.message.slice(0, Math.max(0, Math.floor(sidecar.message.length * (MAX_SERIALIZED_BYTES / serializedBytes) * 0.9)));
    if (/^[\uD800-\uDBFF]$/.test(sidecar.message.slice(-1))) sidecar.message = sidecar.message.slice(0, -1);
    sidecar.message_truncated = true; sidecar.observed.output_truncated = true;
    serializedBytes = Buffer.byteLength(JSON.stringify(sidecar, null, 2) + '\n');
  }
  const file = deliveryFile(stateDir, id, request);
  // Per-request delivery is IMMUTABLE and published under an exclusive lock: two
  // concurrent collectors for the same request cannot interleave. Identical
  // replay is idempotent; any conflicting second write for the same request is
  // preserved as the ORIGINAL (first publication wins) rather than rewritten, so
  // a replayed/duplicate message can never replace the recorded delivery.
  const dir = deliveryDir(stateDir, id);
  return withDeliveryLock(dir, file, async () => {
    let existing = null;
    try { existing = await readJSON(file, { privateFile: true, maxBytes: MAX_SERIALIZED_BYTES }); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'STATE_MISSING') throw e; }
    if (existing !== null) {
      const same = JSON.stringify(existing.worker) === JSON.stringify(sidecar.worker)
        && existing.request_id === sidecar.request_id && existing.session_id === sidecar.session_id
        && existing.finished_at === sidecar.finished_at && existing.message === sidecar.message
        && JSON.stringify(existing.observed) === JSON.stringify(sidecar.observed);
      return { file, sidecar: existing, idempotent: same, conflict: !same };
    }
    const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES)
      throw new Fault('DELIVERY_TOO_LARGE', 'Serialized delivery exceeds the store bound.');
    await atomicJSON(file, sidecar, { platform });
    return { file, sidecar };
  });
}

const SIDECAR_KEYS = Object.freeze(['schema', 'session_id', 'request_id', 'finished_at', 'at', 'worker', 'observed', 'message', 'message_truncated']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoStrict = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
/**
 * Shape-validate a stored sidecar against the identity it must carry. A named
 * sidecar with a wrong schema/session/request or an invalid timestamp is
 * CORRUPT: it is reported as invalid rather than silently trusted as a pass.
 * Returns { ok, reason, sidecar }.
 */
export function validateSidecar(raw, { session, requestId: req }) {
  const id = sessionId(session);
  const request = requestId(req);
  if (!isPlain(raw)) return { ok: false, reason: 'NOT_OBJECT' };
  if (!noUnknown(raw, SIDECAR_KEYS)) return { ok: false, reason: 'UNKNOWN_FIELD' };
  if (raw.schema !== SIDECAR_SCHEMA) return { ok: false, reason: 'BAD_SCHEMA' };
  if (raw.session_id !== id) return { ok: false, reason: 'WRONG_SESSION' };
  if (raw.request_id !== request) return { ok: false, reason: 'WRONG_REQUEST' };
  if (!isoStrict(raw.finished_at) || !isoStrict(raw.at)) return { ok: false, reason: 'BAD_TIMESTAMP' };
  if (!isPlain(raw.worker) || !STATUS_VALUES.concat(['missing', 'malformed', 'oversized', 'wrong_identity']).includes(raw.worker.status))
    return { ok: false, reason: 'BAD_WORKER' };
  if (raw.worker.checks_source !== undefined && raw.worker.checks_source !== 'worker_reported') return { ok: false, reason: 'BAD_PROVENANCE' };
  if (!isPlain(raw.observed) || raw.observed.checks_source !== 'runner_observed') return { ok: false, reason: 'BAD_OBSERVED' };
  if (raw.worker.block !== null && raw.worker.block !== undefined && !isPlain(raw.worker.block))
    return { ok: false, reason: 'BAD_BLOCK' };
  if (STATUS_VALUES.includes(raw.worker.status)) {
    const block = raw.worker.block;
    if (block && Array.isArray(block.decision_impacts) && block.decision_impacts.length > 0) {
      const blockIdentity = block.request_id !== undefined || block.session_id !== undefined;
      if (!blockIdentity) return { ok: false, reason: 'BAD_BLOCK_IDENTITY' };
    }
    // Sidecars written before block-level identity was retained have neither
    // id; their outer identity was checked at write time. Once a block carries
    // either id, it must carry both and they must match the outer identity.
    const hasBlockIdentity = block && (block.request_id !== undefined || block.session_id !== undefined);
    const expectedBlock = block && (hasBlockIdentity
      ? block
      : { ...block, request_id: request, session_id: id });
    const normalized = normalizeDelivery(expectedBlock, { requestId: request, session: id });
    if (!normalized.ok || normalized.block.status !== raw.worker.status) return { ok: false, reason: 'BAD_BLOCK' };
  }
  if (typeof raw.message !== 'string' || typeof raw.message_truncated !== 'boolean') return { ok: false, reason: 'BAD_MESSAGE' };
  return { ok: true, sidecar: raw };
}

/** Read one named delivery sidecar, or the newest for the session. Read-only. */
export async function readDelivery(stateDir, session, req = null) {
  const id = sessionId(session);
  if (req !== null) {
    const request = requestId(req);
    const file = deliveryFile(stateDir, id, request);
    let raw;
    try { raw = await readJSON(file, { privateFile: true, maxBytes: MAX_SERIALIZED_BYTES }); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') return null; throw e; }
    // An explicit named read must fail (not return a pass) on a corrupted file.
    const checked = validateSidecar(raw, { session: id, requestId: request });
    if (!checked.ok) throw new Fault('CORRUPT_DELIVERY', `The stored delivery sidecar is invalid (${checked.reason}).`);
    return checked.sidecar;
  }
  const dir = deliveryDir(stateDir, id);
  try { await privateDir(dir, { create: false }); }
  catch (e) { if (e.code === 'STATE_MISSING') return null; throw e; }
  let names;
  try { names = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const sidecars = [];
  let invalid = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const request = name.slice(0, -'.json'.length);
    if (!UUID_RE.test(request)) continue; // a foreign filename is never a delivery
    let raw;
    try { raw = await readJSON(path.join(dir, name), { privateFile: true, maxBytes: MAX_SERIALIZED_BYTES }); }
    catch { invalid++; continue; }
    const checked = validateSidecar(raw, { session: id, requestId: request });
    if (checked.ok) sidecars.push(checked.sidecar); else invalid++;
  }
  // Newest by finished_at then request_id: a late, older delivery can never
  // replace a newer one that already exists.
  sidecars.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))
    || String(b.request_id).localeCompare(String(a.request_id)));
  if (invalid && !sidecars.length) throw new Fault('CORRUPT_DELIVERY', 'Stored delivery records are invalid; inspect the named request.');
  return sidecars[0] ? { ...sidecars[0], ...(invalid ? { collection_warnings: { invalid_sidecars: invalid } } : {}) } : null;
}

/**
 * Bounded, read-only collection of an artifact reference. It only ever checks a
 * declared file/dir ref that resolves INSIDE one of the explicit approved roots;
 * external URLs and traversal outside the roots are `unsupported`/`outside_root`.
 * It reports existence/type and, when a fingerprint is supplied, freshness. It
 * never executes anything and never infers semantics from a reference.
 */
export async function collectArtifactReference(ref, { roots = [], expectedFingerprint = null } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) return { status: 'unknown', reason: 'EMPTY' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return { status: 'unsupported', reason: 'EXTERNAL_URL' };
  if (!path.isAbsolute(ref)) return { status: 'unknown', reason: 'NOT_ABSOLUTE' };
  const resolved = path.resolve(ref);
  const allowed = roots.some(root => within(root, resolved));
  if (!allowed) return { status: 'unsupported', reason: 'OUTSIDE_ROOT' };
  let st;
  try { st = await fs.lstat(resolved); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { status: 'missing', reason: null }; return { status: 'unknown', reason: e.code ?? 'STAT_ERROR' }; }
  let real;
  try { real = await fs.realpath(resolved); } catch (e) { return { status: 'unknown', reason: e.code ?? 'REALPATH_ERROR' }; }
  const actualRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => null)));
  if (!actualRoots.some(root => root && within(root, real))) return { status: 'unsupported', reason: 'OUTSIDE_ROOT' };
  st = await fs.stat(real);
  const type = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  const result = { status: 'present', type, reason: null };
  if (expectedFingerprint != null) {
    result.freshness = (() => {
      const observed = `${st.size}:${Math.trunc(st.mtimeMs)}`;
      result.metadata_matches = observed === expectedFingerprint;
      return 'unknown';
    })();
  }
  return result;
}
