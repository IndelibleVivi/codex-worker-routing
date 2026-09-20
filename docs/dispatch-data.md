# Dispatch data contract

[中文](dispatch-data.zh-CN.md) | English

[User guide](dispatch.en.md) · [使用指南](dispatch.md)

Dispatch projects existing private state; it does not own worker execution or create a
second task database. The projection is `cwr.dispatch/1`, rebuilt from ACP bindings,
terminal receipts and explicit coordinator annotations. It never loads the adapter.

## Source ownership and storage

| Source, relative to private `stateDir` | Meaning |
| --- | --- |
| `bindings/<session>/binding.json` | Existing responsibility identity and lifecycle; optional `active_turn` records a started request without a terminal receipt. Optional `dispatch` metadata binds a short title and category. |
| `bindings/<session>/receipts/<request>.json` | Runtime outcome, timestamps, cleanup and adapter-reported cumulative session usage. Additive `observations` retain structured runtime codes. Diagnostic files are excluded. |
| `requests/<session>/<request>.order.txt` | JSON envelope `cwr.dispatch.order/1` with the submitted work-order `text`. Retained locally for new run/continue commands; never added to an export. |
| `dashboard-preferences.json` | Only `{theme, language, timeZone}` display preferences; authenticated local PUT, 1 KiB input limit. |
| `events/<session>/<event>.json` | Append-only coordinator annotation `cwr.dispatch.event/1`. |

Titles are optional, at most 160 characters. Categories are `investigation`,
`implementation`, `review`, or `other`. Continuation preserves the bound metadata;
`dispatch.type` (`dispatched` or `continued`) is the prospective-tracking marker, and
`dispatch.tracking_started_at` records the instant a legacy continuation adopted
tracking. Existing `dispatch.type='dispatched'` bindings already count as tracked.
Legacy records are not classified from output. Available `CODEX_THREAD_ID` and
`CODEX_SESSION_ID` are captured before the adapter environment is scrubbed. A parent
first observed during a legacy continuation carries `observed_at`; it is not proof
of a historical association. These identifiers remain local.

Work-order retention is additive: a retention failure is recorded in the terminal
receipt as `dispatch_warning`, and the projection reports a coverage notice. Existing
legacy orders are not reconstructed from transcripts. Managed reads reject directory
symlinks, non-regular or multi-link files and unsafe private file modes; they never
repair state. Windows ACL privacy remains an operator responsibility.

## Coordinator events

The `record --session UUID --file FILE` input is an object with the following fields.
Unknown fields are rejected; the command supplies `at` at recording time.

| Field | Contract |
| --- | --- |
| `schema` | Exactly `cwr.dispatch.event/1`. |
| `event_id` | UUID, used as the idempotency key for this action. |
| `session_id` | Existing integration UUID, matching `--session`. |
| `kind` | `submitted`, `revision_requested`, `accepted`, `taken_over`, or `note`. Only `accepted`/`taken_over`/`revision_requested`/`submitted` are review evidence. |
| `request_id` | Optional opaque request identifier belonging to a receipt in this session. |
| `reason` | Required for revision/takeover; otherwise absent/null. |
| `summary` | Optional plain text, at most 1,000 characters. |
| `evidence` | At most 64 `{source, kind, summary}` entries; summary is required and at most 1,000 characters. |
| `supersedes` | Optional UUID of the latest annotation being corrected, in this same session. |

Reasons: `requirement_missed`, `validation_failed`, `scope_changed`,
`constraint_added`, `environment_blocked`, `uncertain`. Evidence sources are
`coordinator` and `worker`; evidence kinds are `diff`, `test`, `manual`, `other`.
A worker's test claim stays worker-reported even when the coordinator records it.

An identical retry with the same event id is a no-op preserving the original time;
different content under that id is rejected. Corrections append a new file and may
reclassify an event. Only the effective end of a valid correction chain is counted.
Dangling, cyclic, time-reversed or branched correction chains are excluded with a
warning; original validated annotations remain visible in detail. Future events are
excluded from the current projection. A correction takes effect at its recorded time,
so it may move the effective annotation into a different observation window.

Independent event ids can append concurrently. Corrections additionally lock their
target. A concurrent conflicting writer receives a busy/conflict error and must
re-read/retry the same action id; locks are not auto-deleted. A failed annotation
write must not cause the worker task to be rerun.

## Time windows and counts

`--since` accepts `all`, a positive number followed by `h`, `d`, `w`, or `m` (30 days),
an ISO date, or an ISO timestamp with timezone. Relative windows are rolling durations;
calendar buckets use the selected `time_zone` (CLI defaults to UTC; browser defaults to device time). Bounds are inclusive. Receipts belong to
the period containing their finish timestamp, falling back to start when absent.
Future receipts are excluded.

