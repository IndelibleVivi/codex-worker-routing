// SPDX-License-Identifier: SUL-1.0
// Shared, mechanical validation for finite predecessor declarations.
//
// This module owns only dependency shape and graph validation. It launches
// nothing, reads no reports and has no authority to admit a successor; batch
// admission remains the execution owner.
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_DEPENDENCIES = 16;
export const MAX_INPUT_ARTIFACTS = 8;
const MAX_ARTIFACT_REF = 2000;

const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const noUnknown = (obj, allowed) => Object.keys(obj).every(key => allowed.includes(key));

/**
 * Validate and normalize optional `depends_on` + `inputs` fields for one job.
 * Every predecessor must have exactly one explicit input binding; a bare
 * `depends_on` edge can never make a report available to its successor.
 */
export function normalizeJobDependencies(raw, jobId, where, FaultClass) {
  const fail = message => { throw new FaultClass('BAD_DEPENDENCIES', message); };
  const depends = raw.depends_on;
  const inputs = raw.inputs;
  if (depends === undefined && inputs === undefined) return { depends_on: [], inputs: [] };
  if (!Array.isArray(depends) || depends.length > MAX_DEPENDENCIES)
    fail(`${where}.depends_on must be an array of at most ${MAX_DEPENDENCIES} job ids.`);
  if (!Array.isArray(inputs) || inputs.length > MAX_DEPENDENCIES)
    fail(`${where}.inputs must be an array of at most ${MAX_DEPENDENCIES} entries.`);
  const dependencyIds = [];
  const seenDependencies = new Set();
  for (const id of depends) {
    if (typeof id !== 'string' || !ID_RE.test(id)) fail(`${where}.depends_on must contain short job ids.`);
    if (id === jobId) fail(`${where}.depends_on cannot reference the job itself.`);
    if (seenDependencies.has(id)) fail(`${where}.depends_on contains duplicate job id ${id}.`);
    seenDependencies.add(id);
    dependencyIds.push(id);
  }
  const normalizedInputs = [];
  const seenInputs = new Set();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i], inputWhere = `${where}.inputs[${i}]`;
    if (!isPlain(input) || !noUnknown(input, ['job', 'report', 'artifacts']))
      fail(`${inputWhere} must contain only job, report and artifacts.`);
    if (typeof input.job !== 'string' || !ID_RE.test(input.job)) fail(`${inputWhere}.job must be a short job id.`);
    if (seenInputs.has(input.job)) fail(`${inputWhere}.job duplicates predecessor ${input.job}.`);
    seenInputs.add(input.job);
    if (input.report !== undefined && typeof input.report !== 'boolean') fail(`${inputWhere}.report must be boolean.`);
    const artifacts = input.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > MAX_INPUT_ARTIFACTS)
      fail(`${inputWhere}.artifacts must be an array of at most ${MAX_INPUT_ARTIFACTS} references.`);
    const normalizedArtifacts = [];
    const seenArtifacts = new Set();
    for (const ref of artifacts) {
      if (typeof ref !== 'string' || !ref.trim() || ref.length > MAX_ARTIFACT_REF)
        fail(`${inputWhere}.artifacts must contain non-empty strings of at most ${MAX_ARTIFACT_REF} characters.`);
      if (seenArtifacts.has(ref)) fail(`${inputWhere}.artifacts contains a duplicate reference.`);
      seenArtifacts.add(ref);
      normalizedArtifacts.push(ref);
    }
    if (input.report !== true && normalizedArtifacts.length === 0)
      fail(`${inputWhere} must select report:true and/or at least one artifact reference.`);
    if (!seenDependencies.has(input.job))
      fail(`${inputWhere}.job must also appear in depends_on; inputs cannot create implicit edges.`);
    normalizedInputs.push({ job: input.job, report: input.report === true, artifacts: normalizedArtifacts });
  }
  for (const id of dependencyIds)
    if (!seenInputs.has(id)) fail(`${where} declares predecessor ${id} without an explicit input binding.`);
  return { depends_on: dependencyIds, inputs: normalizedInputs };
}

/**
 * Validate references and cycles across an already id-checked finite job list.
 * A topological pass also proves that every predecessor is in this manifest;
 * paths into other batches, private state or coordinator-owned records are not
 * edges.
 */
export function validateDependencyGraph(jobs, FaultClass) {
  const fail = message => { throw new FaultClass('BAD_DEPENDENCIES', message); };
  const byId = new Map(jobs.map(job => [job.id, job]));
  for (const job of jobs)
    for (const id of job.depends_on ?? [])
      if (!byId.has(id)) fail(`Job ${job.id} references unknown predecessor ${id}.`);
  for (const job of jobs) {
    const predecessors = (job.depends_on ?? []).map(id => byId.get(id));
    if (predecessors.some(predecessor => predecessor.deliver === false))
      fail(`Job ${job.id} cannot depend on a deliver:false predecessor; successors require validated report content.`);
  }
  // Same-session continuations use the existing canonical cwd/operation locks.
  // An explicit edge orders their turns; the per-request sidecars preserve the
  // predecessor report after the session continues. No extra graph ban is needed.
  const visiting = new Set(), visited = new Set();
  const visit = job => {
    if (visited.has(job.id)) return;
    if (visiting.has(job.id)) fail(`Dependency cycle includes job ${job.id}.`);
    visiting.add(job.id);
    for (const id of job.depends_on ?? []) visit(byId.get(id));
    visiting.delete(job.id);
    visited.add(job.id);
  };
  for (const job of jobs) visit(job);
  return jobs;
}
