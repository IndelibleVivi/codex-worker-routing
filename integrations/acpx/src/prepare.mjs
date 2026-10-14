// SPDX-License-Identifier: SUL-1.0
// Mechanical order + manifest preparation.
//
// The coordinator supplies a compact spec: one shared background plus each
// item's difference. This module validates the authoring decisions that are
// cheap to fix BEFORE any launch (explicit permissions, route/workspace
// authorization, session binding, size bounds), then mechanically writes the
// per-item order files and one standard batch manifest. It performs no
// semantic expansion, infers no permission from category or keywords, launches
// nothing, and never imports an adapter. The generated manifest is an ordinary
// `cwr.acp.batch-manifest/1` document: batch admission re-validates everything
// against the live config, so preparation caches no authorization.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault, readJSON, privateDir, loadBinding } from './state.mjs';
import { selectRoute, assertLocalManagedPath } from './config.mjs';

export const SPEC_SCHEMA = 'cwr.acp.order-spec/1';
export const SPEC_RESULT_SCHEMA = 'cwr.acp.order-spec-result/1';
const MANIFEST_SCHEMA = 'cwr.acp.batch-manifest/1';
const MAX_JOBS = 32;
const MAX_CONCURRENCY = 8;
// Bounds cover authoring accidents, not a second contract: each text part stays
// well under the CLI's per-order read limit (128 KiB).
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_ORDER_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESOURCE_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const noUnknown = (obj, allowed) => Object.keys(obj).every(k => allowed.includes(k));
const byteLen = s => Buffer.byteLength(s, 'utf8');

/**
 * Validate and normalize a coordinator-authored order spec. Every decision that
 * changes execution (permissions, verb, route, session, cwd) must be explicit
 * in the spec; the only resolution performed here is filling a run job's route
 * from the config's CURRENT routing.default when the job omits it.
 */
