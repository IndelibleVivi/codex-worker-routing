// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Fault, atomicJSON, digest, lock, paths, privateDir, readJSON, sessionId, within } from './state.mjs';
import { canonicalFuture, loadConfig } from './config.mjs';

export const INVENTORY_SCHEMA = 'cwr.storage.inventory/1';
export const PLAN_SCHEMA = 'cwr.storage.plan/1';
export const APPLY_SCHEMA = 'cwr.storage.apply/1';
export const SCRATCH_SCHEMA = 'cwr.acp.scratch/1';
export const SCRATCH_SCHEMA_V2 = 'cwr.acp.scratch/2';
export const SCRATCH_DESCRIPTOR_SCHEMA = 'cwr.acp.scratch-descriptor/1';
export const SCRATCH_DIR = path.join('tmp', 'cwr-sessions');
export const SCRATCH_STATE_DIR = 'scratch';
export const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 200000, maxDepth: 96 });
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 256 * 1024;
const COMPACT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(value))
    throw new Fault('BAD_TARGET_ID', 'Expected a stable storage target id.');
  return value;
}
function targetId(kind, root, name) { return `${kind}-${digest([root, name]).slice(0, 32)}`; }
export function compactSessionKey(session) {
  sessionId(session);
  return Buffer.from(session.replaceAll('-', ''), 'hex').toString('base64url');
}
function scratchDescriptorShape(descriptor) {
  return {
    schema: descriptor.schema, format: descriptor.format, session_id: descriptor.session_id,
    route: descriptor.route, state_root: descriptor.state_root, home: descriptor.home,
    path: descriptor.path,
  };
}
export function newScratchLocation(config, routeName, route, session) {
  sessionId(session);
  const descriptor = {
    schema: SCRATCH_DESCRIPTOR_SCHEMA, format: 'state-short-v2', session_id: session,
    route: routeName, state_root: config.stateDir, home: route.workerHome,
    path: path.join(config.stateDir, SCRATCH_STATE_DIR, compactSessionKey(session)),
  };
  return descriptor;
}
export function v1ScratchLocation(config, routeName, route, session) {
  sessionId(session);
  return {
    schema: SCRATCH_DESCRIPTOR_SCHEMA, format: 'worker-home-v1', session_id: session,
    route: routeName, state_root: config.stateDir, home: route.workerHome,
    path: path.join(route.workerHome, SCRATCH_DIR, session),
  };
}
export function validateScratchDescriptor(config, routeName, route, session, descriptor) {
  sessionId(session);
  if (!descriptor || descriptor.schema !== SCRATCH_DESCRIPTOR_SCHEMA ||
      !['state-short-v2', 'worker-home-v1'].includes(descriptor.format) ||
      descriptor.session_id !== session || descriptor.route !== routeName ||
      descriptor.state_root !== config.stateDir || descriptor.home !== route.workerHome)
    throw new Fault('SCRATCH_DESCRIPTOR_MISMATCH', 'The saved scratch descriptor does not match this route, home, state and session.');
  const expected = descriptor.format === 'state-short-v2'
    ? newScratchLocation(config, routeName, route, session).path
    : v1ScratchLocation(config, routeName, route, session).path;
  if (descriptor.path !== expected)
    throw new Fault('SCRATCH_DESCRIPTOR_MISMATCH', 'The saved scratch descriptor resolves outside its exact expected location.');
  return scratchDescriptorShape(descriptor);
}
export function scratchRenderEnvironment(descriptor) {
  if (!descriptor || descriptor.schema !== SCRATCH_DESCRIPTOR_SCHEMA)
    throw new Fault('SCRATCH_DESCRIPTOR_MISMATCH', 'A validated scratch descriptor is required.');
  return descriptor.path;
}
function scratchManifestShape(manifest) {
  return {
    schema: manifest.schema, session_id: manifest.session_id,
    ...(manifest.schema === SCRATCH_SCHEMA_V2 ? { format: manifest.format, compact_id: manifest.compact_id } : {}),
    route: manifest.route,
    state_root: manifest.state_root, home: manifest.home, scratch: manifest.scratch,
    created_at: manifest.created_at,
  };
}
function expectedManifestPath(config, routeName, route, session, format) {
  return format === 'state-short-v2'
    ? newScratchLocation(config, routeName, route, session).path
    : v1ScratchLocation(config, routeName, route, session).path;
}
export function validateScratchManifest(config, routeName, route, session, manifest) {
  sessionId(session);
  const format = manifest?.schema === SCRATCH_SCHEMA_V2 ? 'state-short-v2'
    : manifest?.schema === SCRATCH_SCHEMA ? 'worker-home-v1' : null;
  if (!format) throw new Fault('MANIFEST_MISMATCH', 'Unknown scratch manifest schema.');
  const expected = expectedManifestPath(config, routeName, route, session, format);
  if (manifest.format !== undefined && manifest.format !== format)
    throw new Fault('MANIFEST_MISMATCH', 'Scratch manifest format does not match its schema.');
  if (manifest.session_id !== session || manifest.route !== routeName ||
      manifest.state_root !== config.stateDir || manifest.home !== route.workerHome ||
      manifest.scratch !== expected)
    throw new Fault('MANIFEST_MISMATCH', 'Scratch manifest does not belong to this session, route, home and state root.');
  if (format === 'state-short-v2' && manifest.compact_id !== compactSessionKey(session))
    throw new Fault('MANIFEST_MISMATCH', 'Scratch compact identifier does not match the session.');
  return {
    descriptor: {
      schema: SCRATCH_DESCRIPTOR_SCHEMA, format, session_id: session, route: routeName,
      state_root: config.stateDir, home: route.workerHome, path: expected,
    },
    manifest: scratchManifestShape(manifest),
  };
}
function emptyScan(root) {
  return {
    path: root, exists: false, bytes: 0, allocated_bytes: 0, entries: 0,
    oldest_mtime_ms: null, newest_mtime_ms: null, incomplete: false,
    warnings: [], links: 0, hardlinks: 0, special: 0, external_mounts: 0,
    entries_snapshot: [], scan: null,
  };
}
function stamp(result, st) {
  if (result.oldest_mtime_ms === null || st.mtimeMs < result.oldest_mtime_ms) result.oldest_mtime_ms = st.mtimeMs;
  if (result.newest_mtime_ms === null || st.mtimeMs > result.newest_mtime_ms) result.newest_mtime_ms = st.mtimeMs;
}
function recordFile(result, relative, st, depth) {
  const allocated = st.blocks === undefined ? st.size : st.blocks * 512;
  result.bytes += st.size;
  result.allocated_bytes += allocated;
  result.entries++;
  stamp(result, st);
  result.entries_snapshot.push({
    path: relative, type: 'file', size: st.size, allocated_bytes: allocated, nlink: st.nlink,
    mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: String(st.ino), dev: String(st.dev), depth,
  });
  if (st.nlink > 1) {
    result.hardlinks++;
    result.incomplete = true;
    result.warnings.push('HARDLINK');
  }
}