A responsibility appears if it was created, produced a receipt, received an effective
annotation, started a turn, or closed in the selected period. `worker_turns` counts terminal receipts;
`runtime_completed`, `failed`, and `cancelled` count the latest in-period outcome once
per responsibility. A later started turn without a terminal receipt has no terminal outcome yet; an open persistent session alone does not change completion. They do not imply acceptance. Submissions and revisions count
effective in-period events, not sessions; continuing is never inferred to be rework.

Acceptance is the latest effective decision as of the observation time. A later
submission, revision, or recorded runtime turn invalidates an earlier acceptance.
`accepted` and `taken_over` count the resulting status of the displayed responsibilities.
Other responsibilities remain `unverified`; absence of a marker is not a failure.
The projection describes recorded turns, not live process health.

## Review state

Statistics are LIGHT and OBSERVATIONAL. Runtime facts are derived automatically from
existing receipts; ordinary completion or close without any annotation is normal and is
NOT an outstanding review obligation. No stamp is required after a delegation. Every
projected responsibility carries one mutually exclusive `review_state`, and the
projection's `summary.review` object holds a count per state (all present, including
zeros). The accepted values are:

| `review_state` | Meaning |
| --- | --- |
| `not_requested` | The ordinary default: tracked, with runtime facts, and no current explicit review request or decision (including intentionally closed work). |
| `accepted` | A current explicit `accepted` decision stands. |
| `taken_over` | A current explicit `taken_over` decision stands. |
| `awaiting_review` | An explicit `submitted` event requests review and no later decision supersedes it. |
| `changes_requested` | An explicit `revision_requested` stands, with no later successful returned turn. |
| `needs_attention` | The latest terminal turn on OPEN tracked work failed or was cancelled, or its cleanup is unconfirmed. |
| `no_receipt` | Open and tracked but no receipt yet. Not proof of a running process. |
| `legacy_untracked` | A binding with no Dispatch tracking and no explicit review event; quietly historical. |

Only source evidence derives the state, from a single chronological walk over the
effective events and terminal turns. An explicit `submitted`, `revision_requested`,
`accepted`, or `taken_over` event establishes tracking even on a legacy binding that
predates the metadata; a plain `note` never establishes tracking, requests review, or
invents a decision. `accepted`/`taken_over` set the current decision;
`revision_requested` sets `changes_requested`; `submitted` is an explicit review request
that invalidates a standing decision and puts the record in `awaiting_review`. A later
successful (`completed`) turn clears an outstanding correction or review request back to
`not_requested` and invalidates a standing acceptance, because the rework came back and
nobody re-requested review. A later failed/cancelled/unconfirmed turn on open work marks
the record `needs_attention`. Runtime `completed` is never acceptance by itself.
Future-dated observations are ignored. A legacy binding with no tracking and no explicit
review event is `legacy_untracked` — historical context, never active review work. A
legacy continuation that becomes tracked records `tracking_started_at`, so its earlier
turns are never retroactively marked reviewed.

`session.acceptance` remains the compatible view: it is the current review decision
when one is still standing, otherwise `unverified`, derived from the same evidence so
the two can never disagree. `session.review_state`, `session.review`
(`{state, tracked, decision, decision_at}`), and `summary.review` are the review
compatible review interface for local tools; the dashboard highlights explicit revisions/takeovers without a review-completeness score.

### Actionable view

`pending --config FILE` is an on-demand, read-only view (`cwr.dispatch.pending/1`) of
only actionable records — `awaiting_review`, `changes_requested`, and
`needs_attention` — newest first. It is not a backlog you must clear: ordinary
completion and closure without an explicit outstanding request never appear. It excludes `legacy_untracked` history
and current decisions. Each record contains only `session_id`, `review_state`, `closed`,
`status`, `title`, and `updated_at`; it never includes work-order text, output, or a
filesystem path. `pending` loads no adapter.

### Optional revision shortcut (`continue --revision-reason`)

`continue --revision-reason REASON` is an OPTIONAL shortcut for a real correction: it
appends one `revision_requested` event (using the documented reason enum, with an
internal event UUID and null request id, because no receipt exists yet) before the prompt, so the rework is attributed without a
separate JSON file. It is never required for an ordinary continuation, and a plain
`continue` never records a revision. The reason is validated during normal continuation
preflight, so an invalid value starts no adapter turn. If the annotation cannot be
recorded, the authorized task still runs exactly once and the interruption is surfaced
through the existing additive `dispatch_warning` path (`REVIEW_NOT_RECORDED`, preserving
any prior warning). For a deliberate deep review, the standalone `record` command
remains available; it is not required in the ordinary flow.