export function parseSpec(raw) {
  if (!isPlain(raw)) throw new Fault('BAD_SPEC', 'spec must be an object.');
  if (!noUnknown(raw, ['schema', 'shared', 'outDir', 'maxConcurrency', 'capabilities', 'jobs']))
    throw new Fault('BAD_SPEC', 'Unknown field in spec.');
  if (raw.schema !== SPEC_SCHEMA) throw new Fault('BAD_SPEC', `schema must be "${SPEC_SCHEMA}".`);
  const shared = raw.shared ?? '';
  if (typeof shared !== 'string' || byteLen(shared) > MAX_TEXT_BYTES)
    throw new Fault('BAD_SPEC', `shared must be a string of at most ${MAX_TEXT_BYTES} bytes.`);
  if (raw.outDir !== undefined && (typeof raw.outDir !== 'string' || !path.isAbsolute(raw.outDir)))
    throw new Fault('BAD_SPEC', 'outDir must be an absolute path.');
  const maxConcurrency = raw.maxConcurrency === undefined ? 2 : raw.maxConcurrency;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY)
    throw new Fault('BAD_SPEC', `maxConcurrency must be 1..${MAX_CONCURRENCY}.`);
  const caps = raw.capabilities ?? {};
  if (!isPlain(caps) || !noUnknown(caps, ['sharedWorkerHome'])) throw new Fault('BAD_SPEC', 'capabilities must only declare sharedWorkerHome.');
  if (caps.sharedWorkerHome !== undefined && !['validated', 'unvalidated'].includes(caps.sharedWorkerHome))
    throw new Fault('BAD_SPEC', 'capabilities.sharedWorkerHome must be validated or unvalidated.');
  if (!Array.isArray(raw.jobs) || raw.jobs.length === 0 || raw.jobs.length > MAX_JOBS)
    throw new Fault('BAD_SPEC', `jobs must be an array of 1..${MAX_JOBS} entries.`);
  const seen = new Set();
  const jobs = raw.jobs.map((j, i) => {
    const where = `jobs[${i}]`;
    if (!isPlain(j)) throw new Fault('BAD_SPEC', `${where} must be an object.`);
    if (!noUnknown(j, ['id', 'verb', 'cwd', 'route', 'session', 'permissions', 'task', 'title', 'category', 'resources', 'deliver', 'sharedHomeValidation']))
      throw new Fault('BAD_SPEC', `Unknown field in ${where}.`);
    if (typeof j.id !== 'string' || !ID_RE.test(j.id)) throw new Fault('BAD_SPEC', `${where}.id must be a short opaque id.`);
    if (seen.has(j.id)) throw new Fault('BAD_SPEC', `Duplicate job id ${j.id}.`);
    seen.add(j.id);
    if (!['run', 'continue'].includes(j.verb)) throw new Fault('BAD_SPEC', `${where}.verb must be run or continue.`);
    // Explicit per item, mirroring the CLI's per-turn rule; category never implies one.
    if (!['read', 'full'].includes(j.permissions))
      throw new Fault('PERMISSIONS_REQUIRED', `${where}.permissions must be read or full, chosen explicitly from the task's existing authority.`);
    if (typeof j.task !== 'string' || !j.task.trim() || byteLen(j.task) > MAX_TEXT_BYTES)
      throw new Fault('BAD_SPEC', `${where}.task must be a non-empty string of at most ${MAX_TEXT_BYTES} bytes.`);
    if (j.cwd !== undefined && (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd)))
      throw new Fault('BAD_SPEC', `${where}.cwd must be absolute.`);
    if (j.verb === 'continue') {
      if (typeof j.session !== 'string' || !UUID_RE.test(j.session)) throw new Fault('BAD_SPEC', `${where}.session must be a session UUID for continue.`);
      if (j.route !== undefined || j.title !== undefined || j.category !== undefined)
        throw new Fault('BAD_SPEC', `${where}: continue may not set route/title/category; they come from the bound session.`);
    } else {
      if (j.session !== undefined) throw new Fault('BAD_SPEC', `${where}: run may not set session; use verb continue.`);
      if (j.route !== undefined && (typeof j.route !== 'string' || !j.route)) throw new Fault('BAD_SPEC', `${where}.route must be a route name.`);
      if (j.title !== undefined && (typeof j.title !== 'string' || !j.title.trim() || [...j.title].length > 160))
        throw new Fault('BAD_SPEC', `${where}.title must be a non-empty string of at most 160 characters.`);
      if (j.category !== undefined && !['investigation', 'implementation', 'review', 'other'].includes(j.category))
        throw new Fault('BAD_SPEC', `${where}.category must be investigation, implementation, review or other.`);
      if (j.cwd === undefined) throw new Fault('BAD_SPEC', `${where}.cwd is required for run.`);
    }
    if (j.resources !== undefined && (!Array.isArray(j.resources) || j.resources.length > 16 || j.resources.some(r => typeof r !== 'string' || !RESOURCE_RE.test(r))))
      throw new Fault('BAD_SPEC', `${where}.resources must be an array of short tokens.`);
    if (j.deliver !== undefined && typeof j.deliver !== 'boolean') throw new Fault('BAD_SPEC', `${where}.deliver must be boolean.`);
    if (j.sharedHomeValidation !== undefined && j.sharedHomeValidation !== 'validated')
      throw new Fault('BAD_SPEC', `${where}.sharedHomeValidation may only be "validated".`);
    return {
      id: j.id, verb: j.verb, route: j.route ?? null, session: j.session ?? null,
      cwd: j.cwd ?? null, permissions: j.permissions, task: j.task,
      title: j.title ?? null, category: j.category ?? null,
      resources: [...(j.resources ?? [])], deliver: j.deliver ?? true,
      sharedHomeValidation: j.sharedHomeValidation,
    };
  });
  return { shared, outDir: raw.outDir ?? null, maxConcurrency, capabilities: raw.capabilities, jobs };
}

// The order file body is a verbatim mechanical join: shared background, a
// separator, then the item's task. Preparation adds no wording of its own.
export function assembleOrder(shared, task) {
  const body = shared.trim() ? `${shared.trim()}\n\n---\n\n${task.trim()}\n` : `${task.trim()}\n`;
  if (byteLen(body) > MAX_ORDER_BYTES) throw new Fault('ORDER_TOO_LARGE', `Assembled order exceeds ${MAX_ORDER_BYTES} bytes.`);
  return body;
}

