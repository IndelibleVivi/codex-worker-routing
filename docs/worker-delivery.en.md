# Worker delivery and finite batches

[中文](worker-delivery.md) | English

Delivery collection and batches are optional. Ordinary work still uses run, continue and
close with explicit per-turn permissions and no extra bookkeeping. The shared contract
makes one worker responsible for authorized investigation, implementation, checks, repair
and closeout; a precise authority, capability or product-decision gap returns preserved
artifacts and a narrow question.
See the [architecture overview](architecture.en.md) for where delivery, batches and recovery sit.

## Complete one responsibility

Every actual ACP order contains the packaged [worker contract](../plugins/worker-routing/skills/worker-routing/references/worker-contract.md).
Native handoffs use the same semantics. [Worker routing](../plugins/worker-routing/skills/worker-routing/SKILL.md)
owns responsibility and acceptance; [ACP quick operations](../plugins/worker-routing/skills/acp-worker/SKILL.md)
owns the call. Dispatch, identity recovery and batch methods load at their actual trigger,
without reading statistics schemas on the ordinary path.

An ordinary check failure feeds the worker's diagnosis and repair rather than automatically
ending its responsibility. Preserve supported results and still-valid evidence; stop when
stated conditions are met, without a fixed reflection turn. Coordinator-requested reworks
and internal test iterations are different. After a critical decision or constrained
operation, the coordinator can hand remaining execution back to the original session:
stop overlapping writers, identify the fixed part and reread affected state.

## Optional delivery collection

Add --deliver for a complex investigation or result batch. The body remains a small
engineering order. The coordinator-side collector saves reports so read workers need
no full permission just to write JSON.

```sh
node ENTRY run --config CONFIG --cwd WORKSPACE --file ORDER --permissions read --deliver
node ENTRY continue --config CONFIG --session UUID --file INCREMENT --permissions full --deliver
node ENTRY delivery --config CONFIG --session UUID --json
```

Workers follow the bounded cwr-delivery JSON-block convention supplied by the order.
A delivery declares ready, partial or needs_input, with a brief conclusion, satisfied
conditions, necessary support, expandable artifacts, actual checks and precise questions.
The entrypoint supplies the detailed format; users need not write a reporting form.

Ready is a candidate declaration. Runtime completion, report completeness, check results
and coordinator acceptance remain distinct. Missing, malformed, oversized or mismatched
reports stay visible without rewriting runtime receipts or automatically replaying edits.
Structured collection is separate from the bounded text excerpt.

Each result binds to the actual session/request. Late old results cannot replace newer
delivery, and duplicates do not create work. Worker-declared checks retain worker_reported
provenance; only a trusted execution path can create runner_observed facts. Relevant source,
test or dependency changes invalidate affected evidence; HEAD alone cannot identify dirty
content. Locatable references do not prove their support, and reports never authorize
execution of shell strings they contain.

Without `--request`, `delivery --session UUID` reads the newest valid stored delivery by
`finished_at`, then `request_id`. Use `--request REQUEST_ID` to read one turn: a named
missing sidecar is reported as absent (`delivery: null` in JSON), while a named corrupt
sidecar is rejected. A scan skips invalid records and reports their count alongside a
valid result; if only invalid records remain, the scan is rejected. An older report is never evidence for a different request.

New blocks retain the validated request/session IDs. If either inner ID is present, both
must be bounded UUIDs matching the outer sidecar; a block with neither ID is accepted only
for the legacy stored shape. That shape cannot authenticate provenance or distinguish a
genuine old record from one later stripped of both IDs.

## Run a finite batch

Already-defined independent responsibilities can use the packaged [swarm method](../plugins/worker-routing/skills/swarm/SKILL.md).
Fix the outcome, finite list, write ownership and shared resources first. The runner starts
independent CLI processes and collects real handles, terminal states and deliveries. A free
slot can execute the next approved item without waiting for an unrelated slow job. Missing
required items still mean partial.

```sh
node ENTRY batch --config CONFIG --manifest BATCH_FILE --concurrency 2
node ENTRY batch --config CONFIG --manifest BATCH_FILE --start-handle HANDLE --compact
```

Passing `--start-handle FILE` makes the runner write this batch's machine handle
(`batch_id` and index location) after the initial index exists and before any child
launches; a failed handle write aborts the batch before launch. The coordinator can then
address that batch directly instead of scanning the private state directory for a batch id.
The handle is an identity pointer, not a progress signal: there is still no per-item
wakeup. `--compact` turns the terminal stdout into a bounded paged response; the default
full terminal receipt is unaffected.

The coordinator generates a cwr.acp.batch-manifest/1 manifest. Each item has a stable id,
run or continue verb, order location, explicit permissions, relevant cwd/session and shared
resources. It indexes existing handles/receipts rather than creating another task database.
This minimal manifest is synthetic; the coordinator derives actual routes and absolute paths from authorized configuration.