// Metadata-only walker shared by inventory and apply. It never follows a
// symlink, crosses a filesystem boundary or reads file content. A regular-file
// root remains a measurable metadata target (state/preferences or one DB file).
async function walk(root, { limits = DEFAULT_LIMITS, skipPaths = new Set(), expectedDevice } = {}) {
  const result = emptyScan(root);
  const maxEntries = limits.maxEntries, maxDepth = limits.maxDepth;
  let rootStat;
  try { rootStat = await fs.lstat(root); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { result.scan = 'missing'; return result; }
    result.incomplete = true; result.warnings.push('ROOT_UNREADABLE'); result.scan = 'error'; return result;
  }
  if (rootStat.isSymbolicLink()) {
    result.incomplete = true; result.warnings.push('ROOT_SYMLINK'); result.scan = 'unsafe';
    return result;
  }
  result.exists = true;
  if (expectedDevice !== undefined && rootStat.dev !== expectedDevice) {
    result.incomplete = true;
    result.warnings.push('MOUNT_SKIPPED');
    result.scan = 'incomplete';
    return result;
  }
  if (rootStat.isFile()) {
    recordFile(result, '.', rootStat, 0);
    result.scan = result.incomplete ? 'incomplete' : 'complete';
    return result;
  }
  if (!rootStat.isDirectory()) {
    result.incomplete = true; result.warnings.push('ROOT_SPECIAL'); result.scan = 'unsafe';
    return result;
  }
  const rootDevice = rootStat.dev;
  const stack = [{ dir: path.resolve(root), relative: '.', depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    let entries;
    try { entries = await fs.readdir(item.dir, { withFileTypes: true }); }
    catch (e) {
      result.incomplete = true; result.warnings.push(item.depth === 0 ? 'ROOT_UNREADABLE' : 'DIRECTORY_UNREADABLE');
      if (e.code === 'EACCES' || e.code === 'EPERM') result.warnings.push('PERMISSION_DENIED');
      continue;
    }
    if (entries.length > 10000) { result.incomplete = true; result.warnings.push('WIDE_DIRECTORY'); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = entries.length - 1; i >= 0; i--) {
      if (result.entries >= maxEntries) {
        result.incomplete = true; result.warnings.push('ENTRY_LIMIT');
        stack.length = 0; break;
      }
      const entry = entries[i];
      const full = path.join(item.dir, entry.name);
      const relative = item.relative === '.' ? entry.name : path.join(item.relative, entry.name);
      if (skipPaths.has(full)) continue;
      let st;
      try { st = await fs.lstat(full); }
      catch (e) {
        result.incomplete = true; result.warnings.push('ENTRY_UNREADABLE');
        if (e.code === 'EACCES' || e.code === 'EPERM') result.warnings.push('PERMISSION_DENIED');
        continue;
      }
      if (entry.isSymbolicLink() || st.isSymbolicLink()) {
        result.links++; result.incomplete = true; result.warnings.push('SYMLINK_SKIPPED');
        result.entries_snapshot.push({ path: relative, type: 'symlink', mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: String(st.ino), dev: String(st.dev), depth: item.depth + 1 });
        continue;
      }
      if (st.isFile()) { recordFile(result, relative, st, item.depth + 1); continue; }
      if (st.isDirectory()) {
        if (st.dev !== rootDevice) {
          result.external_mounts++; result.incomplete = true; result.warnings.push('MOUNT_SKIPPED');
          result.entries_snapshot.push({ path: relative, type: 'mount', mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: String(st.ino), dev: String(st.dev), depth: item.depth + 1 });
          continue;
        }
        if (item.depth + 1 > maxDepth) {
          result.incomplete = true; result.warnings.push('DEPTH_LIMIT'); continue;
        }
        result.entries++;
        stamp(result, st);
        result.entries_snapshot.push({ path: relative, type: 'directory', mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: String(st.ino), dev: String(st.dev), depth: item.depth + 1 });
        stack.push({ dir: full, relative, depth: item.depth + 1 });
        continue;
      }
      result.special++; result.incomplete = true; result.warnings.push('SPECIAL_SKIPPED');
      result.entries_snapshot.push({ path: relative, type: 'special', mtime_ms: st.mtimeMs, ctime_ms: st.ctimeMs, ino: String(st.ino), dev: String(st.dev), depth: item.depth + 1 });
    }
  }
  result.warnings = [...new Set(result.warnings)];
  result.scan = result.incomplete ? 'incomplete' : 'complete';
  return result;
}

// Checking the final entry alone is insufficient: an ancestor symlink can
// redirect both readdir and later deletion outside the selected home.
async function safeScan(root, options = {}) {
  let canonical;
  try { canonical = await canonicalFuture(root); }
  catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')
      return { ...emptyScan(root), incomplete: true,
        warnings: [e.code === 'UNSAFE_DIRECTORY' ? 'SYMLINK_SKIPPED' : 'ANCESTRY_UNSAFE'],
        scan: e.code === 'UNSAFE_DIRECTORY' ? 'unsafe' : 'incomplete' };
  }
  if (canonical !== undefined && canonical !== path.resolve(root))
    return { ...emptyScan(root), incomplete: true, warnings: ['ANCESTRY_CHANGED'], scan: 'unsafe' };
  return walk(root, options);
}

function emptyTotals() {
  return {
    logical_bytes: 0, allocated_bytes: 0, bytes: 0, entries: 0, homes: 0, scanned_targets: 0, targets: 0,
    eligible_logical_bytes: 0, eligible_allocated_bytes: 0,
    candidate_bytes: 0, candidate_allocated_bytes: 0, candidate_targets: 0,
  };
}
function reason(target, code, detail) { target.reasons.push({ code, ...(detail === undefined ? {} : { detail }) }); }
function addTotals(totals, scan) {
  totals.logical_bytes += scan.bytes;
  totals.bytes += scan.bytes;
  totals.allocated_bytes += scan.allocated_bytes;
  totals.entries += scan.entries;
}
function publicTarget(target) {
  const { entries_snapshot, snapshot, ...visible } = target;
  visible.logical_bytes = target.bytes;
  visible.eligible = target.eligibility === 'candidate';
  return visible;
}
function targetEligible(target, olderThanMs, now = Date.now()) {
  if (target.eligibility !== 'candidate') return false;
  return olderThanMs === 0 ||
    Number.isFinite(target.last_activity_ms) && target.last_activity_ms <= Date.now() - olderThanMs;
}

async function bindingForScratch(config, manifest, { checkLocks = true } = {}) {
  const p = paths(config.stateDir, manifest.session_id);
  let current;
  try { current = await readJSON(p.binding, { privateFile: true }); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'STATE_MISSING') return { code: 'BINDING_MISSING' };
    return { code: 'BINDING_UNREADABLE' };
  }
  if (current.schema !== 'cwr.acp.binding/1' || current.id !== manifest.session_id) return { code: 'BINDING_INVALID' };
  if (current.closed !== true) return { code: 'BINDING_OPEN' };
  if (current.cleanup !== 'confirmed') return { code: 'CLEANUP_UNCONFIRMED' };
  if (current.active_turn) return { code: 'ACTIVE_TURN' };
  if (current.route !== manifest.route) return { code: 'ROUTE_CHANGED' };
  const closedAt = Date.parse(current.closedAt);
  if (!Number.isFinite(closedAt)) return { code: 'CLOSE_TIME_UNKNOWN' };
  const route = config.routes[manifest.route];
  if (!route) return { code: 'ROUTE_CHANGED' };
  try { validateScratchManifest(config, manifest.route, route, manifest.session_id, manifest); }
  catch { return { code: 'MANIFEST_MISMATCH' }; }
  if (!checkLocks) return { code: null, binding: current, closed_at_ms: closedAt };
  let sessionLock, workspaceLock;
  try { await privateDir(p.lock, { create: false }); sessionLock = true; }
  catch (e) { if (e.code !== 'STATE_MISSING' && e.code !== 'ENOENT') return { code: 'LOCK_UNKNOWN' }; }
  if (sessionLock) return { code: 'SESSION_LOCK' };
  try { await privateDir(path.join(config.stateDir, 'workspace-locks', digest(current.cwd)), { create: false }); workspaceLock = true; }
  catch (e) { if (e.code !== 'STATE_MISSING' && e.code !== 'ENOENT') return { code: 'LOCK_UNKNOWN' }; }
  if (workspaceLock) return { code: 'WORKSPACE_LOCK' };
  return { code: null, binding: current, closed_at_ms: closedAt };
}

