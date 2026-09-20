// SPDX-License-Identifier: SUL-1.0
// Local workspace identity for the private Dispatch projection.
//
// The projection groups responsibilities by the workspace they were dispatched
// against. Identity is derived ONLY from the stored binding `cwd`:
//   - a path inside a Git repository is attributed to that repository, using the
//     verified git COMMON DIR so every subdirectory and every linked worktree of
//     the same repository groups together;
//   - a path outside Git (or an unavailable git binary) is attributed to its
//     canonical directory path.
// Nothing here reads a Git remote, opens the network, or inspects another
// machine. When a path no longer exists the record stays attributed to the
// stored cwd with an explicit limitation: we never claim a saved Codex project
// identity that was not observed. The projected paths are LOCAL/PRIVATE; the
// public share allowlist in ./share.mjs is a separate boundary and none of these
// fields are exported.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 1500;
const GIT_MAX_BUFFER = 64 * 1024;

// Git output is authoritative only as an opaque identity string. We never parse
// a remote URL or a branch name, and the identity is a local absolute path.
function gitCommonDir(cwd) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const value = String(stdout).trim();
      if (!value) return resolve(null);
      // `--git-common-dir` is relative to `cwd` for a normal checkout. Resolve it
      // against the stored cwd and canonicalize so two spellings of the same repo
      // (e.g. a symlinked temp root) land on one identity.
      const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
      let real = absolute;
      try { real = fs.realpathSync.native(absolute); } catch { /* keep lexical */ }
      resolve(real);
    });
  });
}

function classifyPath(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown';
  try { return fs.statSync(cwd).isDirectory() ? 'present' : 'unavailable'; }
  catch { return 'unavailable'; }
}

// A stable, human-recognizable display name. It is the basename of the root; the
// id is what actually groups records, so two distinct directories that share a
// basename stay separate (their ids differ) even though their labels match.
function displayName(root) {
  const base = path.basename(root);
  return base || root;
}

/**
 * Create a bounded, cached workspace resolver for one projection reader.
 *
 * `resolve(cwd)` returns `{id,name,kind,root,cwd,limitation}` where `kind` is
 * 'git' when a verified Git repository identity was observed, 'folder' for a
 * present non-Git directory, and 'unknown' when the stored cwd is absent or was
 * never recorded. `limitation` is one of null, 'path_missing', 'cwd_unknown',
 * 'git_unavailable' and documents what could NOT be observed; it is never a
 * substitute for a project identity.
 *
 * Results are cached per absolute cwd so polling never spawns a git command per
 * receipt: one repository probe per distinct cwd per reader lifetime.
 */
export function createWorkspaceResolver() {
  const cache = new Map();
  const pending = new Map();

  const compute = async cwd => {
    const state = classifyPath(cwd);
    if (state === 'unknown') return { id: null, name: null, kind: 'unknown', root: null, cwd: null, limitation: 'cwd_unknown' };
    if (state === 'unavailable') {
      // The directory is gone (or unreadable). Stay attributable to the stored
      // cwd, but never invent a Git identity we cannot verify.
      return { id: `folder:${cwd}`, name: displayName(cwd), kind: 'folder', root: cwd, cwd, limitation: 'path_missing' };
    }
    const common = await gitCommonDir(cwd);
    if (common) return { id: `git:${common}`, name: displayName(path.dirname(common)), kind: 'git', root: path.dirname(common), cwd, limitation: null };
    return { id: `folder:${cwd}`, name: displayName(cwd), kind: 'folder', root: cwd, cwd, limitation: 'git_unavailable' };
  };

  const resolve = async cwd => {
    const key = typeof cwd === 'string' && cwd ? cwd : '';
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);
    const promise = compute(key).then(value => { cache.set(key, value); pending.delete(key); return value; },
      error => { pending.delete(key); throw error; });
    pending.set(key, promise);
    return promise;
  };

  return { resolve, size: () => cache.size };
}
