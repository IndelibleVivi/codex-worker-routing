# Storage inventory and explicit cleanup

[中文](storage-management.md) | English

CWR execution `cleanup` covers connections, observed adapter processes and execution locks.
It does not mean history was deleted. Storage separately inventories disk usage and offers
plans and confirmed application for evidenced CWR-owned session scratch. It calls no model
or adapter and installs no background GC.

## Inspect

Run from the canonical checkout:

```sh
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json --json
```

Or open Storage in [Dispatch](dispatch.en.md). This is a current disk snapshot, independent
of the collaboration period. Scanning happens on opening the view, changing retention or
explicit refresh; it does not run with automatic collaboration polling. Homes list category,
size and entry count, with CWR state shown separately. Missing data, read failures, scan limits
and unsafe entries remain visible notes. An incomplete scan is not an exact total.

- `bytes` is logical size; `allocated_bytes` estimates filesystem allocation. Compression,
  sparse files, hard links and snapshots affect actual reclaimed space. Inventory is not
  evidence that space has been freed.
- Scans read metadata and bounded CWR records needed for ownership/lifecycle decisions.
  They do not read session, log or database payloads, follow symlinks or cross filesystems.
- History, logs/databases, runtime state/config, legacy tmp and caches are visible but
  inspection only. A directory name, file age or `close` alone never authorizes deletion.

A retired profile whose route was removed can be inspected without re-registering it:

```sh
node integrations/acpx/src/cli.mjs storage --config /absolute/private/routes.json \
  --extra-home /absolute/private/retired-worker-home --json
```

`--extra-home` is repeatable and inspection only. The dashboard offers the same transient
path input. It saves no route, expands no cleanup scope and discovers no siblings. The main
home itself and its ancestors, overlaps in either direction with current homes/workspaces/state,
and duplicate/overlapping extra roots are rejected.

## Scratch lifetime

New responsibilities use `stateDir/scratch/COMPACT_SESSION_ID/` with a CWR ownership
manifest. The compact directory preserves full session identity while leaving room for
ordinary local socket tools within platform path limits. `TMPDIR` (also `TEMP`/`TMP` on Windows) remains stable for the whole session,
including continuations. HOME, CODEX_HOME and execution identity remain unchanged.
New bindings save a durable scratch ownership pointer. A missing known managed manifest
blocks continuation rather than silently selecting another directory. Existing v1 managed
scratch created by earlier source keeps its original
`workerHome/tmp/cwr-sessions/SESSION_UUID/` path; pre-manifest legacy bindings retain old tmp.
Neither is moved. The v1 compatibility reader serves existing responsibilities and may be
removed only after their manifests and dependent bindings are reconciled through their lifetime.

Unix sockets have platform path limits. Very long custom `stateDir` paths can still affect
related tools; choose a short local state root rather than hiding its location behind a symlink.

Managed scratch can qualify only when all of these hold:

1. Its manifest matches the current state root, worker home, route, session and exact allowed physical location.
2. The CWR binding is normally closed, with confirmed execution cleanup and no active turn.
3. No session/workspace execution lock protects the target.
4. A complete, safe scan passes and retention has elapsed since the later of closure and
   latest tree activity. The default is seven days. Missing/invalid closure or future dates
   remain uncertain and ineligible.

Original ACP/runtime history, orders, receipts, databases and logs are excluded. Legacy
tmp/cache gets no retroactive manifest and is never promoted to a candidate based on its name.

## Preview, then apply

Copy a candidate's stable `id` from `storage --json` and explicitly select it (at most 64 targets per plan):

```sh
node integrations/acpx/src/cli.mjs storage-plan --config /absolute/private/routes.json \
  --target scratch-0123456789abcdef0123456789abcdef --older-than 7d
# Repeat --target for multiple items. Durations include 7d and 24h;
# all adds no retention-age requirement.
```

A plan writes only private `stateDir/storage` metadata and leaves original targets untouched.
Review its `targets`, sizes, paths and `plan_id`, then confirm that exact saved plan:

```sh
node integrations/acpx/src/cli.mjs storage-apply --config /absolute/private/routes.json \
  --plan PLAN_UUID --confirm PLAN_UUID
```

**Applying permanently deletes the selected managed scratch, without automatic undo.**
The dashboard uses the same backend: inspect the session replay and save needed artifacts to
your workspace, then select candidates, review exact directories and sizes,
then explicitly confirm. Cancelling the preview leaves original files untouched.
Application rechecks configuration, ownership, binding, locks and the tree. Refresh and
replan stale or changed data; do not edit plan JSON to bypass rejection. Partial deletion
has a distinct result and never becomes a full-success or exact-space-reclaimed claim.
Each plan represents one attempt. Repeating confirmation returns its original terminal
receipt without rewriting the result or deleting again. After failure or partial completion,
inspect the outcome before taking a fresh inventory and creating another plan.

Plans and apply receipts stay in the private state root and never rewrite runtime receipts.
An in-progress receipt is saved before deletion, then finalized on ordinary completion. A
killed/crashed process leaves an in-progress receipt and lock requiring reconciliation; it
never automatically clears locks, retries or claims zero deletion. Confirmed deleted sizes
and unconfirmed portions must be interpreted separately.
`cleanup: confirmed` covers observed execution resources, not proof that every escaped
background writer has stopped. This is not an OS sandbox. Deletion requires a bounded check
of the exact directory using available `lsof` on macOS/Linux. Active handles/cwd, failure,
timeout, warnings or unsupported environments block deletion. Windows supports inventory and
preview but has no supported deletion writer probe; apply refuses rather than installing a
tool or bypassing the check. The probe covers currently observable handles, not proof that
an external process cannot write in the future.

## Harness and privacy boundaries

`integrations/acpx/src/storage.mjs` is shared by the CLI and dashboard:

```js
await inventoryStorage(config, options);
await planStorage(config, { targetIds, olderThanMs });
await applyStoragePlan(config, { planId, confirm });
```

Schemas are `cwr.storage.inventory/1`, `cwr.storage.plan/1` and `cwr.storage.apply/1`.
These private local interfaces may contain route/session IDs, paths and file metadata;
they are unsuitable for direct publication. Storage never enters Dispatch snapshot/share
allowlists, and share cards contain no disk detail. Loopback HTTP reads and writes require
the private bearer token. Cleanup POST additionally requires the exact origin, JSON,
bounded input and explicit confirmation. Windows ACL privacy remains operator-owned.

[Back to documentation](README.en.md)
