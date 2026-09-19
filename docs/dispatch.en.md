# Dispatch

[中文](dispatch.md) | English

Delegate as usual; receipts leave a trail. Dispatch is a local, read-only view of ACP
receipts and the coordinator’s explicit submission, revision, acceptance and takeover
events. It does not schedule work or introduce a second job database. Native Codex
activity has no connected data source here; every metric is explicitly ACP-only.

## Open the dashboard

With the [ACP integration](acp-integration.md) already configured, run from the canonical checkout:

```sh
node integrations/acpx/src/cli.mjs dashboard --config /absolute/private/routes.json
```

Open the private loopback URL printed by the command. The default port is ephemeral;
use `--port 4317` to choose one. `--since 7d`, `--since 30d` and an ISO date such as
`--since 2026-01-01` are supported; the default is `all`. The UI offers period selection,
search, an attention filter, responsibility replay and Chinese / English labels.

The command stays in the foreground and installs no service. “Close dashboard” or Ctrl+C
releases the process. After the last page stops sending heartbeats, it exits in about two
minutes; a never-opened link has five minutes. Browser sleep or prolonged suspension can
also stop heartbeats; run the command again. A failed dashboard does not control workers.

For a terminal view or your own local tools:

```sh
node integrations/acpx/src/cli.mjs stats --config /absolute/private/routes.json --since 7d
node integrations/acpx/src/cli.mjs stats --config /absolute/private/routes.json --since 7d --json
```

The JSON projection is private: it includes route names, titles and session associations.
Do not publish it as a share report. These commands do not load adapters, call models,
read account allowances or scan Codex rollouts.

## Home and Records

Home shows aggregate statistics: period totals, activity across the entire selected window,
acceptance composition, route workload and explicit revision reasons. Bars switch between
execution turns and newly created responsibilities; hover, focus or tap reveals each bucket.
New responsibilities count creation inside the window, unlike the headline which includes
existing sessions active in it. Clicking a route opens its filtered records. White, sage,
macaron pink and deep plum carry the visual language. Individual replays live in Records.

## Read a responsibility

Execution turns come from receipts. A continuation is not automatically rework, and runtime
completion is not acceptance. Submissions, revisions, acceptance and takeovers require
explicit coordinator events. Evidence keeps its `coordinator` or `worker` source; a worker’s
test claim never becomes independent coordinator verification. Missing historical metadata
stays unknown rather than being inferred from output prose.

The updated `acp-worker` skill records these events alongside ordinary coordination;
people do not need to fill out a performance form. Source changes do not refresh an installed
plugin cache: use the normal [plugin update flow](installation.md#plugin), then verify discovery
in a new main session.

New work can have a short bound title and category:

```sh
node integrations/acpx/src/cli.mjs run --config /absolute/private/routes.json \
  --route registered-worker --cwd /absolute/approved/worktree \
  --file /absolute/work-order.md --title 'Fix empty input handling' --category implementation
```

The title and category stay with that session. To record an actual acceptance, save this
synthetic example outside Git, replacing both UUIDs. Reuse the event UUID when retrying
the same action:

```json
{
  "schema": "cwr.dispatch.event/1",
  "event_id": "11111111-1111-4111-8111-111111111111",
  "session_id": "22222222-2222-4222-8222-222222222222",
  "kind": "accepted",
  "summary": "Reviewed the change and accepted delivery.",
  "evidence": [
    {"source": "coordinator", "kind": "test", "summary": "Ran the empty-input regression; it passed."},
    {"source": "worker", "kind": "test", "summary": "The worker reported its unit tests passed."}
  ]
}
```

```sh
node integrations/acpx/src/cli.mjs record --config /absolute/private/routes.json \
  --session 22222222-2222-4222-8222-222222222222 --file /absolute/private/event.json
```

Only record checks actually performed. Revisions and takeovers require a reason. An event
can correct an earlier annotation using `supersedes`, preserving its history. See the
[data contract](dispatch-data.md) for schemas, correction rules and period accounting.

## Workload, not savings

Adapter usage is usually cumulative per session: snapshots of 100, 180 and 250 mean 250
tokens, not 530. A bounded period needs attributable deltas. Missing baselines, resets and
unknown values affect coverage and warnings rather than becoming zero. Route medians
describe their own task samples; they do not rank model speed across unmatched tasks.

This is neither billing evidence nor an estimate of Codex quota saved. Dispatch does not
arrange repeated A/B tasks, score models or claim a savings percentage. Recorded reasons
remain the coordinator’s attributed judgments, with work orders and receipts available
for local inspection.

## Export a little proof

“Export a little proof” previews **1600 × 900** landscape and **1080 × 1350** portrait
artifacts, downloadable as SVG or PNG. They cover all ACP aggregates in the selected period,
regardless of list filters. Preview and download use the same frozen report.

A separate allowlist accepts only numeric aggregates, period bounds, coverage and fixed
project attribution. Work orders, outputs, route names, paths, parent/session IDs and
diagnostics never enter the export payload. The graphic encodes aggregate acceptance, without individual work-order trails. Nothing uploads automatically.

## Local boundaries

The HTTP server binds only `127.0.0.1`, requires a random bearer token for data and checks
Host / Origin. The private link carries its token in the fragment, which the page removes
after reading. Do not share this link. All assets are local: no CDN, remote fonts, analytics
or external requests. Export is an independent data boundary, not merely hidden UI fields.

The first read builds an in-memory projection; later reads reparse changed files. There is
no persistent secondary index. Compact events, submitted work orders and available parent
IDs live in the existing private state outside Git. Details read work orders and bounded
receipt excerpts on demand, not full transcripts. Legacy records are not migrated or repaired.
POSIX modes and Windows ACL limits remain those of the [ACP integration](acp-integration.md).

## Verify and recover

```sh
cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
```

Synthetic checks cover accounting, event correction, evidence provenance, legacy data,
export privacy, HTTP access and shutdown. Browser acceptance additionally exercises
period/search filters, replay, keyboard closure, both export layouts and desktop/mobile
geometry. These checks do not verify a real provider’s identity or replace owner acceptance.

Stop the dashboard to remove the presentation layer. Keep receipts and events; restore source
through version control if necessary. No native worker or ACP session needs to be recreated.
