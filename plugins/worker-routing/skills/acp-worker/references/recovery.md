# ACP recovery

Read for an actual failed or uncertain execution, identity change or revoked authority.
The coordinator owns the recovery decision; the receipt owns runtime facts.

## Establish the original execution

Keep the integration session/request handle. A lost response, active yield, missing
report or cancellation request does not prove no prompt was sent. Cancel's
`stopped:false` means the request was sent, not that a writer stopped.

On `RECOVERY_REQUIRED` or `BUSY_OR_UNRECONCILED`, carry routine recovery within the
current task's authority. Do not default to preserving an old lock indefinitely or
asking the human to clean it up or approve already-authorized work again:

1. Read `status` and the exact saved receipt if present. Use the session/cwd identified
   by the conflict; a workspace lock is not a global lock on the default route.
2. Run `recover --config CONFIG --session UUID` for literally read-only inspection.
   It creates no claim, challenge or recovery record. Check original owner/adapter
   identities, actual tool lifecycle, selected file holders and existing artifacts.
   An absent owner/group/census alone is never complete stop proof: ordinary Codex
   tools can start their own session/process group and survive their parent.
3. If the backend has sufficient proof (same verified host, prior boot; or complete
   failed-spawn admissions with a verified stopped owner), ordinary admission can
   recover mechanically before its single launch. Same-boot postlaunch and legacy
   evidence require independent coordinator reconciliation. A readable inspection
   and `attestation_allowed: true` permit a justified attestation, not its inference.
4. After independently establishing that the exact old writer stopped, invoke
   `recover --config CONFIG --session UUID --attest-stopped --confirm TOKEN`, using
   the current inspection's `confirmation`. It binds the full binding, pair nonce
   and lifecycle; it is not authority or a one-use credential. Known-live processes,
   unavailable current inspection and changed ownership/evidence cannot be overridden.
   Legacy missing historical fields differs from unreadable current facts; a present
   historical PID without start identity remains unresolved.
5. Read the recovery result and inspect preserved artifacts. A quarantined pair enables
   the intended new `run` once, or the original `continue` only when its identity and
   current authorization still hold. Never replay the ambiguous old write order.
   A genuinely live or unresolvable branch stays blocked: identify its exact missing
   fact instead of abandoning independent authorized work.

Recovery moves only the matched pair into private quarantine, preserving bindings,
receipts, orders, artifacts and the acpx conversation store. It records the old outcome
as `unknown`, with `order_replayed: false`. Attestation is `operator_reconciled`, not
mechanically verified stop or engineering acceptance. Normal `cleanup: confirmed`
concerns the ACP connection; it does not certify arbitrary independent tool/daemon stop.

A failed second rename leaves an exact planned/partial recovery record. Re-inspect and
use its fresh confirmation to finish the remaining move. A changed record, binding,
owner or target is refused; never restore an old lock over a new owner or hand-edit
state to clear the error. No recovery kills processes or silently switches routes.
Windows lacks a supported process inspector here, so lock recovery remains blocked
there while ordinary execution remains supported.

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
