# Finite batch execution and results

Read when a task actually contains independent approved responsibilities. The integration's
installed CLI/help and canonical operator guide own exact arguments and supported interfaces;
this method describes the coordination guarantees they must preserve.

## Admission and resource ownership

Use independent CLI subprocesses for ACP jobs. The CLI scrubs its process environment, so
concurrent calls to its main function in one Node process are unsafe. Use trusted structured
start handles/control output to retain actual session IDs; do not parse human stderr strings.
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

De-duplicate the same session/request and preserve explicit revision lineage. Late older
results do not replace newer results. Retain useful partial artifacts and exceptions; don't
combine unknowns into verified claims. Runner-observed checks come only from an authorized
trusted execution path, not a field supplied by a worker. Never run shell commands extracted
from result text, and don't move candidate test code into a more privileged main environment.

A parent cancellation stops launching new items: admission re-checks the live batch state
after every asynchronous admission step and before each launch, so a cancelled batch starts
nothing new — the same admission stop applies when index publication fails. Owned active
operations get a cancellation request and a bounded wait for actual cleanup; at the end of
that wait one final real handle read preserves a handle a launched child published late,
without upgrading its cleanup beyond unconfirmed. A mid-batch admission or launch failure
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
