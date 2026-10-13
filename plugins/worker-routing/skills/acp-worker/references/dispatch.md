# Optional Dispatch records and views

Read only when statistics, attributed review records, pending items or sharing are requested.

## Natural collaboration records

Dispatch statistics are LIGHT and OBSERVATIONAL. The runtime facts (turns, receipts,
runtime status, usage) are derived automatically; do NORMAL `run`/`continue`/`close`
without any bookkeeping. Ordinary completion or close needs no annotation and is not an
outstanding review obligation. Do not add a `submitted`/`accepted`/`record`/`pending`
step after every worker, and do not fill in history for completeness. Give a new
responsibility a short task title and one category on the original `run`
(investigation, implementation, review, other); that is metadata, not a reporting step.

Two optional, genuinely useful moments:

- **A real correction worth recording**: when you actually send rework, you may pass the
  reason with the continuation itself:
  `node ENTRY continue --config CONFIG --session UUID --file REWORK --permissions full --revision-reason
  REASON` (one of requirement_missed, validation_failed, scope_changed,
  constraint_added, environment_blocked, uncertain). This is a shortcut, not required
  for ordinary continuation, and `continue` without `--revision-reason` never records a revision. If the
  annotation cannot be written, the authorized task still runs exactly once and the
  interruption is reported through the existing additive warning; never rerun the
  worker to repair telemetry.
- **A specific task that needs retained review evidence**: use
  `node ENTRY record --config CONFIG --session UUID --file EVENT_JSON` deliberately for
  a submission for review, an explicit acceptance or takeover, or a note you want kept.
  This is optional and not part of the ordinary flow. Do not infer acceptance from
  runtime completion, classify provider text automatically, or backfill old decisions
  from memory. A plain `note` records an observation and never invents a review.

The projection derives one `review_state` per responsibility and a `summary.review`
count per state (accepted, taken_over, awaiting_review, changes_requested,
needs_attention, no_receipt, not_requested, legacy_untracked). `not_requested` is the
ordinary default; `awaiting_review` requires an explicit `submitted` event; legacy
bindings with no tracking and no explicit review event stay `legacy_untracked`, quietly
historical and never pending work. When you actually want to check what still needs a
look, run `node ENTRY pending --config CONFIG`: it is read-only, loads no adapter,
excludes legacy history and ordinary work with no explicit outstanding request, and prints safe ids, state, status and
title only. It is an on-demand view, not a backlog you must clear.

The `record` input uses schema `cwr.dispatch.event/1`, a new UUID `event_id` per action,
the existing `session_id`, and `kind`: submitted, revision_requested, accepted,
taken_over, or note. Keep this small JSON outside Git; do not put raw work orders or
transcripts in it. `summary` is optional. Revision/takeover requires one reason:
requirement_missed, validation_failed, scope_changed, constraint_added,
environment_blocked, uncertain. Only claim checks actually performed. Optional evidence
entries are `{source: coordinator|worker, kind: diff|test|manual|other, summary: text}`;
worker claims keep their own source. An optional request_id must name an existing
receipt.

Keep the same event_id when retrying an uncertain write. Correct a mistaken label with a
new event_id and `supersedes` pointing to the latest event in its chain; never rewrite
the original file. When retained review evidence matters, a real coordinator takeover
can be recorded explicitly. Read `docs/dispatch-data.md` in the canonical checkout for
the full contract.

Use `stats --config CONFIG --since 7d` for local totals, `pending --config CONFIG` only
when you want to check for actionable review records, and `dashboard --config CONFIG`
when asked for the visual overview. None invokes a model or reads account quota. Only
the dashboard's aggregate export is prepared for sharing; stats JSON, pending and detail
contain local identifiers and task information. No automatic upload, A/B workload or
quota-savings percentage is part of this flow.
