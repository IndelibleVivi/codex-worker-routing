// SPDX-License-Identifier: SUL-1.0
// EXPERIMENT ONLY: a bounded outer-feedback harness, living in the tests rather
// than the product path. It demonstrates whether replaying ONE concrete failed
// check to the SAME stopped session catches premature delivery, under a fixed
// correction budget and a non-resetting responsibility deadline.
//
// It is NOT wired into ordinary run/continue, does not run shell strings from
// worker reports, grants no callback an unbounded or refreshed budget, and does
// not auto-reprompt on success, permission denial, cancellation, uncertain
// cleanup, stale evidence, a generic failure, or a missing-report-only turn.
// Promotion is explicitly out of scope: this only shows the bounded gate can
// distinguish a wrong candidate from a corrected one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptanceCheck, freshness, VERIFY_SCHEMA } from '../src/verify.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const MAX_CORRECTIONS = 2;
function candidateFile(root) { return path.join(root, 'candidate.txt'); }
const CHEAP = { timeoutMs: 20000, maxLogBytes: 4096 };

/**
 * Bounded outer feedback. `runCheck()` returns a runner-observed record.
 * `reprompt(feedback)` returns after the same-session correction (or nothing).
 * Guard rules, enforced BEFORE and AFTER each callback:
 *   - the check must be a concrete, trusted-applicable FAILED result with a
 *     fresh candidate identity; success/not_checked/blocked/stale never retry;
 *   - the session must be stopped with confirmed cleanup and remaining authority;
 *   - maxCorrections is hard-capped at 2 and the deadline never resets;
 *   - after reprompt the same guard is re-evaluated on the NEW record, so a
 *     callback cannot buy extra iterations.
 */
export async function runBoundedFeedback({ session, runCheck, reprompt, deadlineMs = 20000, maxCorrections = MAX_CORRECTIONS, now = Date.now, currentFingerprint = () => null }) {
  if (!Number.isSafeInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > MAX_CORRECTIONS)
    throw new Error('maxCorrections must be an integer 0..2');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be positive and finite');
  const responsibilityDeadline = now() + deadlineMs;
  const history = [];
  let corrections = 0;
  const trusted = record => record.checks_source === 'runner_observed'
    && freshness(record, currentFingerprint()) === 'fresh' && record.criterion_applicable === true;
  const sessionAdmitted = () => session.stopped === true && session.cleanup === 'confirmed' && session.authorityRemaining === true;
  const guard = record => record.status === 'failed'
    && trusted(record)
    && record.cleanup === 'confirmed'
    && sessionAdmitted();
  let record = await runCheck({ remainingMs: Math.max(1, responsibilityDeadline - now()) });
  history.push({ attempt: 0, status: record.status, exit_code: record.exit_code });
  for (;;) {
    if (now() >= responsibilityDeadline) return { outcome: 'deadline_exhausted', corrections, history };
    if (record.status === 'passed' && trusted(record)) return { outcome: 'accepted', corrections, history };
    if (!guard(record)) {
      // Distinguish "not a retryable failure" from a genuine failure we may not
      // retry (missing authority/cleanup, non-applicable criterion, stale).
      return { outcome: record.status === 'failed' ? 'blocked_no_retry' : 'not_retried', corrections, history };
    }
    if (corrections >= maxCorrections) return { outcome: 'budget_exhausted', corrections, history };
    if (now() >= responsibilityDeadline) return { outcome: 'deadline_exhausted', corrections, history };
    corrections++;
    await reprompt({ name: record.name, status: record.status, exit_code: record.exit_code, log: record.log });
    // Re-read the clock and re-check the deadline AFTER the callback so a slow
    // callback cannot extend the responsibility budget, and re-run the guard on
    // the fresh record.
    if (now() >= responsibilityDeadline) return { outcome: 'deadline_exhausted', corrections, history };
    if (!sessionAdmitted()) return { outcome: 'blocked_no_retry', corrections, history };
    record = await runCheck({ remainingMs: Math.max(1, responsibilityDeadline - now()) });
    history.push({ attempt: corrections, status: record.status, exit_code: record.exit_code });
  }
}

