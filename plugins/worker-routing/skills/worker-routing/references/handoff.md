# Work orders and rework

A work order should be the smallest sufficient context a worker needs to start
independently. Follow the structure of the current repository, plan, or task record; do
not create a table, tracker, or fixed report format for this skill.

## First handoff

Making the worker clear on the following facts is enough:

- the observable outcome to deliver, and the behavior that must stay unchanged;
- confirmed facts, unverified assumptions, and the canonical cwd, entry points, symbols, and tests;
- the complete responsibility it owns, its exact execution cwd, any additional read roots and allowed write roots, the dirty state, and the shared write surface;
- the verification that can distinguish failure from success, and the actual evidence to return;
- all permission boundaries and stop conditions.

The work order must state the worker-role semantics directly: this is a temporary
execution responsibility; the worker does not call Oracle and does not spawn derived
agents; it does not change routing or model configuration; it protects other people's
uncommitted changes; and by default it does not commit, push, merge, deploy, publish,
perform account or production operations, or maintain private continuity, unless the
main coordinating agent gives an explicit increment for one action within existing
authority. Providing only a reference link without ensuring the worker can read it does
not count as delivering the role semantics.

An entry point may be just a verified clue; the worker can complete in-scope investigation
and ordinary implementation decisions by itself. While product semantics are open, hand
over a clearly read-only investigation only, and do not let the worker silently decide the
rules for the user.

Do not copy a full private AGENTS file, chats, memory, account data, or unrelated logs
into a work order. A short work order and `fork_turns='none'` both fail to prove that the
host attached no instructions, tools, skills, or other context. A third-party provider's
transfer scope needs its own real authorization and host evidence.

## Return and acceptance

The worker states in short facts whether the work is complete, partial, or blocked, and
points to the relevant files or symbols, the checks actually run and their results, the
order of those checks against the last relevant modification, what remains unverified,
and the questions that need coordination. When the shared workspace lets the coordinator
read the diff directly, do not copy the whole patch; keep large logs where they are and
give the key error and an accessible pointer.

A return is an evidence index, not automatic acceptance. The main coordinating agent
checks the final state and whether the evidence can reject the relevant failure.
If the final report is missing or vague, first ask the same worker to consolidate
existing artifacts, actual checks, and remaining gaps. Do not repeat research merely
to produce a cleaner report. Preserve useful partial results during any takeover.

## Continuing the same worker

A read-only-to-implementation transition, a new constraint, missing evidence, and local
rework should all send an increment to the original worker. State which accepted results
are preserved, the actual failing input or behavior, the correction standard, whether
permissions changed, and the checks to add; do not re-explore the unchanged parts from
scratch.

Choose the next step from the actual gap. A failed check or missed requirement normally
needs same-worker rework. A setup/deadline failure, undelivered permission, unavailable
tool, new requirement, phase transition, or corrected coordinator premise needs its own
remedy; none automatically proves poor worker quality. After two explicit reworks leave
the same acceptance gap without material progress, make a new decision before a third
equivalent order. Continue only with a concrete reason such as new evidence, a repaired
environment, or a narrower remaining scope; otherwise take over the unresolved part or
use an authorized replacement after stopping the original writer. There is no fixed
turn budget and no mandatory collaboration annotation.

For cross-project work, distinguish the declared roots from the host's actual filesystem
and tool capabilities. An exact-cwd ACP lock does not cover overlapping writes launched
from another cwd or state directory. Coordinate shared resources explicitly. When the
host cannot grant the declared scope, stop that action and return the denied operation
and boundary; narrow or split the responsibility, or let an authorized coordinator do
that part. Do not broaden a parent-root allowlist or change channels to evade a denial.

After context loss or compaction, recover the responsibility, the child identifier, and
the existing evidence from the task record and native state before deciding whether to
create anything new; missing memory does not mean the earlier worker is gone, and you do
not add a new tracker. Switch workers only when the original child cannot recover, keeps
misjudging because of tangled context, or genuinely lacks the execution capability.
Confirm the old writer has stopped, then hand the smallest recoverable summary and the
existing artifacts to the new executor.
