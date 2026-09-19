# Dispatch data contract

[User guide](dispatch.en.md) · [使用指南](dispatch.md)

Dispatch projects existing private state; it does not own worker execution or create a
second task database. The projection is `cwr.dispatch/1`, rebuilt from ACP bindings,
terminal receipts and explicit coordinator annotations. It never loads the adapter.

## Source ownership and storage

| Source, relative to private `stateDir` | Meaning |
| --- | --- |
| `bindings/<session>/binding.json` | Existing responsibility identity and lifecycle. Optional `dispatch` metadata binds a short title and category. |
| `bindings/<session>/receipts/<request>.json` | Runtime outcome, timestamps, cleanup and adapter-reported cumulative session usage. Diagnostic files are excluded. |
| `requests/<session>/<request>.order.txt` | JSON envelope `cwr.dispatch.order/1` with the submitted work-order `text`. Retained locally for new run/continue commands; never added to an export. |
| `events/<session>/<event>.json` | Append-only coordinator annotation `cwr.dispatch.event/1`. |

Titles are optional, at most 160 characters. Categories are `investigation`,
`implementation`, `review`, or `other`. Continuation preserves the bound metadata;
legacy records are not classified from output. Available `CODEX_THREAD_ID` and
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
| `kind` | `submitted`, `revision_requested`, `accepted`, `taken_over`, or `note`. |
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
calendar display and chart buckets use UTC. Bounds are inclusive. Receipts belong to
the period containing their finish timestamp, falling back to start when absent.
Future receipts are excluded.

A responsibility appears if it was created, produced a receipt, received an effective
annotation, or closed in the selected period. `worker_turns` counts terminal receipts;
`runtime_completed`, `failed`, and `cancelled` count the latest in-period outcome once
per responsibility. They do not imply acceptance. Submissions and revisions count
effective in-period events, not sessions; continuing is never inferred to be rework.

Acceptance is the latest effective decision as of the observation time. A later
submission, revision, or recorded runtime turn invalidates an earlier acceptance.
`accepted` and `taken_over` count the resulting status of the displayed responsibilities.
Other responsibilities remain `unverified`; absence of a marker is not a failure.
The projection describes recorded turns, not live process health.

Home is the aggregate view: period totals, execution/new-responsibility activity,
acceptance composition, route distribution and explicit revision reasons. Its activity
chart covers the complete selected window, merging adjacent UTC days when needed.
The new-responsibility chart counts creation timestamps inside the window, which can
be fewer than the headline's active responsibilities. Individual trails are under
**Records**. Route timing is the median elapsed time of valid in-period receipt pairs;
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
worker output excerpts are loaded only in responsibility detail. Filesystem paths,
raw diagnostics, adapter handles and full transcripts are not projected.

`cwr.dispatch.share/1` is a separate allowlist: normalized dates, aggregate counts,
known token totals or null, usage coverage, and warning count. It contains no routes,
titles, event/evidence text, work orders, output, paths or internal ids. Its SVG/PNG
renderer uses fixed project attribution and aggregate acceptance composition. Preview
and download use the same frozen snapshot, independent of list filters. Export is a
local download; nothing is uploaded.