async function scope(root) {
  const home = path.join(root, 'home'); await fs.mkdir(home, { mode: 0o700, recursive: true });
  return { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' };
}
async function makeCheck(root, requiredToken, fingerprint) {
  const file = candidateFile(root);
  return runAcceptanceCheck({
    criterionApplicable: true,
    name: 'synthetic gate',
    argv: [process.execPath, '-e', `const fs=require('node:fs');const t=fs.readFileSync(${JSON.stringify(file)},'utf8');process.exit(t.includes(${JSON.stringify(requiredToken)})?0:3)`],
    cwd: root, env: await scope(root), ...CHEAP, candidateFingerprint: fingerprint,
  });
}

test('the bounded gate rejects a wrong candidate and accepts a corrected one', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-ofb-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bodies = ['WRONG_OUTPUT', 'STILL_WRONG', 'REQUIRED_OK'];
  let i = 0;
  const stop = { stopped: true, cleanup: 'confirmed', authorityRemaining: true };
  const runCheck = async () => { await fs.writeFile(candidateFile(root), bodies[Math.min(i, bodies.length - 1)]); return makeCheck(root, 'REQUIRED_OK', bodies[Math.min(i, bodies.length - 1)]); };
  const reprompt = async () => { i++; };
  const result = await runBoundedFeedback({ session: stop, runCheck, reprompt, deadlineMs: 20000, currentFingerprint: () => bodies[Math.min(i, bodies.length - 1)] });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.corrections, 2);
  // A gate that "always passed" would have accepted the wrong candidate at
  // attempt 0; this proves the wrong candidate actually fails the criterion.
  assert.deepEqual(result.history.map(h => h.status), ['failed', 'failed', 'passed']);
});

test('the gate never reprompts on success, missing-report-only, block, cancel, stale or uncertain state', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-ofb-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stopped = { stopped: true, cleanup: 'confirmed', authorityRemaining: true };
  let reprompts = 0;
  const reprompt = async () => { reprompts++; };
  const failed = { status: 'failed', criterion_applicable: true, cleanup: 'confirmed', checks_source: 'runner_observed', candidate_fingerprint: 'current' };
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: async () => ({ ...failed, status: 'passed' }), reprompt })).outcome, 'accepted');
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: async () => ({ status: 'not_checked' }), reprompt })).outcome, 'not_retried');
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: async () => ({ status: 'blocked', blocked_code: 'CANCEL_REQUESTED' }), reprompt })).outcome, 'not_retried');
  // A generic failure without an applicable criterion is not retryable.
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: async () => ({ status: 'failed', criterion_applicable: false, cleanup: 'confirmed' }), reprompt })).outcome, 'blocked_no_retry');
  // The check itself must report confirmed cleanup.
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: async () => ({ status: 'failed', criterion_applicable: true, cleanup: 'unconfirmed' }), reprompt })).outcome, 'blocked_no_retry');
  // Uncertain session cleanup / revoked authority.
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: { stopped: true, cleanup: 'unconfirmed', authorityRemaining: true }, runCheck: async () => failed, reprompt })).outcome, 'blocked_no_retry');
  assert.equal((await runBoundedFeedback({ currentFingerprint: () => 'current', session: { stopped: true, cleanup: 'confirmed', authorityRemaining: false }, runCheck: async () => failed, reprompt })).outcome, 'blocked_no_retry');
  assert.equal(reprompts, 0, 'none of the non-retry cases may reprompt');
});

test('the correction budget and the non-resetting deadline both stop the loop', async () => {
  const alwaysFail = async () => ({ status: 'failed', criterion_applicable: true, cleanup: 'confirmed', exit_code: 1, checks_source: 'runner_observed', candidate_fingerprint: 'current' });
  const stopped = { stopped: true, cleanup: 'confirmed', authorityRemaining: true };
  let reprompts = 0;
  const budget = await runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: alwaysFail, reprompt: async () => { reprompts++; }, deadlineMs: 60000 });
  assert.equal(budget.outcome, 'budget_exhausted');
  assert.equal(budget.corrections, MAX_CORRECTIONS);
  assert.equal(reprompts, MAX_CORRECTIONS);
  // A non-resetting deadline: a callback that advances the clock past the budget
  // cannot buy another correction.
  let clock = 0;
  const deadline = await runBoundedFeedback({
    currentFingerprint: () => 'current',
    session: stopped, deadlineMs: 100, now: () => clock,
    runCheck: alwaysFail,
    reprompt: async () => { clock += 500; }, // advances past the deadline AFTER the callback
  });
  assert.equal(deadline.outcome, 'deadline_exhausted');
  assert.ok(deadline.corrections <= 1);
  // The budget cap is enforced even if a caller asks for more.
  await assert.rejects(runBoundedFeedback({ currentFingerprint: () => 'current', session: stopped, runCheck: alwaysFail, reprompt: () => {}, maxCorrections: 5 }), /0\.\.2/);
});


test('outer feedback refuses a stale or worker-reported failed check without calling a correction', async () => {
  let calls = 0;
  const session = { stopped: true, cleanup: 'confirmed', authorityRemaining: true };
  for (const source of ['worker_reported', 'runner_observed']) {
    const r = await runBoundedFeedback({ session, currentFingerprint: () => 'current',
      runCheck: async () => ({ status: 'failed', checks_source: source, candidate_fingerprint: 'old', criterion_applicable: true, cleanup: 'confirmed' }),
      reprompt: async () => { calls++; } });
    assert.equal(r.outcome, 'blocked_no_retry');
  }
  assert.equal(calls, 0);
});