```json
{
  "schema": "cwr.acp.batch-manifest/1",
  "maxConcurrency": 2,
  "jobs": [
    {"id": "a", "verb": "run", "route": "worker", "cwd": "/workspace/a",
     "file": "/orders/a.md", "permissions": "read", "resources": []},
    {"id": "b", "verb": "run", "route": "worker", "cwd": "/workspace/b",
     "file": "/orders/b.md", "permissions": "read", "resources": []}
  ]
}
```

Run jobs name an explicit route; continue jobs retain their session and matching cwd, with no new route.
Each job collects delivery by default; use deliver:false only when runtime facts are explicitly sufficient.
Shared-HOME concurrency requires both capabilities.sharedWorkerHome="validated" on the manifest and
sharedHomeValidation="validated" on every relevant job, supported by actual adapter acceptance.
Otherwise serialize conservatively. Complete means result coverage, not engineering acceptance.

A start handle records locks_held; adapter initialization and prompt acknowledgement may still be pending.
The runner verifies actual child selection against its resource plan and rejects changed configuration
before launch. Parent cancellation uses the same nonce-bound control writer as ordinary cancel.
Cancellation or an index publication failure is a batch-level admission stop: the scheduler
re-confirms admission after every asynchronous admission step and before the actual launch, so a
cancelled batch starts nothing new. A config reload or launch failure after the batch started does
not swallow batch settlement: admission closes, collected results are kept, and the batch reports a
partial carrying `admission_error`; unlaunched jobs land in missing without fabricated handles or receipts.

Child stdout and stderr keep independent bounded retention budgets: diagnostics that exhaust their
own budget truncate stderr only (visible as `stderr_truncated`) and cannot starve the machine
receipt; once stdout itself is truncated, the retained prefix is refused as a receipt even when it
happens to parse as valid JSON, and the job lands in missing.

When a parent stops, launch no new items and request cancellation from its owned CLI processes,
then wait boundedly for cleanup. Unsettled operations remain unconfirmed. At the end of the bounded
wait, children without a captured handle get one final real read: a late-published handle is
retained in the index as an observed recovery clue. Only a handle matching the job identity
enters the trusted result start_handle; cleanup stays unconfirmed. A mismatched handle must
not be used as an authorized control target. Ambiguous submission or unknown cleanup preserves recoverable state;
a missing report does not authorize replaying a write order. Healthy progress stays in
tool-owned waits, with meaningful exceptions or a batch overview reaching the coordinator.

Retain exact-cwd locks. Different directories, worktrees or read mode do not isolate actual
writes, Git common state, adapter HOME/session store/cache, ports or databases. Serialize an
unverified shared HOME within the batch; expand only an authorized, validated arrangement.
Do not copy credentials, widen parent roots or change cwd to bypass locks. Batch limits do
not claim global admission across every separate CWR instance.

## Order preparation and incremental reads

The coordinator authors ONE order spec: shared background plus each item's task, explicit
permissions and exact scope. `prepare` mechanically assembles the per-item order files and
one standard manifest. Before anything launches it validates the explicit permissions, the
current route/workspace authorization and any continued session binding; a run job that
omits its route is filled from the config's CURRENT `routing.default` and marked in the
result's `defaulted_jobs`; existing outputs are never overwritten. It launches no worker and
loads no adapter, and batch admission re-validates every generated job — preparation caches
no authorization and infers no permission from category or keywords.

Order files and the manifest use exclusive creation, with mode `0600` on POSIX.
Windows Node modes do not encode ACL privacy; CWR does not claim verified owner-only
access from that metadata. The operator must independently check the output directory's ACL.

```sh
node ENTRY prepare --config CONFIG --spec SPEC [--out DIR]
node ENTRY collect --config CONFIG --batch BATCH_ID
node ENTRY collect --config CONFIG --batch BATCH_ID --compact [--limit N] [--max-bytes N] [--cursor TOKEN]
node ENTRY collect --config CONFIG --batch BATCH_ID --job JOB_ID
```

This minimal spec is synthetic; actual content is authored from the real goal, and the
mechanical step never invents scope, permissions or acceptance criteria.

```json
{
  "schema": "cwr.acp.order-spec/1",
  "shared": "Shared background every item needs.",
  "jobs": [
    {"id": "a", "verb": "run", "cwd": "/workspace/a", "permissions": "read",
     "task": "Map the importer call chain."}
  ]
}
```

Every result is published into the batch's durable index as it settles. `collect` is a
read-only view of that index — without waiting, without loading an adapter, and with no
per-item wakeup: the coordinator reads it between its host's own waits. A corrupted or
unknown index is an explicit error, never a fabricated pass. Plain `collect` returns the
full stored records (the compatibility view) and is not subject to the compact budget;
routine coordination uses `--compact` instead.

