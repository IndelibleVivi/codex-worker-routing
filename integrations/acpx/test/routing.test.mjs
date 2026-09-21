// Synthetic regression suite for the OPTIONAL config routing policy: a private
// same-config routing.default with authorized routing.fallbacks, resolved fresh
// on each run, plus the prelaunch-only availability fallback and its evidence.
// Everything drives the REAL CLI main; fixtures are synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { loadConfig, selectRoute, resolveRouteSelection } from '../src/config.mjs';
import { loadBinding, paths, readJSON, lock } from '../src/state.mjs';
import { fixture, fakeAcpx, routeFor } from './helpers.mjs';

// A tiny synthetic adapter entry with a platform-appropriate launchable
// extension. The contract double never spawns it, but the selected route's
// executable hash and platform execute checks still run for real. Windows has no
// execute bit and accepts only .exe/.com/.cmd/.bat, so an extensionless copy of
// the Node binary would be rejected there.
export function entryExt(platform = process.platform) { return platform === 'win32' ? '.cmd' : ''; }
async function entry(root, name, platform = process.platform) {
  const file = path.join(root, `${name}-entry${entryExt(platform)}`);
  await fs.writeFile(file, '#!/usr/bin/env node\n', { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return file;
}
// The exact same path `entry` would materialize, deliberately left absent.
const absent = (root, name, platform = process.platform) => path.join(root, `${name}-entry${entryExt(platform)}`);
// Remove a previously materialized entry so the selected route's argv[0] no
// longer resolves; returns the (now missing) same path.
async function removeEntry(root, name, platform = process.platform) {
  const file = absent(root, name, platform);
  await fs.rm(file, { force: true });
  return file;
}
async function writeConfig(f, { routes, routing }) {
  f.raw.routes = routes;
  if (routing === undefined) delete f.raw.routing; else f.raw.routing = routing;
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  return loadConfig(f.configFile);
}
const cliDeps = (api, results) => ({ loadAcpx: async () => api, replaceEnvironment: () => {}, output: r => results.push(r), progress: () => {} });
const runArgs = (f, extra = []) => ['run', '--config', f.configFile, '--cwd', f.cwd, '--file', f.orderFile, ...extra];
const startCalls = api => api.calls.filter(c => c[0] === 'start').length;

// ---------------------------------------------------------------------------
// Schema: optional routing; malformed/unknown/duplicate/self references rejected
// ---------------------------------------------------------------------------
test('a valid routing block loads; malformed, unknown, duplicate and self references are rejected', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  const routes = {
    a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }),
    b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }),
  };
  assert.deepEqual((await writeConfig(f, { routes, routing: { default: 'a', fallbacks: ['b'] } })).routing, { default: 'a', fallbacks: ['b'] });
  // `fallbacks` defaults to [] and the whole key may be absent.
  assert.deepEqual((await writeConfig(f, { routes, routing: { default: 'a' } })).routing, { default: 'a', fallbacks: [] });
  assert.deepEqual((await writeConfig(f, { routes })).routing, { default: null, fallbacks: [] });
  for (const bad of [
    { default: 'a', extra: true },           // unknown routing field
    { default: 'missing' },                  // unknown route reference
    { default: 'a', fallbacks: ['missing'] },
    { default: 'a', fallbacks: ['a'] },      // self reference
    { default: 'a', fallbacks: ['b', 'b'] }, // duplicate fallback
    { default: 3 },                          // wrong type
    'a',                                     // not an object
    { fallbacks: ['b'] },                    // no default
    { default: 'a', fallbacks: null },       // optional means omitted, not null
    { default: 'a', fallbacks: 'b' },        // wrong fallbacks type
  ]) await assert.rejects(writeConfig(f, { routes, routing: bad }), { code: 'BAD_CONFIG' }, JSON.stringify(bad));
  // Unknown top-level fields are still rejected.
  f.raw.routing = { default: 'a' }; f.raw.schedule = {};
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  await assert.rejects(loadConfig(f.configFile), { code: 'BAD_CONFIG' });
});

