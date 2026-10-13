// SPDX-License-Identifier: SUL-1.0
// Task-scoped acceptance evidence.
//
// A trusted runner runs ONE explicit check (argv + cwd + budget + log limit)
// against the exact candidate state and records a `runner_observed` result.
// The argv, cwd and environment come from coordinator-confirmed task input; this
// module never accepts a worker-supplied shell string and never runs anything
// extracted from a delivery block.
//
// There is NO fallback to the coordinator environment: a check must be given an
// explicit OWNED execution scope (HOME/USERPROFILE + XDG/TMP/CODEX), or it is
// `blocked`. Relying on PATH-only is NOT isolation, because a child that calls
// os.homedir()/Path.home() still resolves the coordinator passwd HOME. A worker
// or caller field can never elevate evidence: only this module sets
// `checks_source: 'runner_observed'`.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const VERIFY_SCHEMA = 'cwr.acp.acceptance/1';
// `status` is the PROCESS outcome; criterion applicability is separate.
const STATUSES = Object.freeze(['passed', 'failed', 'blocked', 'not_checked']);
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024;
// How long to wait for the process tree to actually exit after a kill before
// declaring cleanup unconfirmed. No fake success and no orphaned descendant.
const SETTLE_MS = 4000;

const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// A valid owned execution scope relocates HOME/USERPROFILE and the XDG/TMP/CODEX
// scopes into an owned worker home. Any credential-shaped variable is rejected.
function validateScope(env) {
  if (!isPlain(env)) return 'NO_SCOPE';
  const need = ['HOME'];
  for (const key of need) if (typeof env[key] !== 'string' || !env[key]) return `MISSING_${key}`;
  if (!path.isAbsolute(env.HOME) || path.parse(env.HOME).root === path.resolve(env.HOME)) return 'BAD_HOME';
  if (env.USERPROFILE !== undefined && env.USERPROFILE !== env.HOME) return 'MISMATCHED_USERPROFILE';
  // The scope must not carry obvious ambient credentials.
  for (const key of Object.keys(env)) {
    if (typeof env[key] !== 'string') return 'BAD_VALUE';
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|_KEY$/i.test(key)) return 'CREDENTIAL_IN_SCOPE';
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA']) {
    if (env[key] === undefined) continue;
    const rel = path.relative(env.HOME, env[key]);
    if (!path.isAbsolute(env[key]) || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return 'OUTSIDE_SCOPE';
  }
  return null;
}

/**
 * Run one bounded acceptance check.
 *
 * @param {object} input
 * @param {string[]} input.argv   exact argument vector (argv[0] is the program)
 * @param {string}   input.cwd    exact working directory
 * @param {number}  [input.timeoutMs]
 * @param {number}  [input.maxLogBytes]
 * @param {object}   input.env    explicit OWNED execution scope (required)
 * @param {string}  [input.name]  label for the check
 * @param {string}  [input.candidateFingerprint] identity of the tested content
 * @param {boolean} [input.criterionApplicable] criterion applicability:
 *   only a task-confirmed applicable criterion maps the process exit to passed
 *   or failed. Otherwise both zero and nonzero remain not_checked. The caller
 *   must establish coverage and interpret skips; this helper cannot grade prose.
 */
