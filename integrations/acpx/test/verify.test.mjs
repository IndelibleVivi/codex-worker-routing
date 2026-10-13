// Task-scoped acceptance evidence uses real bounded subprocesses in an isolated
// synthetic HOME. No provider, account or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runAcceptanceCheck, freshness, VERIFY_SCHEMA } from '../src/verify.mjs';

async function scope(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-verify-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // An explicit OWNED execution scope: HOME plus the managed XDG/TMP scopes.
  return { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, '.config') };
}
async function cwdDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwr-verify-cwd-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an explicit owned execution scope runs the check; a missing scope is blocked', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const ok = await runAcceptanceCheck({ criterionApplicable: true, name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'], cwd, env });
  assert.equal(ok.status, 'passed');
  assert.equal(ok.checks_source, 'runner_observed');
  assert.equal(ok.process_outcome, 'exit_zero');
  // No scope at all: blocked, never a silent ambient-HOME fallback.
  const noScope = await runAcceptanceCheck({ criterionApplicable: true, name: 'x', argv: [process.execPath, '-e', 'process.exit(0)'], cwd });
  assert.equal(noScope.status, 'blocked');
  assert.equal(noScope.blocked_code, 'SCOPE_NO_SCOPE');
  // PATH-only is NOT isolation: still blocked.
  const pathOnly = await runAcceptanceCheck({ criterionApplicable: true, name: 'x', argv: [process.execPath, '-e', 'process.exit(0)'], cwd, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(pathOnly.status, 'blocked');
});

test('a scope carrying a credential-shaped variable is blocked', async t => {
  const env = { ...(await scope(t)), OPENAI_API_KEY: 'secret' };
  const r = await runAcceptanceCheck({ criterionApplicable: true, name: 'x', argv: [process.execPath, '-e', 'process.exit(0)'], cwd: await cwdDir(t), env });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blocked_code, 'SCOPE_CREDENTIAL_IN_SCOPE');
});

test('the explicit scope is what the child actually sees (no ambient HOME)', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const r = await runAcceptanceCheck({ criterionApplicable: true, name: 'env', argv: [process.execPath, '-e', 'process.exit(process.env.HOME===' + JSON.stringify(env.HOME) + '?0:9)'], cwd, env });
  assert.equal(r.status, 'passed');
});

test('a nonzero exit is a process outcome; criterion applicability is explicit', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const fail = await runAcceptanceCheck({ criterionApplicable: true, name: 'f', argv: [process.execPath, '-e', 'process.exit(7)'], cwd, env });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.process_outcome, 'exit_nonzero');
  assert.equal(fail.criterion_applicable, true);
  // When the coordinator declares a nonzero exit is NOT the failure criterion,
  // the same process outcome is not_checked, never silently a pass.
  const notApplicable = await runAcceptanceCheck({ criterionApplicable: true, name: 'f', argv: [process.execPath, '-e', 'process.exit(7)'], cwd, env, criterionApplicable: false });
  assert.equal(notApplicable.status, 'not_checked');
  assert.equal(notApplicable.criterion_applicable, false);
});

test('a missing executable is blocked, never a behavior failure', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const r = await runAcceptanceCheck({ criterionApplicable: true, name: 'missing', argv: [path.join(cwd, 'no-such-binary')], cwd, env });
  assert.equal(r.status, 'blocked');
});

test('a hung grandchild cannot hold the pipes open: the whole process group is killed and settles', { skip: process.platform === 'win32' && 'requires owned POSIX process groups' }, async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  // The child spawns a detached grandchild that would keep stdout open forever;
  // a direct child-only SIGKILL would leave the read open. The owned group kill
  // must settle within the bound and report a truthful (blocked) outcome.
  const code = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const start = Date.now();
  const r = await runAcceptanceCheck({ criterionApplicable: true, name: 'hang', argv: [process.execPath, '-e', code], cwd, env, timeoutMs: 300 });
  assert.equal(r.status, 'blocked');
  assert.equal(r.timed_out, true);
  assert.equal(r.cleanup, process.platform === 'win32' ? 'unconfirmed' : 'confirmed');
  assert.ok(Date.now() - start < 6000, 'must settle within the bounded wait');
});

test('the byte log limit holds under multi-byte UTF-8 output', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const code = `process.stdout.write('\\u{1F600}'.repeat(10000))`;
  const r = await runAcceptanceCheck({ criterionApplicable: true, name: 'unicode', argv: [process.execPath, '-e', code], cwd, env, maxLogBytes: 5000 });
  assert.equal(r.status, 'passed');
  assert.ok(Buffer.byteLength(r.log, 'utf8') <= 5000, 'byte cap is enforced, not char count');
  assert.equal(r.output_truncated, true);
});

test('freshness distinguishes fresh vs stale vs unknown runner-observed evidence', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const rec = await runAcceptanceCheck({ criterionApplicable: true, name: 'f', argv: [process.execPath, '-e', 'process.exit(0)'], cwd, env, candidateFingerprint: 'HEAD1' });
  assert.equal(rec.schema, VERIFY_SCHEMA);
  assert.equal(freshness(rec, 'HEAD1'), 'fresh');
  assert.equal(freshness(rec, 'HEAD2'), 'stale');
  assert.equal(freshness({ status: 'passed' }, 'HEAD2'), 'unknown');
  assert.equal(freshness({ status: 'passed', checks_source: 'worker_reported', candidate_fingerprint: 'HEAD2' }, 'HEAD2'), 'unknown');
});


test('zero exit without an applicable criterion is not acceptance, including an empty check', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const r = await runAcceptanceCheck({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd, env });
  assert.equal(r.process_outcome, 'exit_zero');
  assert.equal(r.criterion_applicable, false);
  assert.equal(r.status, 'not_checked');
  assert.equal(freshness(r, undefined), 'unknown');
});

test('explicit environment cannot relocate a config scope outside the chosen HOME', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  const r = await runAcceptanceCheck({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd,
    env: { ...env, CODEX_HOME: cwd } });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blocked_code, 'SCOPE_OUTSIDE_SCOPE');
});

test('log bounds survive partial Unicode, invalid bytes and split stream chunks', async t => {
  const env = await scope(t), cwd = await cwdDir(t);
  for (const code of ["process.stdout.write('猫')", "process.stdout.write(Buffer.from([255,255]))"]) {
    const r = await runAcceptanceCheck({ criterionApplicable: true, argv: [process.execPath, '-e', code], cwd, env, maxLogBytes: 2 });
    assert.ok(Buffer.byteLength(r.log) <= 2);
    assert.equal(r.output_truncated, true);
  }
  const code = "const b=Buffer.from('🐈');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),10)";
  const r = await runAcceptanceCheck({ criterionApplicable: true, argv: [process.execPath, '-e', code], cwd, env, maxLogBytes: 4 });
  assert.equal(r.log, '🐈');
  assert.equal(r.output_truncated, false);
});