function privateTreeSnapshot(scan) {
  return {
    hash: digest(scan.entries_snapshot), bytes: scan.bytes, allocated_bytes: scan.allocated_bytes,
  };
}

async function scratchInventoryRoot(config, routeName, route, base, format, limits, olderThanMs, now) {
  const targets = [];
  if (base !== undefined) {
    let baseStat, names;
    try { baseStat = await fs.lstat(base); }
    catch (e) { if (e.code === 'ENOENT') return targets; throw e; }
    const ownerRoot = format === 'state-short-v2' ? config.stateDir : route.workerHome;
    const ownerDevice = (await fs.lstat(ownerRoot)).dev;
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory() || baseStat.dev !== ownerDevice) {
      targets.push({
        id: targetId('scratch', base, 'scratch-root'), kind: 'scratch', route: routeName,
        category: 'scratch', path: base, eligibility: 'incomplete',
        reasons: [{ code: 'UNSAFE_SCRATCH_ROOT' }], bytes: 0, allocated_bytes: 0,
        entries: 0, oldest_at: null, newest_at: null, scan: 'unsafe',
      });
      return targets;
    }
    names = await fs.readdir(base, { withFileTypes: true });
    for (const entry of names) {
      const id = entry.name;
      const target = {
        id: targetId('scratch', base, id), kind: 'scratch', route: routeName,
        category: 'scratch', path: path.join(base, id), eligibility: 'inspect_only',
        reasons: [], bytes: 0, allocated_bytes: 0, entries: 0,
        oldest_at: null, newest_at: null, scan: 'missing', hidden_entries: 0,
      };
      if (entry.isSymbolicLink()) {
        reason(target, 'SYMLINK_SKIPPED'); target.scan = 'unsafe'; targets.push(target); continue;
      }
      if (!entry.isDirectory() ||
          (format === 'state-short-v2' && !COMPACT_ID_RE.test(id)) ||
          (format === 'worker-home-v1' && !UUID_RE.test(id))) {
        const scan = await safeScan(target.path, { limits, expectedDevice: baseStat.dev });
        Object.assign(target, { bytes: scan.bytes, allocated_bytes: scan.allocated_bytes, entries: scan.entries,
          oldest_at: iso(scan.oldest_mtime_ms), newest_at: iso(scan.newest_mtime_ms), scan: scan.scan });
        reason(target, 'UNMANAGED_SCRATCH');
        if (scan.incomplete) target.eligibility = 'incomplete';
        targets.push(target); continue;
      }
      const scan = await safeScan(target.path, { limits, expectedDevice: baseStat.dev });
      Object.assign(target, { bytes: scan.bytes, allocated_bytes: scan.allocated_bytes, entries: scan.entries,
        oldest_at: iso(scan.oldest_mtime_ms), newest_at: iso(scan.newest_mtime_ms), scan: scan.scan });
      let manifest;
      try {
        manifest = await readJSON(path.join(target.path, '.cwr-scratch.json'), { privateFile: true, maxBytes: 4096 });
      } catch (e) {
        reason(target, e.code === 'ENOENT' ? 'MANIFEST_MISSING' : 'MANIFEST_UNREADABLE');
        if (scan.incomplete) target.eligibility = 'incomplete';
        targets.push(target); continue;
      }
      let validated;
      const ownerName = format === 'state-short-v2' ? manifest?.route : routeName;
      const ownerRoute = format === 'state-short-v2' ? config.routes[ownerName] : route;
      try { validated = validateScratchManifest(config, ownerName, ownerRoute, manifest?.session_id, manifest); }
      catch {
        reason(target, 'MANIFEST_MISMATCH');
        if (scan.incomplete) target.eligibility = 'incomplete';
        targets.push(target); continue;
      }
      if (validated.descriptor.path !== target.path || validated.descriptor.format !== format) {
        reason(target, 'MANIFEST_PATH_MISMATCH');
        if (scan.incomplete) target.eligibility = 'incomplete';
        targets.push(target); continue;
      }
      target.session_id = manifest.session_id;
      target.route = ownerName;
      target.format = format;
      target.descriptor = validated.descriptor;
      target.manifest = validated.manifest;
      target.snapshot = privateTreeSnapshot(scan);
      target.snapshot_observed_at = new Date().toISOString();
      const evaluated = await bindingForScratch(config, manifest);
      if (evaluated.code) reason(target, evaluated.code);
      if (scan.incomplete) target.eligibility = 'incomplete';
      else if (!evaluated.code) target.eligibility = 'candidate';
      if (!evaluated.code) {
        target.closed_at = new Date(evaluated.closed_at_ms).toISOString();
        target.last_activity_ms = Math.max(scan.newest_mtime_ms ?? 0, evaluated.closed_at_ms);
        target.last_activity_at = iso(target.last_activity_ms);
        target.retention_ms = olderThanMs;
        if (!targetEligible(target, olderThanMs, now)) {
          reason(target, 'TOO_RECENT');
          target.eligibility = 'inspect_only';
        }
      }
      targets.push(target);
    }
  }
  if (format === 'state-short-v2') for (const target of targets) {
    target.state_scratch = true;
    if (!target.descriptor) {
      target.unowned_state_scratch = true;
      reason(target, 'UNOWNED_STATE_SCRATCH');
      if (!COMPACT_ID_RE.test(path.basename(target.path))) {
        target.kind = 'state';
        target.category = 'runtime_state_config';
      }
    }
  }
  return targets;
}

async function scratchInventory(config, routes, limits, olderThanMs, now) {
  const targets = [];
  const privateSnapshots = new Map();
  for (const [routeName, route] of Object.entries(routes)) {
    targets.push(...await scratchInventoryRoot(config, routeName, route,
      path.join(route.workerHome, SCRATCH_DIR), 'worker-home-v1', limits, olderThanMs, now));
  }
  // This root is shared by every route. Read it once and derive each owner from
  // its validated manifest; another route must not create a duplicate target.
  targets.push(...await scratchInventoryRoot(config, null, null,
    path.join(config.stateDir, SCRATCH_STATE_DIR), 'state-short-v2', limits, olderThanMs, now));
  for (const target of targets) {
    if (target.descriptor) {
      privateSnapshots.set(target.id, target.snapshot);
    }
  }
  return { targets, privateSnapshots };
}

