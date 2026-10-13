# ACP recovery

Read for an actual failed or uncertain execution, identity change or revoked authority.
The coordinator owns the recovery decision; the receipt owns runtime facts.

## Establish the original execution

Keep the integration session/request handle. Use status and its receipt; a lost response,
missing report, active yield or cancellation request does not prove no prompt was sent.
Unconfirmed cleanup requires reconciling that exact writer, preserving artifacts and
locks. Never blindly delete locks or replay an ambiguous write order. A dead owner PID
alone does not establish every child is stopped. Cancel's stopped:false is truthful.

Timeout/cancel decisions remain terminal even if a late end_turn arrives. Partial output
can be useful; failed runtime, failed delivery, unknown evidence and quality are distinct.
The task deadline starts at prompt acknowledgement and includes canonical finalization;
setup and cleanup have separate bounds. Do not refresh a responsibility budget to hide
stagnation. Reuse confirmed failures while their conditions are unchanged.

## Identity and mutable authorization

Continue verifies the original cwd, persistent handle and versioned execution identity
(adapter/argv, worker home, environment declarations, context revision, explicit model).
Workspace inventory and timeout budget are not identity. Each turn rechecks enabled,
current cwd allowlist and requested permission ceiling. A default change affects new work,
not an existing binding; revocation still blocks continuation. Status/cancel/close remain
available. Do not restore withdrawn authorization or switch channels to bypass denial.

Legacy bindings migrate only under lock while their complete old fingerprint matches.
A mismatch without the old snapshot fails closed. After confirmed stop and preserved
results, hand only remaining authorized responsibility to an appropriate executor;
do not rewrite hashes or historical receipts to pretend migration/cleanup succeeded.

## Repair the smallest gap

A known pre-submission argument omission can be corrected from existing authority without
asking the user again. Ordinary test failures and known in-scope defects belong in the
worker's own loop. A missing report needs consolidation; invalid optional delivery needs
report repair, not automatic replay of implementation. A capability or material decision
gap needs an exact blocked operation or question; it is not automatically poor quality.

Supply the original failed criterion, actual/expected evidence, already-supported behavior
and permitted remaining scope. Prefer the same session. After two explicit coordinator
reworks leave the same gap without progress, change the diagnosis/conditions/scope before
another equivalent order; internal test iterations are not those reworks. A new fact can
justify continuing; obvious inability can justify stopping earlier.

Provide a decision or repair an environment boundary without reclaiming all execution.
If the coordinator edits a critical part, stop overlapping writers, preserve the change,
then let the original worker reread that state and finish remaining calls/checks/docs.
Keep other independent responsibilities moving. Use an authorized replacement only for
unrecoverable context or capability mismatch, preserving useful artifacts and lineage.