// ---------------------------------------------------------------------------
// Selection: default, explicit, no-policy
// ---------------------------------------------------------------------------
test('run omitting --route selects routing.default; without routing it must be explicit', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a');
  const routes = { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }) };
  await writeConfig(f, { routes, routing: { default: 'a' } });
  const api = fakeAcpx(), results = [], deps = cliDeps(api, results);
  assert.equal(await main(runArgs(f), deps), 0);
  assert.equal(results.at(-1).route, 'a');
  assert.deepEqual(results.at(-1).selection, { schema: 'cwr.acp.selection/1', requested_route: 'a', actual_route: 'a', fallback: null, skipped_routes: [] });

  // Same registered route, routing removed: run now demands --route and never guesses.
  await writeConfig(f, { routes });
  await assert.rejects(main(runArgs(f), deps), { code: 'ROUTE_REQUIRED' });
  assert.equal(await main(runArgs(f, ['--route', 'a']), deps), 0);
});

test('explicit --route uses that exact enabled route and never implicitly falls back', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a');
  const missingB = absent(f.root, 'b');
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [missingB] }) },
    // b is a declared fallback, but an explicit --route b must fail outright.
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx(), results = [];
  await assert.rejects(main(runArgs(f, ['--route', 'b']), cliDeps(api, results)), { code: 'BAD_EXECUTABLE' });
  assert.equal(startCalls(api), 0);
  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// Fallback: opt-in success, exhausted candidates, one launch
// ---------------------------------------------------------------------------
test('prelaunch fallback launches exactly one responsibility and records requested+actual+skip evidence', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const missingA = absent(f.root, 'a'), b = await entry(f.root, 'b');
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [missingA] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx(), results = [];
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 0);
  const r = results.at(-1);
  assert.equal(r.route, 'b');
  assert.deepEqual(r.selection, { schema: 'cwr.acp.selection/1', requested_route: 'a', actual_route: 'b', fallback: 'b', skipped_routes: [{ route: 'a', code: 'BAD_EXECUTABLE' }] });
  // Exactly ONE prompt/launch for the whole responsibility.
  assert.equal(startCalls(api), 1);
  assert.equal(api.calls.filter(c => c[0] === 'ensure').length, 1);
  // The persisted receipt carries the same bounded evidence and no env values.
  const stored = await readJSON(r.receipt_path, { privateFile: true });
  assert.deepEqual(stored.selection, r.selection);
  assert.ok(!JSON.stringify(r.selection).includes(f.root), 'selection must not leak a filesystem path');
});

test('an exhausted candidate set launches nothing and reports the bounded codes', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [absent(f.root, 'a')] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [absent(f.root, 'b')] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx(), results = [];
  await assert.rejects(main(runArgs(f), cliDeps(api, results)),
    e => e.code === 'SELECTED_ROUTE_UNAVAILABLE' && /a=BAD_EXECUTABLE/.test(e.message) && /b=BAD_EXECUTABLE/.test(e.message));
  assert.equal(api.calls.length, 0);
  assert.equal(results.length, 0);
  // No phantom dispatch responsibility was created for the preflight skips: the
  // only binding present is the fixture's pre-seeded one.
  const bindings = await fs.readdir(path.join(f.config.stateDir, 'bindings')).catch(() => []);
  assert.deepEqual(bindings, [f.binding.id]);
});

test('a missing required credential env opts into fallback; a disabled route never does', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  // Default requires a credential absent from the ambient environment.
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a], passEnv: ['SYNTHETIC_WORKER_KEY'] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx(), results = [];
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 0);
  assert.deepEqual(results.at(-1).selection.skipped_routes, [{ route: 'a', code: 'MISSING_CREDENTIAL_ENV' }]);
  assert.equal(results.at(-1).route, 'b');

  // The DEFAULT is now explicitly disabled: operator revocation is not bypassed
  // by a fallback, and the run is refused before any launch.
  const api2 = fakeAcpx(), results2 = [];
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a], enabled: false }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  await assert.rejects(main(runArgs(f), cliDeps(api2, results2)), { code: 'ROUTE_DISABLED' });
  assert.equal(startCalls(api2), 0);
  assert.equal(results2.length, 0);
});