function codexClassification(name) {
  if (name === 'sessions' || name === 'archived_sessions' || name.startsWith('sessions.') ||
      name === 'history' || name === 'history.jsonl' || name === 'threads')
    return 'sessions_history';
  if (/^(?:logs?_\d+|logs?)(?:\.|$)/i.test(name) || /(?:^|[-_.])(?:sqlite3?|db|wal|shm)(?:-|$)/i.test(name))
    return 'logs_databases';
  if (name === '.tmp' || name === 'tmp') return 'scratch';
  return 'runtime_state_config';
}
function categoryTarget(kind, category, label, root, home, scan, extra = {}) {
  const target = {
    id: targetId(kind, home, label), kind, category, path: root,
    bytes: scan.bytes, allocated_bytes: scan.allocated_bytes, entries: scan.entries,
    oldest_at: iso(scan.oldest_mtime_ms), newest_at: iso(scan.newest_mtime_ms),
    eligibility: scan.incomplete ? 'incomplete' : 'inspect_only', reasons: [], scan: scan.scan,
    logical_bytes: scan.bytes, eligible: false, ...extra,
  };
  for (const code of [...new Set(scan.warnings)]) reason(target, code);
  return target;
}
function inspectReason(target, code) {
  if (!target.reasons.some(entry => entry.code === code)) reason(target, code);
  if (target.eligibility !== 'incomplete') target.eligibility = 'inspect_only';
}
function categoryRow(category, root, scan, extra = {}) {
  return {
    category, path: root, status: scan.exists ? scan.scan : 'missing',
    logical_bytes: scan.bytes, bytes: scan.bytes, allocated_bytes: scan.allocated_bytes,
    entries: scan.entries, oldest_at: iso(scan.oldest_mtime_ms), newest_at: iso(scan.newest_mtime_ms),
    incomplete: scan.incomplete, ...extra,
  };
}

// A `.codex` tree is split into disjoint direct-child roots. This keeps logs,
// SQLite/WAL/SHM, history and legacy .tmp visible without reading payloads.
async function classifiedTree(kind, root, home, limits, label = path.basename(root), extra = {}) {
  const expectedDevice = extra.expectedDevice;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (e) {
    const scan = emptyScan(root);
    scan.exists = e.code !== 'ENOENT' && e.code !== 'ENOTDIR';
    scan.incomplete = scan.exists;
    scan.scan = scan.exists ? 'error' : 'missing';
    if (scan.exists) scan.warnings.push('ROOT_UNREADABLE');
    const target = categoryTarget(kind, 'runtime_state_config', label, root, home, scan, extra);
    if (scan.incomplete) inspectReason(target, 'ROOT_UNREADABLE');
    return { targets: scan.exists ? [target] : [], rows: [categoryRow('runtime_state_config', root, scan)] };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const byCategory = new Map();
  for (const entry of entries) {
    const category = label === '.codex' ? codexClassification(entry.name) : 'runtime_state_config';
    const scan = await safeScan(path.join(root, entry.name), { limits, expectedDevice });
    const target = categoryTarget(kind, category, `${label}/${entry.name}`, path.join(root, entry.name), home, scan, extra);
    const code = category === 'sessions_history' ? 'PERSISTENT_HISTORY'
      : category === 'logs_databases' ? 'RUNTIME_LOGS_INSPECT_ONLY'
      : category === 'scratch' ? 'LEGACY_OR_UNOWNED_SCRATCH'
      : 'RUNTIME_STATE_INSPECT_ONLY';
    inspectReason(target, code);
    const rows = byCategory.get(category) ?? { targets: [], scan: emptyScan(root) };
    rows.targets.push(target);
    rows.scan.exists = true;
    rows.scan.bytes += scan.bytes; rows.scan.allocated_bytes += scan.allocated_bytes;
    rows.scan.entries += scan.entries;
    if (scan.oldest_mtime_ms !== null && (rows.scan.oldest_mtime_ms === null || scan.oldest_mtime_ms < rows.scan.oldest_mtime_ms))
      rows.scan.oldest_mtime_ms = scan.oldest_mtime_ms;
    if (scan.newest_mtime_ms !== null && (rows.scan.newest_mtime_ms === null || scan.newest_mtime_ms > rows.scan.newest_mtime_ms))
      rows.scan.newest_mtime_ms = scan.newest_mtime_ms;
    rows.scan.incomplete ||= scan.incomplete;
    rows.scan.scan = rows.scan.incomplete ? 'incomplete' : 'complete';
    byCategory.set(category, rows);
  }
  const targets = [], rows = [];
  for (const [category, aggregate] of byCategory) {
    targets.push(...aggregate.targets);
    rows.push(categoryRow(category, root, aggregate.scan));
  }
  return { targets, rows };
}

async function homeTargets(routeName, route, limits, expectedDevice, { retired = false } = {}) {
  const home = route.workerHome;
  const categories = [], targets = [];
  const add = async (category, root, label, skipPaths = new Set()) => {
    const scan = await safeScan(root, { limits, skipPaths, expectedDevice });
    const target = categoryTarget(retired ? 'extra_home' : 'home', category, label, root, home, scan,
      { route: routeName, ...(retired ? { retired_profile: true } : {}) });
    if (category === 'sessions_history') inspectReason(target, 'PERSISTENT_HISTORY');
    else if (category === 'cache') inspectReason(target, 'UNKNOWN_CACHE_OWNERSHIP');
    else if (category === 'logs_databases') inspectReason(target, 'RUNTIME_LOGS_INSPECT_ONLY');
    else if (category === 'runtime_state_config') inspectReason(target, 'RUNTIME_STATE_INSPECT_ONLY');
    else if (category === 'scratch') {
      target.session_scratch_only = true; inspectReason(target, 'LEGACY_OR_UNOWNED_SCRATCH');
    }
    if (retired) inspectReason(target, 'RETIRED_PROFILE_INSPECT_ONLY');
    categories.push(categoryRow(category, root, scan));
    targets.push(target);
  };
  await add('scratch', path.join(home, 'tmp'), 'tmp', new Set([path.join(home, SCRATCH_DIR)]));
  await add('cache', path.join(home, '.cache'), '.cache');
  const codex = await classifiedTree(retired ? 'extra_home' : 'home', path.join(home, '.codex'), home, limits, '.codex',
    { route: routeName, expectedDevice, ...(retired ? { retired_profile: true } : {}) });
  if (retired) for (const target of codex.targets) inspectReason(target, 'RETIRED_PROFILE_INSPECT_ONLY');
  categories.push(...codex.rows); targets.push(...codex.targets);
  await add('runtime_state_config', path.join(home, '.config'), '.config');
  await add('runtime_state_config', path.join(home, '.local/share'), '.local/share');
  await add('logs_databases', path.join(home, '.local/state'), '.local/state');
  await add('runtime_state_config', path.join(home, '.claude'), '.claude');
  const known = new Set(['tmp', '.cache', '.codex', '.config', '.local', '.claude']);
  let top = [];
  try { top = await fs.readdir(home, { withFileTypes: true }); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const entry of top.sort((a, b) => a.name.localeCompare(b.name))) {
    if (known.has(entry.name)) continue;
    const root = path.join(home, entry.name);
    const scan = await safeScan(root, { limits, expectedDevice });
    const target = categoryTarget(retired ? 'extra_home' : 'home', 'runtime_state_config', entry.name, root, home, scan,
      { route: routeName, home_remainder: true, ...(retired ? { retired_profile: true } : {}) });
    inspectReason(target, 'UNKNOWN_HOME_REMAINDER');
    if (retired) inspectReason(target, 'RETIRED_PROFILE_INSPECT_ONLY');
    categories.push(categoryRow('runtime_state_config', root, scan, { remainder: true }));
    targets.push(target);
  }
  return { categories, targets };
}

async function stateTargets(config, limits, homeDevices) {
  const targets = [], categories = [];
  const known = [
    ['cwr_state_receipts', 'bindings'], ['cwr_state_receipts', 'receipts'],
    ['cwr_state_receipts', 'requests'], ['cwr_state_receipts', 'events'],
    ['sessions_history', 'acpx'], ['runtime_state_config', 'workspace-locks'],
    ['cwr_state_receipts', 'storage'],
  ];
  const covered = new Set(known.map(([, name]) => name));
  try {
    const top = await fs.readdir(config.stateDir, { withFileTypes: true });
    for (const entry of top) {
      if (entry.name === SCRATCH_STATE_DIR) continue;
      if (covered.has(entry.name) || entry.name.startsWith('.')) continue;
      known.push([entry.name === 'dashboard-preferences.json' ? 'runtime_state_config' : 'cwr_state_receipts', entry.name]);
    }
  } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  for (const [category, name] of known) {
    const root = path.join(config.stateDir, name);
    const scan = await safeScan(root, { limits, expectedDevice: homeDevices.state });
    const target = categoryTarget('state', category, name, root, config.stateDir, scan);
    inspectReason(target, category === 'sessions_history' ? 'PERSISTENT_HISTORY' : 'CWR_STATE_INSPECT_ONLY');
    if (scan.incomplete) target.eligibility = 'incomplete';
    targets.push(target);
    categories.push(categoryRow(category, root, scan));
  }
  return { targets, categories };
}

async function validateExtraHomes(config, extraHomes) {
  if (extraHomes === undefined) return [];
  if (!Array.isArray(extraHomes) || extraHomes.length > 8)
    throw new Fault('BAD_EXTRA_HOMES', 'extraHomes must be an array of at most eight retired dedicated homes.');
  const canonical = [];
  const current = [config.stateDir, ...Object.values(config.routes).flatMap(route => [route.workerHome, ...route.workspaces])];
  for (const raw of extraHomes) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0'))
      throw new Fault('BAD_EXTRA_HOME', 'Each extra home must be an absolute path.');
    let home = path.resolve(raw), stat;
    try { stat = await fs.lstat(home); }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Fault('EXTRA_HOME_MISSING', 'A retired profile must exist as a local directory.');
      throw e;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Fault('EXTRA_HOME_UNSAFE', 'A retired profile must be a real directory, not a link.');
    try { home = await canonicalFuture(home); }
    catch (e) { throw new Fault('EXTRA_HOME_UNSAFE', 'A retired profile has an unsafe ancestor.'); }
    // A dedicated profile under the operator home is normal. The main home
    // itself and any broad ancestor are not retired profiles.
    if (home === config.mainHome || within(home, config.mainHome))
      throw new Fault('EXTRA_HOME_OVERLAP', 'A retired profile may be below the operator home but never the home itself or an ancestor.');
    for (const blocked of current) {
      if (within(blocked, home) || within(home, blocked))
        throw new Fault('EXTRA_HOME_OVERLAP', 'Extra homes must be disjoint from configured state, workspaces and worker homes.');
    }
    for (const other of canonical) if (within(other, home) || within(home, other))
      throw new Fault('EXTRA_HOME_OVERLAP', 'Extra retired profiles must be disjoint from one another.');
    canonical.push(home);
  }
  return canonical;
}

