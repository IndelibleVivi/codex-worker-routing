// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Fault extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    throw new Fault('BAD_SESSION_ID', 'Expected the integration session UUID returned by run.');
  return value;
}
export function within(root, candidate) {
  const r = path.relative(root, candidate);
  return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
}
// POSIX mode bits are evidence only where the OS exposes them. Windows reports
// synthesized read/write modes (0666) that never encode ACL privacy, so callers
// must treat privacy as unverified there instead of failing closed on 0666.
export const exposesPosixModes = (platform = process.platform) => platform !== 'win32';
// Node exposes no portable directory-handle fsync on Windows; atomic rename is
// still used, only the parent-directory durability barrier is skipped.
export const exposesDirectoryFsync = (platform = process.platform) => platform !== 'win32';
function owned(st) {
  if (process.getuid && st.uid !== process.getuid())
    throw new Fault('FOREIGN_OWNER', 'Managed files must belong to the current user.');
}
export function assertPrivateMode(st, kind, platform = process.platform) {
  if (!exposesPosixModes(platform)) return;
  if (st.mode & 0o077) throw new Fault('PUBLIC_STATE', kind === 'directory' ? 'Private directories require mode 0700.' : 'Private files require mode 0600.');
}
// Enumerate managed ancestors without repeating a drive or UNC root. Splitting
// the raw absolute path repeats `C:`/`\\server\share`; walking relative to the
// path's own parsed root works for POSIX, drive-letter and UNC forms alike.
export function ancestorPaths(dir, pathImpl = path) {
  if (!pathImpl.isAbsolute(dir)) throw new Fault('RELATIVE_STATE', 'State paths must be absolute.');
  const root = pathImpl.parse(dir).root;
  const segments = pathImpl.relative(root, dir).split(pathImpl.sep).filter(Boolean);
  const ancestors = [];
  let current = root;
  for (const segment of segments) { current = pathImpl.join(current, segment); ancestors.push(current); }
  return { root, ancestors };
}
export async function regular(file, { privateFile = false, maxBytes = 1024 * 1024, platform = process.platform } = {}) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.nlink !== 1) throw new Fault('UNSAFE_FILE', 'Expected a single-link regular file.');
  if (st.size > maxBytes) throw new Fault('INPUT_TOO_LARGE', 'Input exceeds the configured byte limit.');
  if (privateFile) {
    owned(st);
    assertPrivateMode(st, 'file', platform);
  }
  // O_NOFOLLOW/O_NONBLOCK are POSIX flags. Where the platform does not expose
  // them the open-then-stat identity comparison below is the no-follow check.
  const flags = constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const h = await fs.open(file, flags);
  try {
    const now = await h.stat();
    if (!now.isFile() || now.nlink !== 1 || now.ino !== st.ino || now.dev !== st.dev)
      throw new Fault('FILE_CHANGED', 'Input changed while opening.');
    // Bound the actual read too: the file may grow after stat().
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const r = await h.read(buf, n, buf.length - n, null);
      if (!r.bytesRead) break;
      n += r.bytesRead;
    }
    if (n > maxBytes) throw new Fault('INPUT_TOO_LARGE', 'Input exceeds the configured byte limit.');
    return buf.subarray(0, n).toString('utf8');
  } finally { await h.close(); }
}
export async function readJSON(file, options = {}) {
  try { return JSON.parse(await regular(file, options)); }
  catch (e) { if (e instanceof SyntaxError) throw new Fault('BAD_JSON', 'Invalid JSON file.'); throw e; }
}

// Parent-first validation rejects links/special files before mkdir. On macOS,
// callers canonicalize existing ancestors (/var -> /private/var) first.
export async function privateDir(dir, { create = true, platform = process.platform } = {}) {
  const { ancestors } = ancestorPaths(dir);
  let missing = false;
  for (let i = 0; i < ancestors.length; i++) {
    const current = ancestors[i];
    let st;
    try { st = await fs.lstat(current); }
    catch (e) { if (e.code !== 'ENOENT') throw e; missing = true; }
    if (st) {
      if (!st.isDirectory()) throw new Fault('UNSAFE_DIRECTORY', 'State ancestry contains a link or non-directory.');
      if (i === ancestors.length - 1) {
        owned(st);
        assertPrivateMode(st, 'directory', platform);
      }
    } else if (!create) throw new Fault('STATE_MISSING', 'The state directory does not exist.');
  }
  if (missing) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory()) throw new Fault('UNSAFE_DIRECTORY', 'Unsafe state directory.');
  owned(st);
  assertPrivateMode(st, 'directory', platform);
}
export async function syncDirectory(dir, platform = process.platform) {
  if (!exposesDirectoryFsync(platform)) return;
  const dh = await fs.open(dir, 'r');
  try { await dh.sync(); } finally { await dh.close(); }
}
export async function atomicJSON(file, value, { platform = process.platform } = {}) {
  await privateDir(path.dirname(file), { platform });
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.nlink !== 1) throw new Fault('UNSAFE_FILE', 'Refusing to replace an unsafe state file.');
    owned(st);
    assertPrivateMode(st, 'file', platform);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await fs.open(temp, 'wx', 0o600);
  try {
    await h.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await h.sync();
  } finally { await h.close(); }
  try {
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file), platform);
  } finally { await fs.rm(temp, { force: true }); }
}
export async function lock(dir, owner) {
  await privateDir(path.dirname(dir));
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Fault('BUSY_OR_UNRECONCILED', 'Another operation owns this lock, or an earlier exit needs reconciliation. Never auto-delete it.');
    throw e;
  }
  try { await atomicJSON(path.join(dir, 'owner.json'), owner); }
  catch (e) { await fs.rmdir(dir).catch(() => {}); throw e; }
  return async () => {
    const saved = await readJSON(path.join(dir, 'owner.json'), { privateFile: true });
    if (saved.nonce !== owner.nonce) throw new Fault('LOCK_CHANGED', 'Lock ownership changed.');
    await fs.unlink(path.join(dir, 'owner.json'));
    await fs.rmdir(dir); // Fail if unexpected contents appeared; never recursive-delete.
  };
}
export function paths(stateDir, id) {
  sessionId(id);
  const dir = path.join(stateDir, 'bindings', id);
  return { dir, binding: path.join(dir, 'binding.json'), lock: path.join(dir, 'active.lock'), receipts: path.join(dir, 'receipts') };
}
export async function loadBinding(stateDir, id) {
  const p = paths(stateDir, id);
  await privateDir(p.dir, { create: false });
  const b = await readJSON(p.binding, { privateFile: true });
  if (b.schema !== 'cwr.acp.binding/1' || b.id !== id || typeof b.cwd !== 'string')
    throw new Fault('BAD_BINDING', 'Invalid integration binding.');
  return b;
}
