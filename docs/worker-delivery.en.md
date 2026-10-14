# Worker delivery and finite batches

[中文](worker-delivery.md) | English

Delivery collection and batches are optional. Ordinary work still uses run, continue and
close with explicit per-turn permissions and no extra bookkeeping. The shared contract
makes one worker responsible for authorized investigation, implementation, checks, repair
and closeout; a precise authority, capability or product-decision gap returns preserved
artifacts and a narrow question.

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

## Run a finite batch

Already-defined independent responsibilities can use the packaged [swarm method](../plugins/worker-routing/skills/swarm/SKILL.md).
Fix the outcome, finite list, write ownership and shared resources first. The runner starts
independent CLI processes and collects real handles, terminal states and deliveries. A free
slot can execute the next approved item without waiting for an unrelated slow job. Missing
required items still mean partial.

```sh
node ENTRY batch --config CONFIG --manifest BATCH_FILE --concurrency 2
```

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
persisted to the index for recovery after an identity check, and cleanup stays unconfirmed. Ambiguous submission or unknown cleanup preserves recoverable state;
a missing report does not authorize replaying a write order. Healthy progress stays in
tool-owned waits, with meaningful exceptions or a batch overview reaching the coordinator.

Retain exact-cwd locks. Different directories, worktrees or read mode do not isolate actual
writes, Git common state, adapter HOME/session store/cache, ports or databases. Serialize an
unverified shared HOME within the batch; expand only an authorized, validated arrangement.
Do not copy credentials, widen parent roots or change cwd to bypass locks. Batch limits do
not claim global admission across every separate CWR instance.

## Accept results without repeating discovery

Mechanical collection checks identity, coverage, duplicates, missing records, references
and freshness, not semantic truth. A peer merger can handle complex cross-result reasoning
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