export async function inventoryStorage(config, options = {}) {
  const olderThanMs = options.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new Fault('BAD_CUTOFF', 'olderThanMs must be a non-negative integer.');
  const limits = {
    maxEntries: Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? Math.min(options.maxEntries, 1000000) : DEFAULT_LIMITS.maxEntries,
    maxDepth: Number.isSafeInteger(options.maxDepth) && options.maxDepth > 0 ? Math.min(options.maxDepth, 256) : DEFAULT_LIMITS.maxDepth,
  };
  const extraHomes = await validateExtraHomes(config, options.extraHomes);
  const now = Date.now();
  const homes = [], targets = [], warnings = [];
  const privateSnapshots = new Map();
  for (const [routeName, route] of Object.entries(config.routes)) {
    const homeStat = await fs.lstat(route.workerHome).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const scanned = await homeTargets(routeName, route, limits, homeStat?.dev);
    homes.push({ route: routeName, status: 'configured', path: route.workerHome,
      totals: { logical_bytes: scanned.categories.reduce((n, c) => n + c.logical_bytes, 0) },
      categories: scanned.categories });
    targets.push(...scanned.targets);
  }
  const scratch = await scratchInventory(config, config.routes, limits, olderThanMs, now);
  targets.push(...scratch.targets);
  for (const [id, snapshot] of scratch.privateSnapshots) privateSnapshots.set(id, snapshot);
  const stateRootStat = await fs.lstat(config.stateDir).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const state = await stateTargets(config, limits, { state: stateRootStat?.dev });
  // The reserved scratch root was scanned above. Attribute validated trees to
  // their route, and unowned state scratch to CWR state without rescanning it.
  targets.push(...state.targets);
  homes.push({ route: null, name: 'CWR state', status: 'retained', path: config.stateDir,
    categories: state.categories,
    totals: { logical_bytes: state.categories.reduce((n, c) => n + c.logical_bytes, 0) } });
  for (const target of scratch.targets) {
    const home = typeof target.route === 'string'
      ? homes.find(home => home.route === target.route)
      : homes.find(home => home.name === 'CWR state');
    home.categories.push({ category: target.descriptor ? 'managed_scratch' : 'unowned_scratch',
      path: target.path, status: target.scan, bytes: target.bytes, logical_bytes: target.bytes,
      allocated_bytes: target.allocated_bytes, entries: target.entries,
      oldest_at: target.oldest_at, newest_at: target.newest_at,
      incomplete: target.eligibility === 'incomplete' });
    home.totals.logical_bytes += target.bytes;
  }
  for (const home of extraHomes) {
    const retiredRoute = { workerHome: home, workspaces: [] };
    const homeStat = await fs.lstat(home);
    const scanned = await homeTargets(null, retiredRoute, limits, homeStat.dev, { retired: true });
    for (const target of scanned.targets) inspectReason(target, 'RETIRED_PROFILE_INSPECT_ONLY');
    targets.push(...scanned.targets);
    homes.push({ route: null, name: path.basename(home), status: 'retired_extra', path: home,
      categories: scanned.categories,
      totals: { logical_bytes: scanned.categories.reduce((n, row) => n + row.logical_bytes, 0) } });
  }
  const totals = emptyTotals();
  for (const target of targets) {
    addTotals(totals, target);
    if (targetEligible(target, olderThanMs, now)) {
      totals.candidate_bytes += target.bytes; totals.candidate_allocated_bytes += target.allocated_bytes;
      totals.eligible_logical_bytes += target.bytes; totals.eligible_allocated_bytes += target.allocated_bytes;
      totals.candidate_targets++;
    }
  }
  targets.sort((a, b) => a.id.localeCompare(b.id));
  totals.scanned_targets = totals.targets = targets.length;
  totals.homes = homes.length;
  const result = { schema: INVENTORY_SCHEMA, observed_at: new Date(now).toISOString(), totals, homes,
    targets: targets.map(publicTarget), warnings };
  Object.defineProperty(result, '_privateSnapshots', { value: privateSnapshots, enumerable: false });
  return result;
}