Home is the aggregate view: period totals, execution/new-responsibility activity,
an exact-proportion status strip, route distribution, explicit revisions/takeovers and runtime notes. Its activity
chart covers the complete selected window, merging adjacent selected-zone days when needed.
The new-responsibility chart counts creation timestamps inside the window, which can
be fewer than the headline's active responsibilities. Individual trails are under
**Sessions**. Route timing is the median elapsed time of valid in-period receipt pairs;
these are unmatched tasks, so the display is not a model-performance ranking.

## Cumulative usage accounting

Adapter usage is a session-cumulative observation, not a per-turn amount. Snapshots
100 → 180 → 250 count as 250 over all time, never 530. For a bounded period:

- A session created inside the period starts from zero.
- An older session requires the last pre-boundary receipt's total as its baseline.
  100 before the boundary → 250 inside contributes 150.
- A turn straddling the boundary cannot be split and makes that session's period
  usage unknown, even when an older baseline exists.
- A decreasing/reset counter, unknown baseline, or missing final total makes usage
  unknown. A later valid cumulative snapshot can bridge a missing intermediate one.
- Input/output/thought components use their own known endpoint deltas; missing
  components stay null. Known zero remains zero. Future snapshots are ignored.

`usage_total_sessions` is the number of displayed responsibilities with receipts in
this period; event-only responsibilities do not enter this denominator.
`usage_sessions` is the number with attributable totals. `external_tokens` sums those
known totals and is null if none are known. Coverage and warnings accompany partial
sums. Usage is adapter-reported workload, not provider identity, billing, performance,
or Codex quota-savings evidence. No quota API, A/B workload, model evaluator, or score
is introduced.

## Private views and public exports

The list/stats projection permits local route names, titles, opaque parent/session
identifiers, event summaries and source-tagged evidence. Work orders and bounded
worker output excerpts are loaded only in responsibility detail. `session.workspace` and `workspaces` expose local paths for project grouping; raw diagnostics, adapter handles and full transcripts are not projected.
`pending` uses the same allowlist and additionally omits event and evidence text.

`cwr.dispatch.share/1` is a separate allowlist: normalized dates, IANA timezone, aggregate counts,
known token totals or null, usage coverage, review-state counts, and warning count. It contains no routes,
titles, event/evidence text, work orders, output, paths or internal ids. It carries no theme,
colour, style or CSS field: the renderer's palette is chosen only from a bounded local
registry in `themes.mjs` (`getTheme(id)`, four ids, unknown ids falling back to `sage`) and never read out
of export data. Each theme selects a companion from `mascots.mjs`; the header uses the fixed line mark from `mark.mjs`; the default seal retains the Canon cat from `brand.mjs`. Neither artwork nor colour values are accepted from data. Its SVG/PNG renderer uses a fixed repository address, task totals, runtime outcomes and usage coverage, with language and theme as independent
parameters and a `worker-routing-THEME-LANGUAGE-FORMAT-DATE.ext` filename. Chinese and
English exports are independently selectable. Preview and download use the same frozen
snapshot and timezone, independent of list filters. The statistical portion of image captions uses that same allowlist. Export is a local download; nothing is uploaded.

Share personalization is separate from this statistical payload. `share-style.mjs`
normalizes only explicit author text and named presentation choices: slogan (80 Unicode
code points), optional single-line sharedBy (32), numberStyle and ornament. Drafts live
in browser memory until refresh, never in receipts, dashboard preferences or an API
request. The renderer XML-escapes text; captions include the same authored words.
No task, project, route, path or account identity is used to populate these fields.

## Workspace and runtime evidence

`session.workspace` carries `{id,name,kind,root,cwd,limitation}`; `kind` is `git`, `folder` or
`unknown`. Local Git common-directory identity merges linked worktrees; there are no remote
lookups. Missing paths retain the recorded folder; missing cwd forms one unknown bucket.
This is directory provenance, not a saved Codex project identity. Workspace probes are cached
per reader. `activity` carries `date`, turn count, unique active responsibility count,
`session_ids` and `created_session_ids`; creation ids are in-window only. Date drill-through
consumes those exact ids.

New receipts may carry `observations: {coverage,events,omitted}`. Current acpx 0.15.1 only
exposes typed runtime error codes (`code`, `detail_code`, `retryable`) with source, request
and UTC time; coverage is `runtime_codes_only` or `none`. No provider HTTP status or retry
event is available. Neither numeric JSON-RPC codes nor prose are promoted to HTTP 429.
Unsupported HTTP/retry fields are excluded from normalization. Snapshot `runtime_notes`
counts in-window observations and sessions; its zero `http_429_count` is a capability limit,
never evidence of no rate limiting. Detail retains the complete local trail. Observation
collection is synchronous, bounded per turn and saved with the existing terminal receipt;
it does not call providers, write per event, infer review, or schedule retry work.
