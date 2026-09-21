// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Fault, readJSON, regular, privateDir, within, digest } from './state.mjs';

function exact(obj, keys, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Fault('BAD_CONFIG', `${where} must be an object.`);
  if (Object.keys(obj).some(k => !keys.includes(k))) throw new Fault('BAD_CONFIG', `Unknown field in ${where}.`);
}
function str(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Fault('BAD_CONFIG', `Invalid ${name}.`);
  return value;
}
// Windows resolves environment names case-insensitively; the allowlist and the
// isolation-critical reservations must use the same rule or `home`/`userprofile`
// could bypass them and overwrite the worker home.
const WINDOWS_NETWORK_OR_DEVICE_ROOT = /^[\\/]{2}/;
export function assertLocalManagedPath(value, name, platform = process.platform) {
  if (platform === 'win32' && WINDOWS_NETWORK_OR_DEVICE_ROOT.test(value))
    throw new Fault('UNSUPPORTED_PATH_ROOT', `${name} must be on a local drive; network-share, UNC and device paths are not supported for managed roots.`);
  return value;
}
function absolute(value, name, platform = process.platform) {
  str(value, name);
  if (!path.isAbsolute(value)) throw new Fault('BAD_CONFIG', `${name} must be absolute.`);
  return assertLocalManagedPath(path.resolve(value), name, platform);
}
export function readAmbient(env, name, platform = process.platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const matched = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase());
  return matched === undefined ? undefined : env[matched];
}
export async function canonicalFuture(value) {
  try {
    if ((await fs.lstat(value)).isSymbolicLink()) throw new Fault('UNSAFE_DIRECTORY', 'Managed root cannot itself be a symlink.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let p = path.resolve(value), suffix = [];
  while (true) {
    try { return path.join(await fs.realpath(p), ...suffix); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(p);
      if (parent === p) throw e;
      suffix.unshift(path.basename(p)); p = parent;
    }
  }
}
// A lexical check is not enough: a local-looking path can still canonicalize
// through a symlink, junction or drive mapping into an explicit UNC/device root.
// Re-apply the root check to the final target before it is trusted. The
// canonicalizer is injectable so the post-canonical check is testable without a
// real Windows share.
export async function canonicalManagedPath(value, name, platform = process.platform, canonical = canonicalFuture) {
  return assertLocalManagedPath(await canonical(value), name, platform);
}
// Workspace entries are inactive inventory until their route is selected, so an
// absent registered workspace must not be fatal at load time. Resolve a present
// directory through the supplied canonicalizer (preserving the injected seam's
// post-canonical root check); only a genuinely absent path falls back to the
// ENOENT-tolerant walker, which still normalizes a missing tail canonically.
async function resolveWorkspace(value, platform, canonical) {
  const abs = absolute(value, 'workspace', platform);
  try { return await canonical(abs); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; return await canonicalFuture(abs); }
}
// Case-insensitive because Windows environment names are. Windows profile and
// loader controls join the POSIX ones so passEnv cannot re-point the worker home,
// the temp directory or the process loader.
const FORBIDDEN_ENV = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|PATH|TMPDIR|NODE(?:_[A-Z0-9_]*)?|NPM_.*|LD_.*|DYLD_.*|XDG_.*|CODEX_.*|CLAUDE_CONFIG_DIR|CWR_.*|PYTHON.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|IFS)$/i;
const ROUTE_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
async function loadConfigDocument(file, platform = process.platform, deps = {}) {
  const realpath = deps.realpath ?? (p => fs.realpath(p));
  // The config file is a trusted root like any other: reject an explicit
  // UNC/device path lexically before realpath touches it. A relative path still
  // resolves from cwd. The basename stays unconsumed so a symlinked config file
  // is still rejected by readJSON, but the containing directory must resolve to a
  // trusted local root.
  const requested = assertLocalManagedPath(path.resolve(str(file, 'config file path')), 'config file path', platform);
  const configPath = await realpath(path.dirname(requested))
    .then(d => assertLocalManagedPath(path.join(d, path.basename(requested)), 'config file path', platform));
  const raw = await readJSON(configPath, { privateFile: true, maxBytes: 128 * 1024 });
  exact(raw, ['schema', 'stateDir', 'routes', 'routing'], 'config');
  if (raw.schema !== 'cwr.acp.config/1') throw new Fault('BAD_CONFIG', 'Unsupported config schema.');
  exact(raw.routes, Object.keys(raw.routes ?? {}), 'routes');
  const stateDir = await canonicalManagedPath(absolute(raw.stateDir, 'stateDir', platform), 'stateDir', platform, deps.canonicalize);
  return { configPath, raw, stateDir };
}

// OPTIONAL top-level routing policy: {default, fallbacks}. It stays inside the
// same private config and never introduces a catalog, profile or scheduler.
// Malformed/unknown/duplicate/self references are rejected. Membership is
// re-checked against the REGISTERED route names after the route loop, so the
// schema is validated here and the references are validated in loadConfig.
function parseRouting(raw) {
  if (raw.routing === undefined) return { default: null, fallbacks: [] };
  const r = raw.routing;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Fault('BAD_CONFIG', 'routing must be an object.');
  exact(r, ['default', 'fallbacks'], 'routing');
  const def = str(r.default, 'routing.default');
  if (!ROUTE_NAME.test(def)) throw new Fault('BAD_CONFIG', 'Invalid routing.default route name.');
  const rawFallbacks = r.fallbacks === undefined ? [] : r.fallbacks;
  // Optional means omitted: an explicit null/other type is malformed, not "use
  // the default empty list". The config byte limit already bounds the list.
  if (!Array.isArray(rawFallbacks)) throw new Fault('BAD_CONFIG', 'routing.fallbacks must be an array of route names.');
  const fallbacks = rawFallbacks.map(name => str(name, 'routing.fallbacks entry'));
  for (const name of fallbacks) if (!ROUTE_NAME.test(name)) throw new Fault('BAD_CONFIG', 'Invalid routing.fallbacks route name.');
  const seen = new Set([def]);
  for (const name of fallbacks) {
    if (seen.has(name)) throw new Fault('BAD_CONFIG', 'routing.fallbacks must not repeat a route or name routing.default.');
    seen.add(name);
  }
  return { default: def, fallbacks };
}

// Recovery/control commands need only the trusted state root. They must remain
// usable when an unrelated route is disabled, malformed, or points at a
// workspace that disappeared after a crash.
export async function loadControlConfig(file, platform = process.platform, deps = {}) {
  const { configPath, stateDir } = await loadConfigDocument(file, platform, deps);
  return { configPath, stateDir };
}

export async function loadConfig(file, platform = process.platform, deps = {}) {
  const { configPath, raw, stateDir } = await loadConfigDocument(file, platform, deps);
  const realpath = deps.realpath ?? (p => fs.realpath(p));
  const mainHome = await fs.realpath(os.homedir());
  const routing = parseRouting(raw);
  const routes = {};
  for (const [name, r] of Object.entries(raw.routes)) {
    if (!ROUTE_NAME.test(name)) throw new Fault('BAD_CONFIG', 'Invalid route name.');
    exact(r, ['enabled','argv','workerHome','workspaces','passEnv','contextRevision','maxPermissions','sessionOptions','timeoutMs'], `route ${name}`);
    if (typeof r.enabled !== 'boolean') throw new Fault('BAD_CONFIG', 'enabled must be boolean.');
    if (!Array.isArray(r.argv) || !r.argv.length || r.argv.length > 64 || r.argv.some(a => typeof a !== 'string' || a.includes('\0')))
      throw new Fault('BAD_CONFIG', 'argv must be an argument array; shell command strings are not accepted.');
    absolute(r.argv[0], 'argv[0]', platform);
    const workerHome = await canonicalManagedPath(absolute(r.workerHome, 'workerHome', platform), 'workerHome', platform, deps.canonicalize);
    // A dedicated subtree is allowed, but never the existing user home itself
    // or its ancestor. Homes for other routes must not overlap.
    if (workerHome === mainHome || within(workerHome, mainHome)) throw new Fault('PRIVATE_HOME_REUSE', 'Use a dedicated worker home, not the main home.');
    if (!Array.isArray(r.workspaces) || !r.workspaces.length) throw new Fault('BAD_CONFIG', 'Declare exact allowed workspaces.');
    // Registered workspaces are INACTIVE inventory until a route is actually
    // selected: a stale unused route's vanished workspace must not block a good
    // default. Validate the lexical contract now (absolute + local root) and
    // canonicalize so a missing tail is still normalized for overlap checks and
    // fingerprints. A present workspace resolves through the same realpath used
    // before (the injected seam still re-checks the canonical root); only a
    // genuinely absent directory falls back to the ENOENT-tolerant walker. The
    // SELECTED route's real cwd is re-checked with realpath/stat in selectRoute.
    const workspaces = await Promise.all(r.workspaces.map(async w =>
      assertLocalManagedPath(await resolveWorkspace(w, platform, realpath), 'workspace', platform)));
    if (workspaces.some(w => within(w, workerHome) || within(workerHome, w) || within(w, stateDir) || within(stateDir, w)))
      throw new Fault('STATE_IN_WORKSPACE', 'Worker homes/state and granted workspaces must be disjoint.');
    const passEnv = r.passEnv ?? [];
    if (!Array.isArray(passEnv) || passEnv.some(k => typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || FORBIDDEN_ENV.test(k)))
      throw new Fault('UNSAFE_ENV', 'passEnv may contain credential/proxy names, not process-injection or home controls.');
    if (!['read','full'].includes(r.maxPermissions)) throw new Fault('BAD_CONFIG', 'maxPermissions must be read or full.');
    const sessionOptions = r.sessionOptions ?? {};
    exact(sessionOptions, ['model'], 'sessionOptions');
    if (sessionOptions.model !== undefined) str(sessionOptions.model, 'model');
    const timeoutMs = r.timeoutMs ?? 900000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) throw new Fault('BAD_CONFIG', 'timeoutMs must be 100..3600000.');
    routes[name] = { ...r, argv: [...r.argv], workerHome, workspaces, passEnv: [...new Set(passEnv)], contextRevision: str(r.contextRevision, 'contextRevision'), sessionOptions, timeoutMs };
  }
  const homes = Object.values(routes).map(r => r.workerHome);
  for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++)
    if (within(homes[i], homes[j]) || within(homes[j], homes[i])) throw new Fault('SHARED_WORKER_HOME', 'Different routes require disjoint worker homes.');
  for (const name of [routing.default, ...routing.fallbacks])
    if (name !== null && !Object.hasOwn(routes, name)) throw new Fault('BAD_CONFIG', `routing references an unregistered route: ${name}.`);
  return { configPath, stateDir, routes, mainHome, routing };
}
// Only capabilities this integration actually exercises are claimed. Other
// platforms are rejected before any config is read.
export const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);
export function assertSupportedPlatform(platform = process.platform) {
  if (!SUPPORTED_PLATFORMS.includes(platform))
    throw new Fault('UNSUPPORTED_PLATFORM', `v0.1 supports ${SUPPORTED_PLATFORMS.join(', ')} on local filesystems.`);
  return platform;
}
// POSIX execute bits and the Windows executable-extension set are different
// questions. On Windows Node exposes no execute bit, so the narrow supported
// contract is a real file whose extension Windows can launch directly or through
// the cmd shim policy acpx already implements.
const WINDOWS_ENTRY_EXTENSIONS = new Set(['.exe', '.com', '.cmd', '.bat']);
export function executableProblem(executable, stat, platform = process.platform) {
  if (!stat.isFile()) return 'ACP executable must exist as a regular file.';
  if (platform === 'win32') {
    const ext = path.extname(executable).toLowerCase();
    return WINDOWS_ENTRY_EXTENSIONS.has(ext) ? null
      : `On Windows the ACP entry must be an .exe, .com, .cmd or .bat file; got ${ext ? `"${ext}"` : 'no extension'}.`;
  }
  return (stat.mode & 0o111) ? null : 'ACP executable must exist and be executable.';
}
export async function selectRoute(config, name, cwd, permissions = 'read', ambient = process.env, platform = process.platform, deps = {}) {
  const realpath = deps.realpath ?? (p => fs.realpath(p));
  const route = config.routes[name];
  if (!route || route.enabled !== true) throw new Fault('ROUTE_DISABLED', 'The named ACP route is absent or disabled. Native routing has not been changed.');
  if (!['read','full'].includes(permissions) || permissions === 'full' && route.maxPermissions !== 'full')
    throw new Fault('PERMISSION_DENIED', 'This route does not authorize the requested ACP permission mode.');
  const realCwd = assertLocalManagedPath(await realpath(absolute(cwd, 'cwd', platform)), 'cwd', platform);
  if (!route.workspaces.includes(realCwd)) throw new Fault('WORKSPACE_NOT_ALLOWED', 'cwd must match an explicitly registered workspace.');
  if (!(await fs.stat(realCwd)).isDirectory()) throw new Fault('BAD_WORKSPACE', 'cwd must be a directory.');
  const { executable, executableHash } = await resolveRouteExecutable(route, ambient, platform, realpath);
  // The canonical resolved entry is what is hashed AND what is handed to the
  // adapter, so a symlinked/aliased entry keeps one stable identity for an
  // existing persisted session.
  const argv = [executable, ...route.argv.slice(1)];
  const identity = { name, argv, workerHome: route.workerHome, passEnv: route.passEnv, contextRevision: route.contextRevision, sessionOptions: route.sessionOptions, maxPermissions: route.maxPermissions, workspaces: route.workspaces, timeoutMs: route.timeoutMs, executableHash };
  return { name, route: { ...route, argv: identity.argv }, cwd: realCwd, permissions, fingerprint: digest(identity) };
}
// Resolve only the SELECTED route's entry and required credentials. A run that
// selects one route must not be blocked by a routine, stale, unrelated route
// whose entry or explicitly required credential env is currently unavailable.
// This runs once for the chosen route; resolveRouteSelection owns the fallback loop.
async function resolveRouteExecutable(route, ambient, platform, realpath) {
  // Only a missing/unlaunchable ENTRY (or a missing required credential) is a
  // prelaunch availability failure. Tag those specifically so the caller never
  // treats an unrelated ENOENT (for example a vanished workspace, which is
  // resolved earlier and is a workspace failure) as a fixable route.
  let executable;
  try { executable = assertLocalManagedPath(await realpath(route.argv[0]), 'argv[0]', platform); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; throw new Fault('BAD_EXECUTABLE', 'ACP executable entry is missing.'); }
  let stat;
  try { stat = await fs.stat(executable); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; throw new Fault('BAD_EXECUTABLE', 'ACP executable entry is missing.'); }
  const problem = executableProblem(executable, stat, platform);
  if (problem) throw new Fault('BAD_EXECUTABLE', problem);
  // Hashing the entry executable detects replacement, not all of a CLI's transitive code/config.
  const executableHash = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  for (const k of route.passEnv) if (!readAmbient(ambient, k, platform)) throw new Fault('MISSING_CREDENTIAL_ENV', `Required environment variable is missing: ${k}`);
  return { executable, executableHash };
}
// Only a missing or unlaunchable adapter entry, or a missing explicitly required
// credential env, authorizes a prelaunch fallback. Permission, workspace, disabled
// route, unsafe config/state, BUSY, invalid order, dependency failure, cancellation
// and any runtime-phase error are deliberately excluded.
//
// The executable-missing condition is normalized to BAD_EXECUTABLE inside
// resolveRouteExecutable. A canonicalized UNC/device root, a permission error, a
// vanished workspace and every other Fault code stay fatal, so an unsafe or
// unauthorized state can never masquerade as a fixable route.
const ROUTE_UNAVAILABLE = new Set(['BAD_EXECUTABLE', 'MISSING_CREDENTIAL_ENV']);
export function isRouteUnavailable(e) {
  return Boolean(e) && ROUTE_UNAVAILABLE.has(e.code);
}
// Prelaunch route resolution for a single `run` without an explicit --route.
// `resolve(name)` MUST call selectRoute, so the full permission + workspace +
// disabled + credential contract runs for the default before ANY fallback is
// considered: an earlier permission or workspace denial is never masked by an
// unavailable executable. Fallbacks are tried in declared order at most once
// each, and only for ROUTE_UNAVAILABLE failures of an earlier candidate.
// `requestedRoute` is the registered `routing.default` this policy started from.
export async function resolveRouteSelection(routing, resolve) {
  const requestedRoute = routing.default;
  const skipped = [];
  for (const name of [requestedRoute, ...routing.fallbacks]) {
    try {
      return { selection: await resolve(name), requestedRoute, fallback: name !== requestedRoute ? name : null, skips: skipped };
    } catch (e) {
      if (!isRouteUnavailable(e)) throw e;
      skipped.push({ route: name, code: e.code });
    }
  }
  const codes = skipped.map(s => `${s.route}=${s.code}`).join(', ');
  throw new Fault('SELECTED_ROUTE_UNAVAILABLE', `No authorized route is available for this run (${codes}). Native routing has not been changed.`);
}
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
export function buildEnvironment(route, ambient = process.env, platform = process.platform) {
  const h = route.workerHome;
  const systemRoot = platform === 'win32' ? readAmbient(ambient, 'SystemRoot', platform) || 'C:\\Windows' : null;
  const env = {
    HOME: h, USERPROFILE: h,
    PATH: readAmbient(ambient, 'PATH', platform) || (platform === 'win32' ? `${systemRoot}\\System32;${systemRoot}` : DEFAULT_PATH),
    LANG: 'C.UTF-8', TMPDIR: path.join(h, 'tmp'),
    XDG_CONFIG_HOME: path.join(h, '.config'), XDG_DATA_HOME: path.join(h, '.local/share'),
    XDG_CACHE_HOME: path.join(h, '.cache'), XDG_STATE_HOME: path.join(h, '.local/state'),
    CODEX_HOME: path.join(h, '.codex'), CLAUDE_CONFIG_DIR: path.join(h, '.claude'),
  };
  if (platform === 'win32') {
    env.TEMP = path.join(h, 'tmp'); env.TMP = path.join(h, 'tmp');
    env.APPDATA = path.join(h, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(h, 'AppData', 'Local');
    // Loader/launcher variables the OS and acpx need before an ACP adapter can
    // start. They come from the operator's ambient environment, never from route
    // config, and they carry no credentials.
    env.SystemRoot = systemRoot; env.windir = systemRoot;
    env.COMSPEC = readAmbient(ambient, 'COMSPEC', platform) || path.join(systemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = readAmbient(ambient, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD';
  }
  // Last line of defense: an isolation-critical name can never be overwritten by
  // passEnv, even if a caller hands over a route that skipped config validation.
  const reserved = new Set(Object.keys(env).map(k => k.toUpperCase()));
  for (const key of route.passEnv) {
    if (reserved.has(key.toUpperCase())) continue;
    const value = readAmbient(ambient, key, platform);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
export async function prepareHome(route, platform = process.platform) {
  await privateDir(route.workerHome, { platform });
  const dirs = ['tmp','.config','.local/share','.cache','.local/state','.codex','.claude'];
  if (platform === 'win32') dirs.push(path.join('AppData','Roaming'), path.join('AppData','Local'));
  for (const p of dirs) await privateDir(path.join(route.workerHome, p), { platform });
}
export async function readOrder(file) {
  const order = await regular(path.resolve(file), { maxBytes: 128 * 1024 });
  if (!order.trim()) throw new Fault('EMPTY_ORDER', 'A work order cannot be empty.');
  return order;
}
export function replaceOwnEnvironment(next) {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, next);
}
