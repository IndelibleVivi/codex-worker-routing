# Finite batch execution and results

Read when a task actually contains independent approved responsibilities. The integration's
installed CLI/help and canonical operator guide own exact arguments and supported interfaces;
this method describes the coordination guarantees they must preserve.

## Order preparation

Author ONE order spec: shared background plus each item's task, explicit per-item
permissions and exact scope. The prepare verb mechanically assembles per-item order files
and a standard manifest from it. It validates permissions, current route/workspace
authorization and any continued session binding before anything launches, fills an omitted
run route from the config's CURRENT default (recorded per item), and refuses to overwrite
existing outputs. It launches nothing and loads no adapter; batch admission re-validates
every generated job, so preparation never widens authority. Write the spec from the actual
goal; never let the mechanical step invent scope, permissions or acceptance criteria.

## Admission and resource ownership

Use independent CLI subprocesses for ACP jobs. The CLI scrubs its process environment, so
concurrent calls to its main function in one Node process are unsafe. Use trusted structured
start handles/control output to retain actual session IDs; do not parse human stderr strings.
Pass `--start-handle FILE` to `batch` so the runner writes a machine-readable batch handle
(`batch_id` and index location) right after the initial index exists and before any child
launches; the coordinator then addresses that batch directly instead of scanning the private
state directory for a batch id. A failed handle write aborts the batch before any launch, and
the handle is an identity pointer, not a progress signal: there is still no per-item wakeup.
The finite manifest indexes approved items and runtime handles, not a competing task store.

Retain the exact-cwd lock and each responsibility's operation lock. Different cwd/worktrees
alone do not isolate actual writes, Git common state, adapter HOME/session store/cache, ports,
databases or output files. Read permission policy does not prove filesystem isolation. A
shared resource whose concurrency capability is unverified must be serialized within the
batch or use an already-authorized isolated environment. Do not copy credentials/private
profiles, create aliases or broaden parent roots to bypass a conflict.

Distinguish batch-local concurrency/admission from global behavior of separate CWR processes.
Claim a global safety guarantee only when all relevant entrypoints enforce it. Validate a
real route's shared-state concurrency once for the pertinent configuration, then reuse that
evidence until adapter/profile/state topology changes. Synthetic success cannot validate
all real adapters. A registered route is not evidence of multiple safe active sessions.

## Collection and recovery

Keep each session/request identity, final runtime state, cleanup, optional delivery and
actual artifact references. Use the current integration's bounded collector; never infer a
complete result from a truncated excerpt. Missing/malformed/oversized reports remain visible.
Child stdout and stderr retain separate bounded budgets: flooded diagnostics truncate stderr
visibly without starving a valid receipt, and a truncated stdout is refused as a receipt even
when the retained prefix parses as valid JSON.
Collect the report through the coordinator side so read workers need no new write authority.
A report format failure does not authorize replaying implementation.

Every settled result is published into the batch's durable index as it lands, so the
read-only collect verb returns what is known SO FAR without waiting for outstanding items;
the index always carries the full batch size, so settled and outstanding stay distinguishable.
Each result carries a bounded worker-reported delivery excerpt (marked worker_reported, a
verbatim clipped projection, never runner judgment). The runner generates candidate next
actions from trusted runtime/handle facts and attributed worker-reported delivery status;
answer_questions uses the worker's needs_input declaration and questions, not an independently
verified blocker. Candidates are a fixed hint vocabulary — reconcile the session,
inspect the receipt, consolidate the report on the same session, answer the worker's
questions — for the coordinator to judge. They are never commands, never worker text and
never auto-executed; a continue-class hint is offered only for a known session with terminal
runtime, confirmed cleanup and a matching handle.

Read results through the bounded compact interface. `batch --compact` (and
`collect --compact`) return a whole-response UTF-8 byte budget (default 32 KiB, minimum 8 KiB,
maximum 256 KiB) with an item limit (default 8, maximum 32), so metadata, cursor and items
together stay under the budget including the trailing newline. Each item carries short
evidence — `source`, summary, criterion counts with the unsatisfied list, and check
name/state/detail ordered problems-first — with text truncation and omission counts visible;
`worker_reported` never becomes a verified fact. When a rich item cannot fit, the runner
reduces only optional detail and names omitted fields in `omitted_fields`; minimal detail
still retains provenance and criterion/check counts. When results remain, a successful
page includes a locatable item or explicitly rejects an insufficient budget. The
full questions, artifacts and checks never enter the compact page. `collect --job JOB_ID`
expands one settled result in full from the durable index, and
`delivery --session UUID --request REQUEST_ID` expands the per-request sidecar.