/**
 * Validate the spec against the CURRENT config (route enabled, workspace
 * membership, permission authorization, executable presence via selectRoute;
 * binding existence/closure for continue), write order files + one manifest,
 * and return their paths. No launch, no adapter import, no state mutation
 * outside the chosen output directory.
 */
export async function runPrepare({ config, spec, out = null, platform = process.platform }) {
  const parsed = parseSpec(spec);
  const outDir = assertLocalManagedPath(path.resolve(out ?? parsed.outDir ?? path.join(config.stateDir, 'prepare', randomUUID())), 'outDir', platform);
  // Orders carry task text: they live in a private directory. A pre-existing
  // file is never silently overwritten.
  await privateDir(outDir, { platform });
  const defaulted = [];
  const manifestJobs = [];
  const orders = [];
  for (const job of parsed.jobs) {
    let routeName = job.route, cwd = job.cwd;
    if (job.verb === 'continue') {
      const binding = await loadBinding(config.stateDir, job.session);
      if (binding.closed === true) throw new Fault('SESSION_CLOSED', `Job ${job.id}: the work order is closed.`);
      routeName = binding.route;
      if (cwd === null) cwd = binding.cwd;
      else {
        // The manifest's cwd must agree with the bound workspace; compare
        // canonical targets so an alias cannot smuggle a mismatch.
        const real = await fs.realpath(cwd).catch(() => null);
        if (real !== binding.cwd) throw new Fault('BAD_SPEC', `Job ${job.id}: cwd does not match the bound session workspace.`);
        cwd = binding.cwd;
      }
      // Fresh authorization check for this turn's explicit permission.
      await selectRoute(config, routeName, cwd, job.permissions);
    } else {
      if (routeName === null) {
        if (!config.routing?.default) throw new Fault('ROUTE_REQUIRED', `Job ${job.id}: no route given and the config has no routing.default.`);
        routeName = config.routing.default;
        defaulted.push(job.id);
      }
      const selection = await selectRoute(config, routeName, cwd, job.permissions);
      cwd = selection.cwd;
    }
    const file = path.join(outDir, `${job.id}.order.md`);
    const body = assembleOrder(parsed.shared, job.task);
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Fault('OUTPUT_EXISTS', `Refusing to overwrite existing file: ${job.id}.order.md. Choose a fresh output directory.`);
      throw e;
    }
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    orders.push({ id: job.id, file });
    const entry = {
      id: job.id, verb: job.verb, cwd, file, permissions: job.permissions,
      resources: job.resources, deliver: job.deliver,
    };
    if (job.verb === 'continue') entry.session = job.session;
    else {
      entry.route = routeName;
      if (job.title !== null) entry.title = job.title;
      if (job.category !== null) entry.category = job.category;
    }
    if (job.sharedHomeValidation !== undefined) entry.sharedHomeValidation = job.sharedHomeValidation;
    manifestJobs.push(entry);
  }
  const manifest = { schema: MANIFEST_SCHEMA, maxConcurrency: parsed.maxConcurrency, jobs: manifestJobs };
  if (parsed.capabilities !== undefined) manifest.capabilities = parsed.capabilities;
  const manifestPath = path.join(outDir, 'batch-manifest.json');
  let mhandle;
  try { mhandle = await fs.open(manifestPath, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Fault('OUTPUT_EXISTS', 'Refusing to overwrite an existing batch-manifest.json. Choose a fresh output directory.');
    throw e;
  }
  try { await mhandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await mhandle.sync(); } finally { await mhandle.close(); }
  return {
    schema: SPEC_RESULT_SCHEMA, manifest_path: manifestPath, out_dir: outDir,
    orders, defaulted_jobs: defaulted,
    note: 'Preparation is mechanical: batch admission re-validates every job against the live config; a default route filled here is re-read there.',
  };
}