test('permission and workspace denials do not fall back and are not masked by an unavailable entry', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  // Default forbids full permissions while the caller asks for full; b is a
  // registered, launchable fallback that must NOT be considered.
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a], maxPermissions: 'read' }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx(), results = [];
  await assert.rejects(main(runArgs(f, ['--permissions', 'full']), cliDeps(api, results)), { code: 'PERMISSION_DENIED' });
  assert.equal(startCalls(api), 0);

  // Default's workspace omits cwd (a REAL, registered directory elsewhere) AND
  // its entry is missing: the workspace denial must surface, not be masked by the
  // unavailable executable.
  const elsewhere = path.join(f.root, 'elsewhere');
  await fs.mkdir(elsewhere, { mode: 0o700 });
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [absent(f.root, 'a')], workspaces: [elsewhere] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  await assert.rejects(main(runArgs(f), cliDeps(api, results)), { code: 'WORKSPACE_NOT_ALLOWED' });
  assert.equal(startCalls(api), 0);
});

// ---------------------------------------------------------------------------
// Continuations: policy edits never rebind; revocation blocks resume, keeps control
// ---------------------------------------------------------------------------
test('a policy edit never invalidates a bound session; disabling its route blocks continue but keeps control', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  const routes = { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) };
  await writeConfig(f, { routes, routing: { default: 'a' } });
  const api = fakeAcpx(), results = [], deps = cliDeps(api, results);
  assert.equal(await main(runArgs(f), deps), 0);
  const id = results.at(-1).session_id;
  const fingerprintBefore = (await loadBinding(f.config.stateDir, id)).routeFingerprint;

  // Change ONLY the routing policy (default -> b, add fallback a). The bound
  // session keeps its fingerprint and continuation reuses route a.
  await writeConfig(f, { routes, routing: { default: 'b', fallbacks: ['a'] } });
  assert.equal(await main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), 0);
  assert.equal(results.at(-1).route, 'a');
  assert.equal((await loadBinding(f.config.stateDir, id)).routeFingerprint, fingerprintBefore);
  assert.equal(api.calls.filter(c => c[0] === 'ensure').length, 1);

  // Revoke route a: continue is refused, but status/cancel/close still work.
  await writeConfig(f, { routes: { ...routes, a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a], enabled: false }) }, routing: { default: 'b' } });
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), { code: 'ROUTE_DISABLED' });
  assert.equal(await main(['status', '--config', f.configFile, '--session', id], deps), 0);
  assert.equal(results.at(-1).active, 'idle');
  assert.equal(await main(['close', '--config', f.configFile, '--session', id], deps), 0);
  assert.equal(results.at(-1).closed, true);
});

test('continue never selects the default or a fallback, even when the bound route is unavailable', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) }, routing: { default: 'a' } });
  const api = fakeAcpx(), results = [], deps = cliDeps(api, results);
  assert.equal(await main(runArgs(f), deps), 0);
  const id = results.at(-1).session_id;
  // Remove a's entry and make b the default: continue must still
  // target a and fail, never silently rebind to b.
  const goneA = await removeEntry(f.root, 'a');
  await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [goneA] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) }, routing: { default: 'b' } });
  await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], deps), { code: 'BAD_EXECUTABLE' });
  assert.equal(startCalls(api), 1);
  assert.equal((await loadBinding(f.config.stateDir, id)).route, 'a');
});

test('route fingerprint is stable across unrelated routing edits', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  const routes = { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) };
  const c1 = await writeConfig(f, { routes, routing: { default: 'a' } });
  const c2 = await writeConfig(f, { routes, routing: { default: 'b', fallbacks: ['a'] } });
  assert.equal((await selectRoute(c1, 'a', f.cwd)).fingerprint, (await selectRoute(c2, 'a', f.cwd)).fingerprint);
});

