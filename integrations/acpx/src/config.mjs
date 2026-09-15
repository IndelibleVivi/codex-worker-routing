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
function absolute(value, name) {
  str(value, name);
  if (!path.isAbsolute(value)) throw new Fault('BAD_CONFIG', `${name} must be absolute.`);
  return path.resolve(value);
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
const FORBIDDEN_ENV = /^(?:HOME|PATH|TMPDIR|TMP|TEMP|NODE_.*|NODE|NPM_.*|npm_.*|LD_.*|DYLD_.*|XDG_.*|CODEX_.*|CLAUDE_CONFIG_DIR|CWR_.*|PYTHON.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|IFS)$/;
async function loadConfigDocument(file) {
  const configPath = await fs.realpath(path.dirname(path.resolve(file))).then(d => path.join(d, path.basename(file)));
  const raw = await readJSON(configPath, { privateFile: true, maxBytes: 128 * 1024 });
  exact(raw, ['schema', 'stateDir', 'routes'], 'config');
  if (raw.schema !== 'cwr.acp.config/1') throw new Fault('BAD_CONFIG', 'Unsupported config schema.');
  exact(raw.routes, Object.keys(raw.routes ?? {}), 'routes');
  const stateDir = await canonicalFuture(absolute(raw.stateDir, 'stateDir'));
  return { configPath, raw, stateDir };
}

// Recovery/control commands need only the trusted state root. They must remain
// usable when an unrelated route is disabled, malformed, or points at a
// workspace that disappeared after a crash.
export async function loadControlConfig(file) {
  const { configPath, stateDir } = await loadConfigDocument(file);
  return { configPath, stateDir };
}

export async function loadConfig(file) {
  const { configPath, raw, stateDir } = await loadConfigDocument(file);
  const mainHome = await fs.realpath(os.homedir());
  const routes = {};
  for (const [name, r] of Object.entries(raw.routes)) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) throw new Fault('BAD_CONFIG', 'Invalid route name.');
    exact(r, ['enabled','argv','workerHome','workspaces','passEnv','contextRevision','maxPermissions','sessionOptions','timeoutMs'], `route ${name}`);
    if (typeof r.enabled !== 'boolean') throw new Fault('BAD_CONFIG', 'enabled must be boolean.');
    if (!Array.isArray(r.argv) || !r.argv.length || r.argv.length > 64 || r.argv.some(a => typeof a !== 'string' || a.includes('\0')))
      throw new Fault('BAD_CONFIG', 'argv must be an argument array; shell command strings are not accepted.');
    absolute(r.argv[0], 'argv[0]');
    const workerHome = await canonicalFuture(absolute(r.workerHome, 'workerHome'));
    // A dedicated subtree is allowed, but never the existing user home itself
    // or its ancestor. Homes for other routes must not overlap.
    if (workerHome === mainHome || within(workerHome, mainHome)) throw new Fault('PRIVATE_HOME_REUSE', 'Use a dedicated worker home, not the main home.');
    if (!Array.isArray(r.workspaces) || !r.workspaces.length) throw new Fault('BAD_CONFIG', 'Declare exact allowed workspaces.');
    const workspaces = await Promise.all(r.workspaces.map(async w => await fs.realpath(absolute(w, 'workspace'))));
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
  return { configPath, stateDir, routes, mainHome };
}
export async function selectRoute(config, name, cwd, permissions = 'read', ambient = process.env) {
  const route = config.routes[name];
  if (!route || route.enabled !== true) throw new Fault('ROUTE_DISABLED', 'The named ACP route is absent or disabled. Native routing has not been changed.');
  if (!['read','full'].includes(permissions) || permissions === 'full' && route.maxPermissions !== 'full')
    throw new Fault('PERMISSION_DENIED', 'This route does not authorize the requested ACP permission mode.');
  const realCwd = await fs.realpath(absolute(cwd, 'cwd'));
  if (!route.workspaces.includes(realCwd)) throw new Fault('WORKSPACE_NOT_ALLOWED', 'cwd must match an explicitly registered workspace.');
  if (!(await fs.stat(realCwd)).isDirectory()) throw new Fault('BAD_WORKSPACE', 'cwd must be a directory.');
  const executable = await fs.realpath(route.argv[0]);
  const stat = await fs.stat(executable);
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new Fault('BAD_EXECUTABLE', 'ACP executable must exist and be executable.');
  // Hashing the entry executable detects replacement, not all of a CLI's transitive code/config.
  const executableHash = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  for (const k of route.passEnv) if (!ambient[k]) throw new Fault('MISSING_CREDENTIAL_ENV', `Required environment variable is missing: ${k}`);
  const identity = { name, argv: [executable,...route.argv.slice(1)], workerHome: route.workerHome, passEnv: route.passEnv, contextRevision: route.contextRevision, sessionOptions: route.sessionOptions, maxPermissions: route.maxPermissions, workspaces: route.workspaces, timeoutMs: route.timeoutMs, executableHash };
  return { name, route: { ...route, argv: identity.argv }, cwd: realCwd, permissions, fingerprint: digest(identity) };
}
export function buildEnvironment(route, ambient = process.env) {
  const h = route.workerHome;
  const env = {
    HOME: h, USERPROFILE: h,
    PATH: ambient.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', TMPDIR: path.join(h, 'tmp'),
    XDG_CONFIG_HOME: path.join(h, '.config'), XDG_DATA_HOME: path.join(h, '.local/share'),
    XDG_CACHE_HOME: path.join(h, '.cache'), XDG_STATE_HOME: path.join(h, '.local/state'),
    CODEX_HOME: path.join(h, '.codex'), CLAUDE_CONFIG_DIR: path.join(h, '.claude'),
  };
  for (const key of route.passEnv) if (ambient[key] !== undefined) env[key] = ambient[key];
  return env;
}
export async function prepareHome(route) {
  await privateDir(route.workerHome);
  for (const p of ['tmp','.config','.local/share','.cache','.local/state','.codex','.claude'])
    await privateDir(path.join(route.workerHome, p));
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
