# Dispatch

[中文](dispatch.md) | English

Delegate as usual; receipts leave a trail. Dispatch is a local view of read-only ACP
receipts and deliberate coordinator review notes. It does not schedule work or introduce a second job database. Native Codex
activity has no connected data source here; every metric is explicitly ACP-only.

## Open the dashboard

With the [ACP integration](acp-integration.md) already configured, run from the canonical checkout:

```sh
node integrations/acpx/src/cli.mjs dashboard --config /absolute/private/routes.json
```

Open the private loopback URL printed by the command. The default port is ephemeral;
use `--port 4317` to choose one. `--since 7d`, `--since 30d` and an ISO date such as
`--since 2026-01-01` are supported; the default is `all`. The UI offers period selection,
project/folder grouping, search, explicit revision/takeover filters, replay and Chinese / English labels.
If the initial local statistics read fails, the dashboard makes up to five attempts; this never
redispatches a worker. Closing stops retries and polling, and late reads cannot replace the closed notice.

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

## Home and Sessions

Home is a compact working dashboard: tasks, turns, observed tokens, an exact-proportion
status strip, full-window activity, route workload, explicit revisions / takeovers and runtime notes.
Errors use neutral slate. Switch bars between turns and newly created tasks: every continuation
counts as a turn, while creation counts once inside the window. Date, status and route clicks
open filtered Sessions. Replays retain the full trail and highlight the selected dates.

Sessions has a searchable project entrypoint. The stored working directory (`cwd`) identifies
local Git repositories; subdirectories and linked worktrees group under one repository, with
an additional working-folder filter. Non-Git directories group by folder. Unavailable paths
retain their recorded location and disclose the limitation; absent directories form an unknown
bucket. These are not saved Codex project names, and no chat text is used to infer identity.
Projects, paths, work orders, receipts and structured trails stay in local inspection.

The browser defaults to the device's IANA timezone, with Shanghai, UTC and New York overrides.
Calendar buckets, drill-through, replay, share dates and captions use the same zone. Stored
instants remain UTC; rolling 7/30-day windows and inclusive bounds are unchanged. CLI JSON
defaults to UTC and accepts `--time-zone Asia/Shanghai`.

Runtime notes automatically retain structured acpx error codes with source and time. Current
acpx exposes neither provider HTTP status nor internal retries. Text mentioning 429 or a
JSON-RPC code is not confirmed HTTP 429; missing observations do not mean no rate limiting.
A started turn without a terminal receipt is shown separately; an open persistent session
alone does not mean work is still running.

## Themes: four palettes and sibling animals

There are exactly four themes, with two authoritative sources:
[`themes.mjs`](../integrations/acpx/src/themes.mjs) defines the id, names and palette, and
[`mascots.mjs`](../integrations/acpx/src/mascots.mjs) defines the companion artwork. The page
(charts included) and the share artifacts read the same `THEMES` / `getTheme`:

| id | Name | Palette | Companion |
| --- | --- | --- | --- |
| `sage` | Sage cat / 鼠尾草猫 (default) | Sage & blush / 鼠尾草粉 | Folded-ear cat (Canon) |
| `rose` | Oat bunny / 燕麦玫瑰兔 | Oat & rose / 燕麦玫瑰 | Rabbit |
| `mist` | Mist puppy / 雾蓝奶油狗 | Mist & cream / 雾蓝奶油 | Dog |
| `lavender` | Lilac bear / 薰衣草杏熊 | Lilac & apricot / 薰衣草杏 | Bear |

The "Paper & companions" picker changes the dashboard, charts and companion seal.
Theme, language and timezone persist in `stateDir/dashboard-preferences.json` outside Git,
including across restarts and port changes. Only these three display fields can be written;
route configuration, receipts and work are unchanged. Unknown theme ids render as `sage`.

Canon remains the folded-ear cat plus the default sage palette. [`brand.mjs`](../integrations/acpx/src/brand.mjs)
owns that vector; `mascots.mjs` references it as the default and fallback without copying or
recolouring it. Page / favicon / share headers use the fixed line product mark from
[`mark.mjs`](../integrations/acpx/src/mark.mjs). The default companion and plugin icon remain
the Canon cat. Both marks have independent SVG downloads.

Untitled historical tasks show their dispatch time and disclose their source in detail,
rather than guessing a title from work-order prose.


## No extra bookkeeping by default

Use ordinary `run`, `continue` and `close`. Counts, elapsed time, completed / failed / cancelled
outcomes and attributable tokens come from existing receipts. No fixed submitted/accepted
annotation is required after each delegation, and history does not need backfilling.
Runtime completion is still distinct from engineering acceptance.

A title and category can accompany the original dispatch:

```sh
node integrations/acpx/src/cli.mjs run --config /absolute/private/routes.json \
  --route registered-worker --cwd /absolute/approved/worktree \
  --file /absolute/work-order.md --title 'Fix empty input handling' --category implementation
```

When a real correction is worth recording, add an optional reason to that continuation,
without creating a separate JSON file:

```sh
node integrations/acpx/src/cli.mjs continue --config /absolute/private/routes.json \
  --session 22222222-2222-4222-8222-222222222222 --file /absolute/rework.md \
  --revision-reason validation_failed
```