`--compact` returns a bounded paged response: the WHOLE response (metadata, cursor, items
and the trailing newline) is held under a UTF-8 byte budget, default 32 KiB, minimum 8 KiB,
maximum 256 KiB, with an item limit default 8 and maximum 32. It reports the batch status,
total, captured handles, settled count, outstanding count, a `page` summary (`has_more`,
`limited_by`), an `unresolved` classification (recorded-handle unsettled items, `awaiting_handle`, and truly
missing kept separate), a `next_cursor` and per-item records. When a rich item cannot fit,
only optional detail is reduced and named in `omitted_fields`; even minimal detail retains
provenance and criterion/check counts. When results remain, a successful page includes at
least one locatable item or returns an explicit insufficient-budget error. The full
questions, artifacts and checks never enter the compact page: `collect --job JOB_ID` expands
one settled result in full from the index, and `delivery --session UUID --request
REQUEST_ID` expands the per-request sidecar.

The cursor is an opaque token naming this batch, revision and offset; it is validated strictly
for shape, canonical encoding, batch, range and revision, and it is not an authenticity tag.
`awaiting_handle` can mean pending admission or startup, not absence of a child; a recorded
handle proves locks held, not prompt acknowledgement. Nothing changed since the cursor re-sends no results; new appends are read incrementally. A
same-id update (late settlement or reconciliation) is replayed from the earliest changed item
onward, which may repeat unchanged successors, so the coordinator merges by id and each
item’s `rev` (response `revision` for legacy `rev:null`), rather than treating the cursor as a strict event
delta or a zero-duplication guarantee. Each settled record carries two coordination aids:

`--job` is an unbounded full expansion and cannot be combined with `--compact`, `--cursor`, `--limit`, or `--max-bytes`; conflicting views fail before reading the index.

- `delivery_excerpt`: a bounded verbatim projection of the worker-reported delivery
  (`source:"worker_reported"`) — the summary with its truncation marker, criterion totals
  with the unsatisfied list, check totals with failing names, a severity-ordered handful of
  `name/state/detail` short evidence, the first few questions, and explicit omission counts.
  The program adds no semantic judgment; `worker_reported` is never a verified fact, and
  worker declarations stay separate from runner-observed facts.
- `next_actions`: runner-generated hints based on trusted runtime/handle facts and attributed
  worker-reported delivery status. answer_questions uses the reported needs_input and
  questions; it does not independently verify the blocker. Hints use a fixed
  vocabulary: `reconcile_session`, `inspect_receipt`, `consolidate_report`,
  `answer_questions`. A continue-class hint appears only for a known session whose runtime
  is terminal with confirmed cleanup and a matching handle. Candidates are hints for the
  coordinator to judge — never commands, never auto-executed.

## Accept results without repeating discovery

Mechanical collection checks identity, coverage, duplicates, missing records and reference
locatability. Batch/collect do not automatically establish check freshness; compare
runner-observed records separately against a task-confirmed candidate identity. Semantic
judgment retains its owner. A peer merger can handle complex cross-result reasoning
from collected reports and necessary evidence. It retains version distinctions, exclusions,
counterevidence and unresolved conflicts, returning only decision-relevant narrow questions
to their original owners rather than rereading every source.

The coordinator examines key conclusions, coverage, conflicts and integration boundaries,
then expands or delegates concrete doubts. Parallel edits need validation of the combined
final state; individual green checks do not accept the combination. Unknown access is not
unsupported behavior, and open research need not produce a fixed recommendation count.

## Scoped checks and feedback

Reuse project checks before adding a real gap. Return deterministic failures with a minimal
counterexample; distinguish missing environment, nonexecution, skip, stale evidence and a
contested criterion. Keep legitimate-success and prohibited-behavior controls; a narrow bad
implementation may test a consequential gate's discrimination.

Check argv, cwd, budget and log limits come from task-confirmed coordinator input. Never
execute arbitrary reported commands or move candidate code into the main agent's more
privileged HOME/credential/network/write environment. Missing capability is blocked;
permission-response policy is not an OS sandbox.

The acceptance helper requires an explicit task HOME/environment; absence is blocked. The caller must
confirm criterion applicability and coverage before setting criterionApplicable:true. By default it
records process outcomes without accepting zero exit, zero checks or skips. Artifact checks establish
locatability within authorized roots; size/mtime comparisons cannot prove dirty-content freshness.
On Windows the helper cannot prove whole-tree cleanup after a forced timeout and marks it unconfirmed.
This does not change the original ACP runtime's own three-platform cleanup validation.

Normal self-repair stays in the agent's inner feedback loop. Outer feedback is only a bounded
experiment: a concrete applicable failed check, a stopped session with confirmed cleanup,
precise same-session feedback, at most two outer corrections and a fixed responsibility
deadline. Success and report-only failure get no reflection turn; ambiguous execution,
revocation, cancellation and unchanged repeated failure get no blind retry. Promote extra
mechanisms only if a bounded comparison establishes useful benefit.

Keep durable behavioral regressions in existing tests. Task probes, reports and run logs live
outside Git. Clean only confirmed owned objects under actual authorization; preserve active
writers, unknown cleanup, user dirty files and unique failure evidence. Before removing a
referenced artifact, retain the useful minimal reproducer or label its evidence expired.

An ACP prompt turn can contain multiple model/tool-feedback cycles, enabling normal repair
inside the executor. end_turn ends that tool-request cycle; it does not accept the engineering
result. [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
