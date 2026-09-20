// SPDX-License-Identifier: SUL-1.0
// Local workspace identity tests. Everything is created under a synthetic temp
// root: no operator config, no real repository, no network, no git remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceResolver } from '../src/workspaces.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

async function tempRoot(t) {
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'cwr-ws-')));
  await fsp.chmod(root, 0o700);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRepo(root, name) {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { mode: 0o700 });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'synthetic@example.invalid']);
  git(repo, ['config', 'user.name', 'Synthetic']);
  await fsp.writeFile(path.join(repo, 'a.txt'), 'synthetic\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-qm', 'synthetic']);
  return repo;
}

test('subdirectories and linked worktrees group under one repository identity', async t => {
  const root = await tempRoot(t);
  const repo = await makeRepo(root, 'repo');
  const worktree = path.join(root, 'worktree');
  git(repo, ['worktree', 'add', '-q', worktree, '-b', 'feat']);
  const sub = path.join(repo, 'sub', 'deep');
  await fsp.mkdir(sub, { recursive: true, mode: 0o700 });

  const resolver = createWorkspaceResolver();
  const main = await resolver.resolve(repo);
  const linked = await resolver.resolve(worktree);
  const nested = await resolver.resolve(sub);
  assert.equal(main.kind, 'git');
  assert.equal(main.name, 'repo');
  assert.equal(main.limitation, null);
  // Same REPOSITORY, three different cwds.
  assert.equal(linked.id, main.id);
  assert.equal(nested.id, main.id);
  assert.equal(linked.cwd, worktree);
  assert.equal(nested.cwd, sub);
  assert.equal(linked.root, main.root);
});

test('two distinct directories that share a basename never group together', async t => {
  const root = await tempRoot(t);
  const a = path.join(root, 'a', 'project');
  const b = path.join(root, 'b', 'project');
  await fsp.mkdir(a, { recursive: true, mode: 0o700 });
  await fsp.mkdir(b, { recursive: true, mode: 0o700 });
  const resolver = createWorkspaceResolver();
  const one = await resolver.resolve(a);
  const two = await resolver.resolve(b);
  assert.equal(one.name, 'project');
  assert.equal(two.name, 'project');
  assert.notEqual(one.id, two.id); // the id is what groups, not the label
  assert.equal(one.kind, 'folder');
});

test('a non-git folder is attributed to its canonical cwd', async t => {
  const root = await tempRoot(t);
  const folder = path.join(root, 'plain');
  await fsp.mkdir(folder, { mode: 0o700 });
  const resolver = createWorkspaceResolver();
  const resolved = await resolver.resolve(folder);
  assert.equal(resolved.kind, 'folder');
  assert.equal(resolved.id, `folder:${folder}`);
  assert.equal(resolved.root, folder);
  assert.equal(resolved.limitation, 'git_unavailable');
});

test('a deleted or unavailable path stays attributable with an explicit limitation', async t => {
  const root = await tempRoot(t);
  const gone = path.join(root, 'vanished');
  await fsp.mkdir(gone, { mode: 0o700 });
  const resolver = createWorkspaceResolver();
  await fsp.rm(gone, { recursive: true, force: true });
  const resolved = await resolver.resolve(gone);
  assert.equal(resolved.kind, 'folder');
  assert.equal(resolved.limitation, 'path_missing');
  assert.equal(resolved.cwd, gone);
  // A missing path is never silently promoted to a Git project identity.
  assert.ok(!String(resolved.id).startsWith('git:'));
});

test('a binding with no recorded cwd is unknown, never a false project identity', async () => {
  const resolver = createWorkspaceResolver();
  const resolved = await resolver.resolve(null);
  assert.deepEqual(resolved, { id: null, name: null, kind: 'unknown', root: null, cwd: null, limitation: 'cwd_unknown' });
});

test('the resolver caches per cwd so polling does not respawn git per receipt', async t => {
  const root = await tempRoot(t);
  const repo = await makeRepo(root, 'repo');
  const resolver = createWorkspaceResolver();
  const first = await resolver.resolve(repo);
  const second = await resolver.resolve(repo);
  assert.equal(first, second); // identity (same cached object) — one probe only
  assert.equal(resolver.size(), 1);
  // Concurrent callers share one in-flight probe rather than racing.
  const parallel = createWorkspaceResolver();
  const [x, y] = await Promise.all([parallel.resolve(repo), parallel.resolve(repo)]);
  assert.equal(x, y);
});