// ---------------------------------------------------------------------------
// Unit-level resolution contract (the classification table)
// ---------------------------------------------------------------------------
test('resolveRouteSelection only continues on availability codes and each candidate once', async () => {
  const seen = [];
  const resolve = async name => {
    seen.push(name);
    if (name === 'a') throw Object.assign(new Error('no entry'), { code: 'BAD_EXECUTABLE' });
    if (name === 'b') throw Object.assign(new Error('no credential'), { code: 'MISSING_CREDENTIAL_ENV' });
    return { name };
  };
  const out = await resolveRouteSelection({ default: 'a', fallbacks: ['b', 'c'] }, resolve);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(out.selection.name, 'c');
  assert.equal(out.requestedRoute, 'a');
  assert.equal(out.fallback, 'c');
  assert.deepEqual(out.skips, [{ route: 'a', code: 'BAD_EXECUTABLE' }, { route: 'b', code: 'MISSING_CREDENTIAL_ENV' }]);

  // A non-availability fault is raised immediately and never advances.
  const seen2 = [];
  await assert.rejects(resolveRouteSelection({ default: 'a', fallbacks: ['b'] }, async name => {
    seen2.push(name);
    throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
  }), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(seen2, ['a']);
});

test('an unavailable default never infers fallback authorization from another registered route', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const b = await entry(f.root, 'b');
  await writeConfig(f, {
    routes: {
      a: routeFor(f.root, f.cwd, { __name: 'a', argv: [absent(f.root, 'a')] }),
      b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }),
    },
    routing: { default: 'a' },
  });
  const api = fakeAcpx(), results = [];
  await assert.rejects(main(runArgs(f), cliDeps(api, results)), { code: 'SELECTED_ROUTE_UNAVAILABLE' });
  assert.equal(startCalls(api), 0);
});

test('control commands stay usable when routes and routing are unusable', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a');
  const api = fakeAcpx(), results = [];
  await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }) }, routing: { default: 'a' } });
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 0);
  const id = results.at(-1).session_id;
  // A vanished route workspace AND a hand-edited malformed routing block must
  // not block status/close: control reads only the trusted state root.
  f.raw.routes.a.workspaces = [path.join(f.root, 'vanished')];
  f.raw.routing = { default: 'a', fallbacks: ['a'] };
  await fs.writeFile(f.configFile, JSON.stringify(f.raw));
  assert.equal(await main(['status', '--config', f.configFile, '--session', id], cliDeps(api, results)), 0);
  assert.equal(results.at(-1).active, 'idle');
  assert.equal(await main(['close', '--config', f.configFile, '--session', id], cliDeps(api, results)), 0);
  assert.equal(results.at(-1).closed, true);
});

// ---------------------------------------------------------------------------
// Canonical executable identity (regression for the restored baseline argv)
// ---------------------------------------------------------------------------
test('a symlinked entry resolves to its canonical target for both argv and hash, matching baseline', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const real = await entry(f.root, 'real');
  const alias = path.join(f.root, 'agent-alias');
  await fs.symlink(real, alias);
  const config = await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [alias, 'acp'] }) }, routing: { default: 'a' } });
  const selected = await selectRoute(config, 'a', f.cwd);
  // The canonical path is what is handed to the adapter AND what is hashed, so a
  // persisted session bound through the alias keeps one stable identity.
  assert.equal(selected.route.argv[0], await fs.realpath(real));
  assert.equal(selected.route.argv[1], 'acp');
  // Baseline compatibility: selecting the canonical entry directly yields the
  // same fingerprint as selecting it through the alias.
  const direct = await selectRoute(config, 'a', f.cwd);
  const configDirect = await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [await fs.realpath(real), 'acp'] }) }, routing: { default: 'a' } });
  const directSelection = await selectRoute(configDirect, 'a', f.cwd);
  // Identical argv after resolution => identical identity => identical fingerprint.
  assert.deepEqual(direct.route.argv, directSelection.route.argv);
  assert.equal(direct.fingerprint, directSelection.fingerprint);
});

// ---------------------------------------------------------------------------
// Unused stale route must not block a good default (inactive inventory)
// ---------------------------------------------------------------------------
test('a registered unused route with a vanished workspace does not block a good default run', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a');
  const api = fakeAcpx(), results = [];
  // `stale` is registered but never selected; its workspace directory does not
  // exist. The default `a` must still load and run.
  await writeConfig(f, {
    routes: {
      a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }),
      stale: routeFor(f.root, f.cwd, { __name: 'stale', argv: [a], workspaces: [path.join(f.root, 'vanished')] }),
    },
    routing: { default: 'a' },
  });
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 0);
  assert.equal(results.at(-1).route, 'a');
  // The selected route's OWN cwd must still exist and match the exact allowlist:
  // a missing selected cwd stays fatal and is never a fallback. It surfaces as
  // the raw ENOENT from the selected-cwd realpath (not a fallback code).
  const missingCwd = path.join(f.root, 'not-there');
  const before = startCalls(api);
  await assert.rejects(main(['run', '--config', f.configFile, '--cwd', missingCwd, '--file', f.orderFile], cliDeps(api, results)), { code: 'ENOENT' });
  assert.equal(startCalls(api), before);
});

