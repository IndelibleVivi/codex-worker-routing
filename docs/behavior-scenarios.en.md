# Observing delegation behavior

[中文](behavior-scenarios.md) | English

This page describes **non-runtime** observation scenarios for checking
whether Worker Routing follows its policy in an ordinary main session. The
canonical runtime instructions remain the
[SKILL.md and its four references](../plugins/worker-routing/skills/worker-routing/SKILL.md).

Use tool/thread traces, diffs and actual checks as evidence. A coordinator,
worker or user's assertion alone is not evidence. Each scenario separates the
trigger, expected observable behavior, required evidence and claims it does not
support; none establishes causality or savings.

## 1. A medium-sized fix requested in natural language

The user asks for a medium-sized fix without naming a skill, worker or model.

- Expected: before substantial execution, the coordinator establishes the goal,
  constraints, entrypoint and acceptance evidence. It delegates one coherent
  responsibility when that responsibility can be handed over whole, then avoids
  repeating the same investigation or implementing a second version while waiting.
  If direct work is more appropriate, it stays in the main session.
- Evidence: the thread trace showing whether and to whom delegation occurred,
  plus the responsibility's diff and checks actually run.
- No claim: one observation does not establish reliable triggering, quota
  savings or reduced rework.
- See the README's everyday-use examples for an observation starting point.

## 2. Continue the same child into implementation or correction

A responsibility begins with read-only investigation and later receives
implementation authorization, or the returned work needs a local correction.

- Expected: send the increment to the original child, without creating another
  worker. Feedback combines the actual failure, expected result and scope,
  preserves accepted work and avoids re-investigating unchanged parts.
- Evidence: the thread trace showing the same child continuing and whether any
  new child was created, plus the actual changes and checks for that turn.
- No claim: this does not establish net quota savings, less rework or greater
  speed, and is not a reason to build an evaluation platform.

## 3. Healthy waits do not cancel or duplicate work

A wait times out, stays silent or yields while the worker is still working.

- Expected: use host blocking waits and completion messages. A timeout, silence
  or active yield in a healthy run does not trigger an interrupt or a second
  worker doing the same job. Query status only when recovery, ambiguity or
  intervention warrants it.
- Evidence: the ordering of wait, interrupt and spawn events in the trace,
  not the main agent's statement that it did not interrupt.
- No claim: one quiet wait does not demonstrate reliable behavior in general.

## 4. Solo or tiny work does not spawn a worker

The user explicitly says `solo`, `work on this yourself` or `do not delegate`,
or the work is tiny, nearly complete, or cheaper to finish than to hand over.

- Expected: finish in the main session without another worker. If a writer is
  already active, let it stop safely or finish before taking over. Stopping
  progress monitoring is not the same as cancelling that worker.
- Evidence: the trace with no new child, and the main session's diff and checks.
- No claim: this is not proof of reliable triggering and does not require
  duplicate production runs or paid testing.

## 5. Change the default or revoke a route

Configure only one default worker and dispatch two independent responsibilities;
then change the default from A to B and continue the existing responsibility on A.

- Expected: ordinary delegation requires no catalog scan or capability biography.
  New work uses the current default; the existing session stays on A. Explicitly
  revoking A blocks further use while leaving stop/recovery operations available.
- Evidence: the selected route, same-session continuation, and run/continue/control
  outcomes before and after the change. ACP resolves the default inside the normal
  run call, without a mandatory discovery round trip.
- No claim: a shared model name proves neither equivalent capabilities nor data
  authorization across channels; config tests do not prove native host behavior.

## 6. Authorized fallback and execution recovery

The default entry is unavailable before launch and the operator has authorized a
backup; a separate responsibility fails after submission or has an ambiguous receipt.

- Expected: preflight availability failure considers only authorized backups and
  launches at most one worker. Permission, workspace and disabled-route denials do
  not trigger a bypass. After startup or ambiguous submission, recover the original
  execution, confirm the writer has stopped and inspect its changes before handing
  over remaining work. Quality failures use same-worker rework.
- Evidence: skipped-route codes, launch/prompt counts, receipts and cleanup, and the
  recovered diff. Do not repeatedly probe an unchanged known failure in the same task;
  without a backup, finish directly when the task allows it.
- No claim: runtime codes do not prove subscription expiry, exhausted credit or HTTP
  429; a historically used channel is not current fallback authorization.

## 7. Separate permissions from continuation identity

Investigation becomes implementation; another turn omits permissions; the route then
adds an unrelated workspace or lowers its permission ceiling.

- Expected: authorized implementation continues the same session with explicit full mode.
  Omission is rejected before dispatch, regardless of category. With the new identity,
  unrelated workspace or budget changes preserve continuation; revoking the bound cwd or
  requested permission denies it. Legacy migration requires the complete old fingerprint.
- Evidence: preflight errors and zero-launch/prompt/state-mutation controls, bound identity,
  and continuation/revocation outcomes. A permission mode is not OS sandbox evidence.
- No claim: configuration matching proves neither that every adapter tool asks permission
  nor the actual upstream model's identity.

## 8. Make a recovery decision before repeating stalled rework

Two explicit reworks leave the same acceptance gap with no material progress. Compare a
normal phase transition, a missing final report and a host capability gap.

- Expected: decide again before a third equivalent order. Continue with new evidence,
  a repaired environment or narrowed scope; preserve accepted work and allow partial
  takeover after stopping the original writer. Phase transitions are not quality failures,
  missing reports first consolidate existing evidence, and host denials are not bypassed.
- Evidence: the actual acceptance gap before/after, usable artifacts, and the new decision
  with its basis; no mandatory record/revision annotations are required.
- No claim: revision counts, elapsed time or completed status automatically prove quality.

## 9. Distinguish a host wait timeout from an execution deadline

A host wait yields during healthy work; another worker emits progress but never a
canonical final result.

- Expected: keep waiting on the first execution. The second fails at the CWR deadline
  and cleans up; a late end_turn cannot turn it into success. Cancellation also stays
  cancelled. Partial output and cleanup remain separately visible.
- Evidence: time boundaries, real acpx synthetic integration, result/receipt/exit status,
  cleanup and lock state, with normal completion as a control.
- No claim: synthetic tests establish real-provider reliability or reclassify old receipts.

## Explicit non-goals

- Do not claim proven triggering reliability, net quota savings, less rework or speed.
- Do not build an evaluation platform, require duplicate production runs or arrange paid tests.
- Do not treat this page as runtime policy; the
  [SKILL.md](../plugins/worker-routing/skills/worker-routing/SKILL.md) and
  `references/*.md` remain authoritative.