This is optional, not a classification step for every continuation. A recording failure warns
without blocking the task. Ordinary continuation is not rework. A successful returned turn
clears the outstanding correction; only an explicit `submitted` requests further review.
Closing ordinary work without an acceptance annotation is a normal end state.

Use standalone `record` when the task itself warrants retained review evidence or a takeover
judgment. Evidence keeps its `coordinator` / `worker` source; worker claims never become
independent coordinator checks. See the [data contract](dispatch-data.md) for event schemas,
reasons and correction rules. No extra model is called to infer or complete review history.

Ask for follow-up on demand, not after every delegation:

```sh
node integrations/acpx/src/cli.mjs pending --config /absolute/private/routes.json
```

This reads local state for execution issues and explicitly outstanding review / revision
requests. Ordinary completion, normal closure and unannotated history do not create a to-do.
The updated `acp-worker` skill follows this default. Source changes do not refresh installed
plugin caches: use the [normal update flow](installation.md#plugin), then start a new main
session to load the new instructions.

## Workload, not savings

Adapter usage is usually cumulative per session: snapshots of 100, 180 and 250 mean 250
tokens, not 530. A bounded period needs attributable deltas. Missing baselines, resets and
unknown values affect coverage and warnings rather than becoming zero. Route medians
describe their own task samples; they do not rank model speed across unmatched tasks.

This is neither billing evidence nor an estimate of Codex quota saved. Dispatch does not
arrange repeated A/B tasks, score models or claim a savings percentage. Recorded reasons
remain the coordinator’s attributed judgments, with work orders and receipts available
for local inspection.

## Share cards

“Share card” previews **1600 × 900** landscape and **1080 × 1350** portrait
artifacts, downloadable as SVG or PNG. Choose Chinese or English independently of the UI language;
Chinese has its own headlines and layout. Each opening of the dialog starts from the dashboard's current
palette and lets you pick a different one for that artifact alone, without recolouring the dashboard;
palette, language and layout stay independent choices. Download filenames combine theme, language, layout
and date (`worker-routing-THEME-LANGUAGE-FORMAT-DATE.ext`), so the four palettes × two languages × two
layouts × SVG/PNG = 32 combinations stay distinguishable. They cover all ACP aggregates in the selected period,
regardless of list filters. Preview and download use the same frozen report.
The task count and woven companion seal form the primary composition; turns, usage and outcomes
follow in separate visual tiers, with the repository address right-aligned. Outcome segments use
exact task proportions without minimum widths; the numeric legend keeps rare outcomes readable.

Personalize the card in the export dialog:

- Start from four bilingual slogans and edit freely. A preset replaces only the selected card language's draft. Up to 80 Unicode characters auto-wrap and shrink to fit; clearing the field hides it.
- Optional shared-by credit accepts up to 32 Unicode characters on one line. Empty credit stays hidden; no account identity is read.
- Choose Soft / Book / Mono numerals, with a smaller default primary count, and hand-drawn Thread / Bloom / None flourishes.
- Both language drafts, credit and styles survive closing and reopening the dialog on this page, and reset on refresh. They are never written to preferences or sent to an API. Each reopening still starts with dashboard language/theme and portrait format.
- Reset words & style restores both default slogans, empty credit, Soft numerals and Thread ornament. Theme, language, format and aggregate data stay as selected. Narrow layouts keep the preview and close control visible while editing.

The statistical allowlist accepts only numeric aggregates, period bounds, IANA timezone and coverage. The
renderer supplies the fixed repository address. Explicit author text uses a separate presentation allowlist
and is escaped as plain text in the image. Work orders, outputs, route names, paths, parent/session IDs and
diagnostics never enter the export payload. The graphic leads with delegated task count, runtime outcomes and usage coverage, without individual work-order trails. Nothing uploads automatically.

Stitched seals, subtle cardstock edges and a folded-ear cat connect the dashboard with its share cards
in all four palettes.

“Copy image caption” includes the current slogan and optional credit, plus the same frozen aggregate, period and timezone as the image. It never reads
project names, task titles or private detail. The export dialog offers separate product-mark and
Canon-cat SVG downloads; theme companions appear in the seal.

The plugin bundles a derived `assets/cat.svg`. After editing the mark, run `npm run brand:sync`
in `integrations/acpx/`; the test suite checks the packaged copy matches.

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
export privacy, HTTP access, preference allowlisting, timezone grouping, project identity and shutdown. Theme checks cover both layouts and languages, preserving
counts, ACP-only scope and the fixed product mark while each theme uses its own palette and companion.
Unknown theme or companion ids fall back to Canon, and both modules are served locally under the page CSP.
Browser acceptance additionally exercises period/search filters, replay, keyboard closure, theme switching
and refresh restore, the dialog's independent theme, all 32 downloads and filenames, desktop/mobile
geometry and keyboard focus. These checks do not verify a real provider’s identity or replace owner acceptance.

Stop the dashboard to remove the presentation layer. Keep receipts and events; restore source
through version control if necessary. No native worker or ACP session needs to be recreated.