function stableTarget(target) {
  return { id: target.id, kind: target.kind, category: target.category, path: target.path,
    eligibility: target.eligibility, bytes: target.bytes, allocated_bytes: target.allocated_bytes,
    entries: target.entries, session_id: target.session_id ?? null, route: target.route ?? null,
    manifest: target.manifest ?? null, snapshot: target.snapshot,
    closed_at: target.closed_at ?? null, last_activity_at: target.last_activity_at ?? null,
    snapshot_observed_at: target.snapshot_observed_at ?? null };
}
function planFile(stateDir, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Fault('BAD_PLAN_ID', 'Expected a storage plan UUID.');
  return path.join(stateDir, 'storage', 'plans', `${id}.json`);
}
function planIntegrity(plan) {
  return digest({
    schema: plan.schema, plan_id: plan.plan_id, action: plan.action, created_at: plan.created_at,
    older_than_ms: plan.older_than_ms, state_root: plan.state_root, totals: plan.totals, targets: plan.targets,
  });
}

export async function planStorage(config, options = {}) {
  let targetIds = options.targetIds;
  if (targetIds === undefined && Array.isArray(options.targets)) {
    if (options.targets.some(item => typeof item !== 'string')) throw new Fault('BAD_TARGETS', 'targets must contain inventory target ids.');
    targetIds = options.targets;
  }
  if (!Array.isArray(targetIds) || !targetIds.length || targetIds.length > 64 || new Set(targetIds).size !== targetIds.length)
    throw new Fault('BAD_TARGETS', 'targetIds must be a non-empty list of distinct inventory target ids.');
  const olderThanMs = options.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new Fault('BAD_CUTOFF', 'olderThanMs must be a non-negative integer.');
  const inventory = await inventoryStorage(config, { olderThanMs, maxEntries: options.maxEntries, maxDepth: options.maxDepth });
  const selected = targetIds.map(id => inventory.targets.find(target => target.id === safeId(id)));
  if (selected.some(target => !target)) throw new Fault('TARGET_NOT_FOUND', 'A selected target is absent or ambiguous; inventory can never be treated as complete evidence of absence.');
  const now = Date.now();
  const planTargets = [];
  for (const target of selected) {
    if (target.eligibility !== 'candidate') throw new Fault('TARGET_NOT_ELIGIBLE', 'Only managed scratch with all ownership and lifecycle evidence may enter a plan.');
    const binding = await bindingForScratch(config, target.manifest, { checkLocks: false });
    if (binding.code) throw new Fault('TARGET_NOT_ELIGIBLE', 'Managed scratch is not closed and confirmed.');
    const last = Math.max(Date.parse(target.last_activity_at), binding.closed_at_ms);
    if (!Number.isFinite(last) || olderThanMs !== 0 && last > now - olderThanMs)
      throw new Fault('TARGET_TOO_RECENT', 'The scratch tree or binding close time is newer than the requested cutoff.');
    const planned = stableTarget({ ...target, snapshot: inventory._privateSnapshots.get(target.id) });
    planned.integrity = digest([planned.path, planned.manifest, planned.snapshot, planned.bytes, planned.allocated_bytes]);
    planTargets.push(planned);
  }
  const plan = { schema: PLAN_SCHEMA, plan_id: randomUUID(), action: 'delete_managed_scratch',
    created_at: new Date(now).toISOString(), older_than_ms: olderThanMs, state_root: config.stateDir,
    totals: { bytes: planTargets.reduce((n, target) => n + target.bytes, 0), allocated_bytes: planTargets.reduce((n, target) => n + target.allocated_bytes, 0), targets: planTargets.length },
    targets: planTargets };
  plan.integrity = planIntegrity(plan);
  await atomicJSON(planFile(config.stateDir, plan.plan_id), plan);
  return plan;
}

export function storageWriterProbe(scratch, options = {}) {
  if (options.writerProbe !== undefined) return options.writerProbe;
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    return async () => ({ safe: false, code: 'WRITER_PROBE_UNSUPPORTED' });
  const lsof = options.lsofPath ?? (process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof');
  return root => runLsof(root, lsof);
}
function runLsof(root, lsofPath) {
  return new Promise(resolve => {
    let done = false, stdout = '', stderr = '', bytes = 0, timer;
    const child = spawn(lsofPath, ['-nP', '-Fpn', '-a', '-u', String(process.getuid()), '+D', root], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer); resolve(result);
    };
    timer = setTimeout(() => { child.kill('SIGKILL'); finish({ safe: false, code: 'WRITER_PROBE_TIMEOUT' }); }, PROBE_TIMEOUT_MS);
    const collect = (stream, output) => stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > PROBE_MAX_BYTES) { child.kill('SIGKILL'); finish({ safe: false, code: 'WRITER_PROBE_OUTPUT_LIMIT' }); return; }
      if (output === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    });
    collect(child.stdout, 'stdout'); collect(child.stderr, 'stderr');
    child.once('error', error => finish({ safe: false, code: error.code === 'ENOENT' ? 'WRITER_PROBE_UNAVAILABLE' : 'WRITER_PROBE_FAILED' }));
    child.once('close', code => {
      if (stderr.trim()) return finish({ safe: false, code: 'WRITER_PROBE_WARNING' });
      if (stdout.trim()) return finish({ safe: false, code: 'WRITER_HANDLE_PRESENT' });
      // lsof returns 1 when no selected handles were found. Only that exact
      // empty, warning-free result (or exit 0) is evidence for this scan.
      finish(code === 0 || code === 1 ? { safe: true } : { safe: false, code: 'WRITER_PROBE_FAILED' });
    });
  });
}

function inflightFile(stateDir, planId) { return path.join(stateDir, 'storage', 'inflight', `${planId}.json`); }
function receiptFile(stateDir, planId) { return path.join(stateDir, 'storage', 'receipts', `${planId}.json`); }