// ---------------------------------------------------------------------------
// Behavior: policy edit between two NEW runs; no implicit historical route
// ---------------------------------------------------------------------------
test('a policy edit between two NEW runs changes the selected route', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  const routes = { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) };
  const api = fakeAcpx(), results = [], deps = cliDeps(api, results);
  await writeConfig(f, { routes, routing: { default: 'a' } });
  assert.equal(await main(runArgs(f), deps), 0);
  assert.equal(results.at(-1).route, 'a');
  // Change ONLY routing.default. A NEW run must select b; it must never implicitly
  // reuse the historically selected route a.
  await writeConfig(f, { routes, routing: { default: 'b' } });
  assert.equal(await main(runArgs(f), deps), 0);
  assert.equal(results.at(-1).route, 'b');
  assert.notEqual(results.at(-1).session_id, results.at(-2).session_id);
  assert.equal(api.calls.filter(c => c[0] === 'ensure').length, 2);
});

// ---------------------------------------------------------------------------
// Behavior: post-launch failures never trigger a second launch/fallback
// ---------------------------------------------------------------------------
test('an initialization failure with a configured backup does not launch a second time', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx({ initError: true }), results = [];
  // The engine converts a post-launch init failure into a failed receipt; the
  // CLI never falls back after launch.
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 1);
  assert.equal(results.at(-1).runtime_status, 'failed');
  assert.equal(results.at(-1).route, 'a');
  // Exactly one responsibility was attempted; the backup was never launched.
  assert.equal(api.calls.filter(c => c[0] === 'ensure').length, 1);
  assert.equal(startCalls(api), 0);
});

test('unconfirmed cleanup with a configured backup does not launch a second time', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a'), b = await entry(f.root, 'b');
  await writeConfig(f, {
    routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }), b: routeFor(f.root, f.cwd, { __name: 'b', argv: [b] }) },
    routing: { default: 'a', fallbacks: ['b'] },
  });
  const api = fakeAcpx({ cleanupError: true }), results = [];
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 1);
  assert.equal(results.at(-1).route, 'a');
  assert.equal(results.at(-1).cleanup, 'unconfirmed');
  assert.equal(api.calls.filter(c => c[0] === 'ensure').length, 1);
  assert.equal(startCalls(api), 1);
});

// ---------------------------------------------------------------------------
// Behavior: revocation keeps cancellation available with a held operation lock
// ---------------------------------------------------------------------------
test('revoked route still allows cancel against a genuinely held operation lock', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const a = await entry(f.root, 'a');
  const routes = { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a] }) };
  await writeConfig(f, { routes, routing: { default: 'a' } });
  const api = fakeAcpx(), results = [];
  assert.equal(await main(runArgs(f), cliDeps(api, results)), 0);
  const id = results.at(-1).session_id;
  // Revoke a and hold the session lock, as an in-flight/uncertain operation would.
  await writeConfig(f, { routes: { a: routeFor(f.root, f.cwd, { __name: 'a', argv: [a], enabled: false }) }, routing: { default: 'a' } });
  const p = paths(f.config.stateDir, id);
  const unlock = await lock(p.lock, { nonce: 'synthetic-held', pid: process.pid });
  try {
    // Continue is refused, but status and cancel remain usable for recovery.
    await assert.rejects(main(['continue', '--config', f.configFile, '--session', id, '--file', f.orderFile], cliDeps(api, results)), { code: 'ROUTE_DISABLED' });
    assert.equal(await main(['status', '--config', f.configFile, '--session', id], cliDeps(api, results)), 0);
    assert.equal(results.at(-1).active, 'owner_process_present');
    assert.equal(await main(['cancel', '--config', f.configFile, '--session', id], cliDeps(api, results)), 0);
    assert.equal(results.at(-1).cancel_requested, true);
    assert.equal(results.at(-1).stopped, false);
    await fs.unlink(path.join(p.lock, 'cancel.json'));
  } finally { await unlock(); }
  assert.equal(await main(['close', '--config', f.configFile, '--session', id], cliDeps(api, results)), 0);
  assert.equal(results.at(-1).closed, true);
});