export async function runAcceptanceCheck({ argv, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxLogBytes = DEFAULT_MAX_LOG_BYTES, env, name = null, candidateFingerprint = null, criterionApplicable = false, spawnImpl = spawn } = {}) {
  const record = {
    schema: VERIFY_SCHEMA,
    name,
    checks_source: 'runner_observed',
    argv: Array.isArray(argv) ? [...argv] : null,
    cwd,
    status: 'not_checked',
    process_outcome: null,
    criterion_applicable: null,
    exit_code: null,
    signal: null,
    timed_out: false,
    cleanup: 'unconfirmed',
    candidate_fingerprint: candidateFingerprint,
    output_bytes: 0,
    output_truncated: false,
    log: '',
    at: new Date().toISOString(),
  };
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string'))
    return { ...record, status: 'blocked', blocked_code: 'BAD_ARGV' };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd))
    return { ...record, status: 'blocked', blocked_code: 'NO_CWD' };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    return { ...record, status: 'blocked', blocked_code: 'BAD_TIMEOUT' };
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1)
    return { ...record, status: 'blocked', blocked_code: 'BAD_LOG_LIMIT' };
  const scopeProblem = validateScope(env);
  if (scopeProblem)
    return { ...record, status: 'blocked', blocked_code: `SCOPE_${scopeProblem}` };

  const outcome = await new Promise(resolve => {
    let child;
    try {
      // A POSIX detached process group is owned and killed as a unit, so a
      // grandchild cannot keep the pipes open after a timeout. On Windows there
      // is no equivalent group; the direct child is killed and settlement is
      // bounded with a truthful cleanup flag.
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd, env: { ...env, USERPROFILE: env.HOME }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ spawnError: e.code ?? 'SPAWN_ERROR' });
      return;
    }
    let bytes = 0, retained = 0, timedOut = false, settled = false;
    const chunks = [];
    const output = () => {
      // Decode once across stream chunk boundaries. Invalid bytes and a partial
      // final codepoint may expand on decoding; cap the returned UTF-8 text too.
      const text = Buffer.concat(chunks).toString('utf8');
      let log = '', size = 0;
      for (const ch of text) { const n = Buffer.byteLength(ch); if (size + n > maxLogBytes) break; log += ch; size += n; }
      return { log, bytes, truncated: bytes > retained || Buffer.byteLength(text) > maxLogBytes };
    };
    const append = chunk => {
      const remaining = maxLogBytes - retained;
      bytes += chunk.length;
      if (remaining <= 0) return;
      const prefix = chunk.subarray(0, remaining); chunks.push(prefix); retained += prefix.length;
    };
    const killTree = signal => {
      try {
        if (spawnImpl === spawn && process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* already gone */ }
    };
    let settleTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGKILL');
      settleTimer = setTimeout(() => {
        if (!settled) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); resolve({ code: null, signal: 'SIGKILL', ...output(), timedOut, settled: false }); }
      }, SETTLE_MS);
    }, timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', e => { clearTimeout(timer); clearTimeout(settleTimer); resolve({ spawnError: e.code ?? 'SPAWN_ERROR', ...output() }); });
    child.on('close', (code, signal) => {
      settled = true; clearTimeout(timer); clearTimeout(settleTimer);
      resolve({ code, signal, ...output(), timedOut, settled: !(timedOut && process.platform === 'win32') });
    });
  });

  if (outcome.spawnError)
    return { ...record, status: 'blocked', blocked_code: outcome.spawnError, log: outcome.log ?? '', output_bytes: outcome.bytes ?? 0, output_truncated: outcome.truncated ?? false };
  record.exit_code = outcome.code ?? null;
  record.signal = outcome.signal ?? null;
  record.timed_out = Boolean(outcome.timedOut);
  record.cleanup = outcome.settled === false ? 'unconfirmed' : 'confirmed';
  record.log = outcome.log ?? '';
  record.output_bytes = outcome.bytes ?? 0;
  record.output_truncated = Boolean(outcome.truncated);
  // An unconfirmed cleanup blocks: an unknown-lived descendant is not evidence.
  if (record.cleanup !== 'confirmed') { record.status = 'blocked'; record.blocked_code = 'CLEANUP_UNCONFIRMED'; return record; }
  if (record.timed_out) { record.status = 'blocked'; record.blocked_code = 'TIMEOUT'; return record; }
  if (outcome.signal) { record.status = 'blocked'; record.blocked_code = 'SIGNALLED'; return record; }
  // A process outcome is not automatically a deterministic behavior failure.
  record.process_outcome = outcome.code === 0 ? 'exit_zero' : 'exit_nonzero';
  record.criterion_applicable = criterionApplicable === true;
  record.status = record.criterion_applicable ? (outcome.code === 0 ? 'passed' : 'failed') : 'not_checked';
  return record;
}

/**
 * Classify stored evidence as stale relative to a current candidate fingerprint.
 * A change to relevant source/test/dependency content invalidates the check.
 */
export function freshness(record, currentFingerprint) {
  if (!record || record.checks_source !== 'runner_observed') return 'unknown';
  if (typeof record.candidate_fingerprint !== 'string' || !record.candidate_fingerprint || typeof currentFingerprint !== 'string' || !currentFingerprint) return 'unknown';
  return record.candidate_fingerprint === currentFingerprint ? 'fresh' : 'stale';
}

export { STATUSES };