The cursor is an opaque token naming this batch, revision and offset. It is validated strictly
for shape, canonical encoding, batch, range and revision — it is not an authenticity tag.
Nothing changed since the cursor re-sends no results; a new append is read incrementally. A
same-id update (late settlement or reconciliation) is replayed from the earliest changed item,
which may also repeat unchanged successors, so merge by job id and each item’s `rev`
(response `revision` for legacy `rev:null`), rather than assuming a strict event delta or zero
duplication. An un-expanded page, unsettled jobs with a recorded handle, `awaiting_handle` jobs
and genuinely missing results are separate facts. Awaiting a handle can mean pending
admission or startup; it does not prove no child exists, and a recorded handle proves
locks held, not prompt acknowledgement.
The legacy plain `batch` and `collect` full returns are unchanged and are not subject to the
compact budget.

De-duplicate the same session/request and preserve explicit revision lineage. Late older
results do not replace newer results. Retain useful partial artifacts and exceptions; don't
combine unknowns into verified claims. Runner-observed checks come only from an authorized
trusted execution path, not a field supplied by a worker. Never run shell commands extracted
from result text, and don't move candidate test code into a more privileged main environment.

A parent cancellation stops launching new items: admission re-checks the live batch state
after every asynchronous admission step and before each launch, so a cancelled batch starts
nothing new — the same admission stop applies when index publication fails. Owned active
operations get a cancellation request and a bounded wait for actual cleanup; at the end of
that wait one final real handle read preserves a handle a launched child published late.
The index retains observed handles as recovery clues; only a job-identity match enters
the trusted result start_handle. Cleanup stays unconfirmed, and a mismatched handle must
not be used as an authorized control target. A mid-batch admission or launch failure
closes admission yet still settles and reports the partial batch. On interrupted/ambiguous
submission, recover the recorded handles and receipts before deciding another action.
No bare nohup or detached
children masquerade as durable scheduling. Preserve uncertain state and failure evidence.
No missing required result may be hidden behind majority success. Healthy intermediate
progress need not wake the main model; return bounded meaningful changes or a final overview.

## Evidence-led feedback

Apply task-confirmed checks to the exact relevant candidate state. Dirty content cannot be
identified by HEAD alone. Choose checks that distinguish legitimate success and prohibited
behavior; use a narrow bad-implementation control when it can validate an important gate.
Reuse unchanged current evidence instead of re-running everything after each response.

Separate deterministic behavior failure, environment/permission blockage, nonexecution,
skip, stale evidence and disagreement with the criterion. A nonzero process exit alone does
not diagnose the code. Workers may challenge a faulty standard with evidence; coordinator
judgment resolves that conflict before a new equivalent correction.

Normal self-repair lives in the agent's tool-feedback loop. An experimental outer feedback
path needs a concrete applicable failed check, a stopped session with confirmed cleanup,
explicit remaining authority, a fixed responsibility deadline and a small correction budget.
Successful, cancelled, permission-denied, uncertain or missing-report-only cases are not
blind retry triggers. Preserve original receipts. Adopt extra automation only if a bounded
comparison shows it catches genuine premature delivery without gratuitous extra work.

## Peer merger and targeted follow-up

A merger reads collected outcome packages, not every original repository by default. It
handles duplicate identities, differing versions, criterion coverage, conflicting findings,
counterevidence and the final integrated result. Each synthesized claim retains its source;
majority agreement does not elevate worker reports into independently observed facts.

If evidence conflicts, return the smallest question that can alter the choice to the original
owner. Unavailable inputs stay partial; do not demand a fixed number of recommendations or
pretend unknown means unsupported. The coordinator selects product meaning and material
trade-offs while workers can retain the source-reading, mechanical work and local checks.

## Artifact lifecycle

Use existing private task storage and managed-path protections. A reusable behavior regression
belongs in existing tests; one-off probes, generated samples and full logs remain outside Git.
Track only task-created exact artifacts when ownership isn't otherwise clear. Preserve active,
uncertain-cleanup and uniquely reproducible failure state; clean only confirmed owned objects
under actual authorization. Never sweep user dirty files with git clean/reset. Before removing
referenced evidence, retain the useful minimal reproducer or label the reference expired.