export async function applyStoragePlan(config, options = {}) {
  const planId = options.planId;
  if (typeof planId !== 'string' || !UUID_RE.test(planId)) throw new Fault('BAD_PLAN_ID', 'Expected a storage plan UUID.');
  if (options.confirm !== planId) throw new Fault('CONFIRMATION_REQUIRED', 'Apply requires --confirm with the exact saved plan id.');
  const plan = await readJSON(planFile(config.stateDir, planId), { privateFile: true, maxBytes: 1024 * 1024 });
  if (plan.schema !== PLAN_SCHEMA || plan.plan_id !== planId || plan.action !== 'delete_managed_scratch' ||
      plan.state_root !== config.stateDir || !Array.isArray(plan.targets) || !plan.targets.length)
    throw new Fault('PLAN_TAMPERED', 'The saved storage plan is invalid or belongs to another state root.');
  const unsigned = { ...plan }, stamped = unsigned.integrity; delete unsigned.integrity;
  if (typeof stamped !== 'string' || stamped !== planIntegrity(unsigned))
    throw new Fault('PLAN_TAMPERED', 'The saved plan changed after it was written; nothing was removed.');
  for (const target of plan.targets) {
    if (!target || typeof target !== 'object')
      throw new Fault('PLAN_TAMPERED', 'A saved plan target is malformed; nothing was removed.');
    if (!target.manifest || typeof target.manifest !== 'object' || typeof target.manifest.scratch !== 'string' ||
        typeof target.last_activity_at !== 'string' || !Number.isFinite(Date.parse(target.last_activity_at)))
      throw new Fault('PLAN_TAMPERED', 'A saved plan target is missing its retention identity.');
    if (!target || typeof target.id !== 'string' || typeof target.path !== 'string' || !target.manifest ||
        !target.snapshot || typeof target.snapshot.hash !== 'string' || !Number.isSafeInteger(target.bytes) ||
        !Number.isSafeInteger(target.allocated_bytes))
      throw new Fault('PLAN_TAMPERED', 'A saved plan target is malformed; nothing was removed.');
    if (target.integrity !== digest([target.path, target.manifest, target.snapshot, target.bytes, target.allocated_bytes]))
      throw new Fault('PLAN_TAMPERED', 'A saved plan target was altered after planning; nothing was removed.');
  }
  const lockOwner = { nonce: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), kind: 'storage-apply' };
  const unlockApply = await lock(path.join(config.stateDir, 'storage', 'apply.lock'), lockOwner);
  // A plan UUID identifies one attempt. A lost reply or repeated confirmation
  // must read back its terminal result, never overwrite history or retry a
  // partially deleted tree. Unknown in-progress evidence needs reconciliation.
  let previous = null;
  try { previous = await readJSON(receiptFile(config.stateDir, planId), { privateFile: true }); }
  catch (error) { if (error.code !== 'ENOENT') { await unlockApply(); throw error; } }
  if (previous) {
    try {
      if (previous.schema !== APPLY_SCHEMA || previous.plan_id !== planId ||
          !['applied', 'partial', 'failed'].includes(previous.status) || !Array.isArray(previous.targets))
        throw new Fault('PLAN_UNRECONCILED', 'This plan already has non-terminal or invalid operation evidence; reconcile it before any new action.');
      return { ...previous, replayed: true };
    } finally { await unlockApply(); }
  }
  const receipt = { schema: APPLY_SCHEMA, plan_id: planId, status: 'applying', deleted_logical_bytes: 0,
    deleted_allocated_bytes: 0, disk_freed_estimate: 0, targets: [], started_at: new Date().toISOString(),
    older_than_ms: plan.older_than_ms, lock_nonce: lockOwner.nonce };
  let final = false, deletionStarted = false;
  try {
    // Persist the witness before any target mutation. If this process dies after
    // a deletion begins, the retained apply lock and `applying` receipt remain
    // available for explicit reconciliation; nothing automatically resumes.
    await atomicJSON(inflightFile(config.stateDir, planId), receipt);
    await atomicJSON(receiptFile(config.stateDir, planId), receipt);
    const probe = storageWriterProbe(null, options);
    for (const target of plan.targets) {
      const entry = { id: target.id, path: target.path, status: 'pending', deleted_logical_bytes: 0,
        deleted_allocated_bytes: 0, reason: null };
      receipt.targets.push(entry);
      try {
        if (!path.isAbsolute(target.path)) throw new Fault('OUTSIDE_PATH', 'A plan target is outside the exact scratch root.');
        const route = Object.values(config.routes).find(value => path.dirname(target.path) === path.join(value.workerHome, SCRATCH_DIR));
        const expectedV1 = route && UUID_RE.test(path.basename(target.path));
        const expectedV2 = path.dirname(target.path) === path.join(config.stateDir, SCRATCH_STATE_DIR) &&
          COMPACT_ID_RE.test(path.basename(target.path));
        if ((!expectedV1 && !expectedV2) || target.manifest.scratch !== target.path)
          throw new Fault('OUTSIDE_PATH', 'A plan target is outside the exact recognized scratch root.');
        try {
          validateScratchManifest(config, target.manifest.route, config.routes[target.manifest.route], target.manifest.session_id, target.manifest);
        } catch {
          throw new Fault('MANIFEST_MISMATCH', 'Plan manifest does not match its exact scratch root.');
        }
        let workspaceLock, sessionLock;
        try {
          const currentConfig = await loadConfig(config.configPath, process.platform, { mainHome: config.mainHome });
          if (currentConfig.stateDir !== config.stateDir) throw new Fault('CONFIG_CHANGED', 'The configured state root changed after the plan was loaded.');
          const currentRoute = currentConfig.routes[target.manifest.route];
          if (!currentRoute || currentRoute.workerHome !== target.manifest.home) throw new Fault('CONFIG_CHANGED', 'The configured worker home or route changed after the plan was loaded.');
          const lockedBinding = await readJSON(paths(config.stateDir, target.manifest.session_id).binding, { privateFile: true });
          if (lockedBinding.closed !== true || lockedBinding.cleanup !== 'confirmed' || lockedBinding.active_turn)
            throw new Fault('LIFECYCLE_CHANGED', 'The closed binding changed before apply locked it.');
          // Preserve the same admission order as run/continue. A live session
          // lock must be reported as a safety reason, not surfaced as an opaque
          // temporary directory error from the lock primitive itself.
          try { await privateDir(paths(config.stateDir, target.manifest.session_id).lock, { create: false }); }
          catch (e) {
            if (e.code !== 'STATE_MISSING' && e.code !== 'ENOENT') throw e;
          }
          try { await privateDir(paths(config.stateDir, target.manifest.session_id).lock, { create: false }); throw new Fault('SESSION_LOCK', 'A session lock prevents cleanup.'); }
          catch (e) { if (e.code !== 'STATE_MISSING' && e.code !== 'ENOENT') throw e; }
          try { await privateDir(path.join(config.stateDir, 'workspace-locks', digest(lockedBinding.cwd)), { create: false }); throw new Fault('WORKSPACE_LOCK', 'A workspace lock prevents cleanup.'); }
          catch (e) { if (e.code !== 'STATE_MISSING' && e.code !== 'ENOENT') throw e; }
          workspaceLock = await lock(path.join(config.stateDir, 'workspace-locks', digest(lockedBinding.cwd)), lockOwner);
          sessionLock = await lock(paths(config.stateDir, target.manifest.session_id).lock, lockOwner);
          try {
            const finalCheck = await bindingForScratch(config, target.manifest, { checkLocks: false });
            if (finalCheck.code) throw new Fault(finalCheck.code, 'Managed scratch lifecycle changed before deletion.');
            const liveReceipt = await readJSON(receiptFile(config.stateDir, planId), { privateFile: true });
            if (liveReceipt.status !== 'applying') throw new Fault('PLAN_INTERRUPTED', 'The apply receipt is no longer in progress.');
            const closeAt = Date.parse(lockedBinding.closedAt);
            if (!Number.isFinite(closeAt)) throw new Fault('CLOSE_TIME_UNKNOWN', 'The binding has no valid close time.');
            const last = Math.max(Date.parse(target.last_activity_at), closeAt);
            if (!Number.isFinite(last) || plan.older_than_ms !== 0 && last > Date.now() - plan.older_than_ms)
              throw new Fault('TARGET_TOO_RECENT', 'The scratch tree or binding close time is newer than the retained plan cutoff.');
            const finalSnapshot = await verifySnapshot(target);
            if (!finalSnapshot.ok) throw new Fault(finalSnapshot.code, 'Managed scratch changed after planning.');
            // The executable/process probe must run under both ownership locks.
            const writer = await probe(target.path);
            if (!writer || writer.safe !== true)
              throw new Fault(writer?.code ?? 'WRITER_PROBE_FAILED', 'An external writer may still hold this scratch.');
            const stats = { logical: 0, allocated: 0, files: 0 };
            entry.status = 'deleting';
            deletionStarted = true;
            await atomicJSON(receiptFile(config.stateDir, planId), receipt);
            const targetJournal = path.join(config.stateDir, 'storage', 'inflight', `${planId}.target-${target.id}.json`);
            await atomicJSON(targetJournal, {
              schema: 'cwr.storage.apply-target/1', plan_id: planId, target_id: target.id,
              status: 'deleting', started_at: new Date().toISOString(), snapshot: target.snapshot.hash,
            });
            try {
              await removeTree(target.path, stats);
              entry.deleted_logical_bytes = stats.logical;
              entry.deleted_allocated_bytes = stats.allocated;
              await atomicJSON(targetJournal, {
                schema: 'cwr.storage.apply-target/1', plan_id: planId, target_id: target.id,
                status: 'deleted', deleted_logical_bytes: stats.logical,
                deleted_allocated_bytes: stats.allocated, snapshot: target.snapshot.hash,
              });
            }
            catch (e) {
              entry.status = stats.files > 0 ? 'partial' : 'incomplete';
              entry.deleted_logical_bytes = stats.logical;
              entry.deleted_allocated_bytes = stats.allocated;
              entry.deletion_uncertain = stats.files === 0;
              receipt.deleted_logical_bytes += stats.logical;
              receipt.deleted_allocated_bytes += stats.allocated;
              throw e;
            }
            entry.status = 'deleted'; entry.deleted_logical_bytes = stats.logical; entry.deleted_allocated_bytes = stats.allocated;
            receipt.deleted_logical_bytes += stats.logical; receipt.deleted_allocated_bytes += stats.allocated;
            await atomicJSON(receiptFile(config.stateDir, planId), receipt);
          } finally { await sessionLock(); }
        } finally { if (workspaceLock) await workspaceLock(); }
      } catch (e) {
        entry.reason = typeof e.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'APPLY_FAILED';
        entry.error_code = entry.reason;
        receipt.error_code = entry.reason;
        if (entry.status === 'pending') entry.status = 'failed';
        await atomicJSON(receiptFile(config.stateDir, planId), receipt);
        break;
      }
    }
    const allDeleted = receipt.targets.length === plan.targets.length && receipt.targets.every(target => target.status === 'deleted');
    const uncertain = receipt.targets.some(target => ['deleting', 'partial', 'incomplete'].includes(target.status));
    receipt.status = allDeleted ? 'applied' : receipt.deleted_logical_bytes || uncertain ? 'partial' : 'failed';
    receipt.disk_freed_estimate = receipt.deleted_allocated_bytes;
    receipt.disk_freed_estimate_basis = 'allocated_bytes';
    final = true;
  } catch (error) {
    throw error;
  } finally {
    if (final) {
      receipt.finished_at = new Date().toISOString();
      await atomicJSON(receiptFile(config.stateDir, planId), receipt);
      for (const target of plan.targets) {
        await fs.unlink(path.join(config.stateDir, 'storage', 'inflight', `${planId}.target-${target.id}.json`))
          .catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await fs.unlink(inflightFile(config.stateDir, planId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await unlockApply();
    }
    else if (!deletionStarted) {
      // A failure before any mutation is a known failed apply, not an unknown
      // cleanup: finalize the durable receipt and release the owned apply lock.
      receipt.status = 'failed';
      receipt.finished_at = new Date().toISOString();
      await atomicJSON(receiptFile(config.stateDir, planId), receipt);
      await fs.unlink(inflightFile(config.stateDir, planId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await unlockApply();
    }
    // Once deletion starts, an unexpected throw/crash retains the inflight
    // witness and real apply lock for explicit reconciliation.
  }
  return receipt;
}

async function removeTree(root, stats) {
  let current;
  try { current = await fs.lstat(root); }
  catch (e) { if (e.code === 'ENOENT') return { missing: true }; throw e; }
  if (current.isSymbolicLink() || !current.isDirectory()) throw new Fault('UNSAFE_TARGET', 'Managed scratch changed to an unsafe directory.');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => { throw new Fault('TARGET_CHANGED', 'Managed scratch became unreadable.'); });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const st = await fs.lstat(full);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Fault('UNSAFE_TARGET', 'Managed scratch contains a link or special file.');
    if (st.isFile()) {
      if (st.nlink !== 1) throw new Fault('UNSAFE_TARGET', 'Managed scratch contains a hardlink.');
      await fs.unlink(full);
      stats.logical += st.size; stats.allocated += st.blocks === undefined ? st.size : st.blocks * 512;
      stats.files++;
    } else {
      await removeTree(full, stats);
    }
  }
  await fs.rmdir(root);
  return { missing: false };
}
async function verifySnapshot(target) {
  const scan = await safeScan(target.path, { limits: { maxEntries: 1000000, maxDepth: 256 } });
  if (scan.scan !== 'complete') return { ok: false, code: 'TARGET_INCOMPLETE' };
  if (digest(scan.entries_snapshot) !== target.snapshot.hash) return { ok: false, code: 'TARGET_CHANGED' };
  if (scan.bytes !== target.snapshot.bytes || scan.allocated_bytes !== target.snapshot.allocated_bytes)
    return { ok: false, code: 'TARGET_CHANGED' };
  return { ok: true, scan };
}

export function legacyScratchPath(route, session) {
  sessionId(session);
  return path.join(route.workerHome, SCRATCH_DIR, session);
}
export async function createScratch(config, routeName, route, session) {
  sessionId(session);
  const descriptor = newScratchLocation(config, routeName, route, session);
  const scratch = descriptor.path;
  await privateDir(path.join(config.stateDir, SCRATCH_STATE_DIR));
  await privateDir(scratch);
  const manifestPath = path.join(scratch, '.cwr-scratch.json');
  try { await fs.lstat(manifestPath); throw new Fault('SCRATCH_EXISTS', 'A scratch manifest already exists for this session.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const manifest = { schema: SCRATCH_SCHEMA_V2, format: descriptor.format, session_id: session,
    compact_id: compactSessionKey(session), route: routeName,
    state_root: config.stateDir, home: route.workerHome, scratch, created_at: new Date().toISOString() };
  await atomicJSON(manifestPath, manifest);
  return { ...manifest, descriptor };
}
export async function loadScratch(config, routeName, route, session, descriptor = null) {
  sessionId(session);
  const candidates = descriptor
    ? [validateScratchDescriptor(config, routeName, route, session, descriptor)]
    : [v1ScratchLocation(config, routeName, route, session), newScratchLocation(config, routeName, route, session)];
  let manifest;
  let selected;
  for (const candidate of candidates) {
    try {
      manifest = await readJSON(path.join(candidate.path, '.cwr-scratch.json'), { privateFile: true, maxBytes: 4096 });
      selected = candidate;
      break;
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  }
  if (!manifest) throw new Fault(descriptor ? 'KNOWN_SCRATCH_MISSING' : 'SCRATCH_MISSING',
    descriptor ? 'The binding records managed scratch, but its manifest is missing.' : 'This binding has no managed scratch manifest.');
  const validated = validateScratchManifest(config, routeName, route, session, manifest);
  if (validated.descriptor.path !== selected.path)
    throw new Fault('MANIFEST_MISMATCH', 'Scratch manifest resolved to a different path.');
  return { ...validated.manifest, descriptor: validated.descriptor };
}
