// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './state.mjs';

const exec = promisify(execFile);
const MAX_PROCESS_TABLE_BYTES = 8 * 1024 * 1024;

function processIdentity(pid, parentPid, processGroup, start) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof start !== 'string' || !start)
    throw Object.assign(new Error('Process identity is incomplete.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  return Object.freeze({
    schema: 'cwr.acp.process-identity/1',
    pid,
    parent_pid: Number.isSafeInteger(parentPid) && parentPid >= 0 ? parentPid : null,
    process_group: Number.isSafeInteger(processGroup) && processGroup > 0 ? processGroup : null,
    start,
  });
}

async function linuxBootId() {
  const value = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(value))
    throw Object.assign(new Error('Linux boot identity is malformed.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  return `linux:${value}`;
}

async function linuxSnapshot() {
  const names = await fs.readdir('/proc');
  const rows = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 1)
        throw Object.assign(new Error('Linux process identity is malformed.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
      const rest = stat.slice(close + 2).trim().split(/\s+/);
      // Fields after comm begin at field 3 (state). starttime is field 22.
      const ppid = Number(rest[1]);
      const pgrp = Number(rest[2]);
      const start = rest[19];
      rows.push(processIdentity(Number(name), ppid, pgrp, start));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (['EACCES', 'EPERM'].includes(error.code))
        throw Object.assign(new Error('Linux process inspection is denied.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
      throw error;
    }
  }
  return rows;
}

async function darwinBootId() {
    const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
    timeout: 5000, maxBuffer: 16 * 1024,
  });
  const match = /\{ sec = (\d+), usec = (\d+) \}/.exec(stdout);
  if (!match)
    throw Object.assign(new Error('macOS boot identity is unavailable.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  return `darwin:${match[1]}.${match[2]}`;
}

async function stableHostId(platform) {
  let raw;
  try {
    if (platform === 'linux') raw = (await fs.readFile('/etc/machine-id', 'utf8')).trim();
    else if (platform === 'darwin') {
      const { stdout } = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        timeout: 5000, maxBuffer: 256 * 1024,
      });
      raw = (/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout) ?? [])[1];
    }
  } catch { raw = null; }
  return typeof raw === 'string' && raw.length >= 8 && raw.length <= 512
    ? digest({ host: raw }) : null;
}

function parseDarwinRows(stdout) {
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // Only process metadata is needed; never read other processes' commands.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s*$/.exec(line);
    if (!match)
      throw Object.assign(new Error('macOS process identity is malformed.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
    rows.push(processIdentity(Number(match[1]), Number(match[2]), Number(match[3]),
      match[4].replace(/\s+/g, ' ')));
  }
  return rows;
}

async function darwinSnapshot() {
  try {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
      timeout: 5000, maxBuffer: MAX_PROCESS_TABLE_BYTES,
    });
    return parseDarwinRows(stdout);
  } catch (error) {
    throw Object.assign(new Error('macOS process inspection is denied or unavailable.'), {
      code: 'PROCESS_IDENTITY_UNAVAILABLE', cause: error,
    });
  }
}

/**
 * Host process snapshots are recovery evidence, never an authorization source.
 * Unsupported platforms fail closed explicitly. Tests may inject a complete
 * snapshot function through the canonical backend; production never accepts an
 * environment-selected inspector.
 */
export function createProcessEvidence({ platform = process.platform, snapshot, bootId, hostId } = {}) {
  const readSnapshot = snapshot ?? (platform === 'linux' ? linuxSnapshot : platform === 'darwin' ? darwinSnapshot : null);
  const readBootId = bootId ?? (platform === 'linux' ? linuxBootId : platform === 'darwin' ? darwinBootId : null);
  const readHostId = hostId ?? (() => stableHostId(platform));
  let cachedBoot, cachedHost;
  return Object.freeze({
    platform,
    async boot() {
      if (!readBootId)
        throw Object.assign(new Error(`Process identity is unsupported on ${platform}.`), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
      cachedBoot ??= await readBootId();
      return cachedBoot;
    },
    async snapshot() {
      if (!readSnapshot)
        throw Object.assign(new Error(`Process inspection is unsupported on ${platform}.`), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
      return readSnapshot();
    },
    async host() {
      if (!readHostId || !['darwin', 'linux'].includes(platform)) return null;
      cachedHost ??= await readHostId();
      return cachedHost;
    },
    async identity(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw Object.assign(new Error('Expected a positive process id.'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
      const rows = await readSnapshot?.() ?? [];
      const row = rows.find(item => item.pid === pid);
      return row ? structuredClone(row) : null;
    },
    identityFromRows(pid, rows) {
      if (!Array.isArray(rows)) return null;
      const row = rows.find(item => item.pid === pid);
      return row ? structuredClone(row) : null;
    },
  });
}

export const defaultProcessEvidence = createProcessEvidence();

export function descendantsOf(root, rows) {
  const children = new Map();
  for (const row of rows ?? []) {
    if (!Number.isSafeInteger(row.parent_pid)) continue;
    const list = children.get(row.parent_pid) ?? [];
    list.push(row);
    children.set(row.parent_pid, list);
  }
  const out = [];
  const queue = [root.pid];
  const seen = new Set([root.pid]);
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export function identityKey(identity) {
  if (!identity || identity.schema !== 'cwr.acp.process-identity/1' ||
      !Number.isSafeInteger(identity.pid) || typeof identity.start !== 'string')
    return null;
  return `${identity.pid}:${identity.start}`;
}

