# Optional ACP execution route

[中文](acp-integration.md) | English

Status: the optional integration is implemented; the public runtime API of
`acpx@0.15.1` has been exercised through a synthetic ACP server. Real adapters,
models, providers, accounts and local context boundaries are still accepted
separately by each operator. The common routing skill honors the operator’s selected
execution channel first; native tools, the SessionStart hook and installer are unchanged.

## What this changes

Main Codex stays responsible for the goal, product judgment, integration and
acceptance. The repository does not prescribe the priority between native and ACP;
temporary provider/model preferences live in operator config outside Git. When a
standing operator default or task selects a registered external ACP route, the `acp-worker` skill
can call `integrations/acpx/src/cli.mjs` and, through `acpx/runtime`, hand one whole
responsibility to an independent coding agent.

The same "investigate → implement → self-check → local rework" responsibility can
span multiple rounds. `run` establishes a session; `continue` uses the original
handle stored in a private directory; between the two commands the adapter process
connection is released while the logical session is kept. This requires the adapter
to support recovering an old session. If recovery fails, stop: do not create a
replacement session and do not implicitly redispatch.

No new planner/tester/reviewer pipeline is introduced, native tools are not wrapped,
and no second planning system is built. A small amount of binding/receipt JSON only
binds an existing acpx session and execution evidence; it does not copy its session
implementation.

## Responsibility boundary: the ACP route does not translate the provider protocol

cwr-acp and acpx own the session, lifecycle, permission answers and execution
evidence; they do not translate the provider's HTTP wire format, and they do not
decide which model client the worker uses. The route's adapter and isolated worker
profile are what determine the actual client/runtime that runs and how it reaches
the provider.

So a route, or a listed model, being able to initialize does not mean real inference
will succeed: Codex custom providers currently send requests in the Responses wire
format, and an upstream that only speaks `/chat/completions` needs a protocol
conversion layer in between. This boundary, an example of a `codex-acp`-style
topology, the layer-by-layer verification ladder and the troubleshooting table are in
[ACP route and provider protocol boundaries](acp-provider-protocols.en.md). That
document only describes the boundary; it is not a core Worker Routing contract and
does not prescribe provider or fallback policy.

## Implementation choices

We choose the public `acpx/runtime` API and pin the top-level dependency to `0.15.1`.
We call `ensureSession`, `startTurn`, `getStatus`, `close` and the public handle
decoder, without reading private modules or parsing ANSI output. The native path keeps
calling host tools directly, to avoid forcing different backends' cancel/close/continue
semantics to be treated as equivalent.

cwr-acp uses a blocking CLI. It has no independent background service; there is no bridge
that wakes main Codex automatically after completion; and it makes no "keeps running
after the terminal closes" promise. The host shell tool's yield/wait is still used
according to host rules. ACP operations for each exact workspace are conservatively
serialized; different worktrees can execute independently only when write surfaces and
shared resources do not overlap. An ordinary busy request is
rejected; no separate acpx queue is rebuilt.

## Files

0.3 adds actual assembly of the shared worker contract, optional delivery sidecars,
finite batches and task-scoped acceptance helpers; 0.4.2 closes the batch consumption
interface: `--start-handle` publishes the batch identity before launch, plain `batch`/
`collect` keep the complete legacy returns, and the optional `--compact` pages a bounded
read while `collect --job` expands one full record from the index. See [Worker delivery and
finite batches](worker-delivery.en.md) for operations and evidence boundaries. Ordinary
single responsibilities keep the commands below without a report schema or Dispatch.
Historical acceptance sections retain their respective dates and versions.

- `src/cli.mjs`: commands, private environment assembly, mutual exclusion, cancel
  control and exit codes.
- `src/config.mjs`: explicitly named routes, argument and authorization validation,
  isolated worker home.
- `src/engine.mjs`: public runtime integration, same-session checks, results and cleanup.
- `src/state.mjs`: a small amount of private binding/receipt, atomic writes, path and
  file-type checks.
- `src/delivery.mjs`: bounded delivery collection and identity validation; reports
  remain separate from runtime facts.
- `src/batch.mjs`: finite independent CLI subprocesses, batch-local admission, a pre-launch
  batch handle and a byte-bounded compact read; the complete legacy terminal stays the default.
- `src/verify.mjs`: coordinator-confirmed argv checks, task environments, budgets and
  evidence freshness; it never executes commands from a report.
- `test/*.test.mjs`: integration-layer tests that run without dependencies; the runtime
  uses explicitly marked contract doubles.
- `test/real-acpx.integration.mjs`: an integration test that actually loads the acpx
  package and starts a synthetic ACP child process.
- `test/fixture-acp-agent.mjs`: an ACP fixture with no model, no account and no network.
- `plugins/worker-routing/skills/acp-worker/SKILL.md`: the external-route entry
  point for a standing operator ACP choice or an explicit task selection.

## Installation and one-time setup

In the canonical source checkout:

```sh
cd integrations/acpx
npm ci --ignore-scripts
npm run check
npm run test:acpx
node src/cli.mjs --help
```

The target systems are macOS, Linux, and Windows on a local fixed volume. Node.js at
least 22.13. The repository keeps a verified `package-lock.json`; installation uses
`npm ci` to reproduce that dependency graph. Any top-level acpx version deviating from
0.15.1 is rejected by the entry point; upgrading requires re-running the integration
test.

Configuration lives outside Git, with file mode 0600. See `examples/routes.example.json`.
The example is disabled by default and all paths are synthetic placeholders. They must be
replaced with real absolute paths; the CLI is not installed automatically at runtime.
Update/reinstall worker-routing through the original plugin-creator normally, registering
the canonical CLI and config paths. Do not modify the plugin cache, and do not add new
responsibilities to the automatic hook.

A route contains:

- The `argv` array of an installed adapter, e.g. `kimi acp` for some separate Kimi Code
  instance.
- A separate `workerHome`, separated from the main user HOME; `contextRevision`
  identifies the reviewed engineering configuration.
- Explicitly authorized `workspaces`; the cwd must exactly match one of these directories.
- `passEnv`, listing the names of credential or proxy variables actively allowed through.
  Empty by default; no files are copied from the original account directory.
- `maxPermissions` is `read` or `full`; `sessionOptions.model` is optional.

First build a clean engineering profile, then authenticate within that profile in the way
the original CLI supports. An instance using a personal persona profile, main-session
memory or private hooks is not directly usable as a temporary worker. Configuration
existing does not mean input isolation has been proven; it must be sampled and verified
locally. `contextRevision` must be updated after the config/tool/instruction injection
boundary changes.

## Windows support boundary

Windows is the third supported platform, but only declares capabilities that are
implemented and regressible. It is not a POSIX assumption swapped for a
`process.platform` check: the entry point first applies a platform allowlist before
reading config, then relies only on what Node actually exposes.

- The entry point must be a real file with the extension `.exe`, `.com`, `.cmd` or
  `.bat`; `.ps1`, `.sh` and extensionless scripts are rejected. `.cmd`/`.bat` are
  launched via acpx's own `%COMSPEC%` shim policy; cwr-acp introduces no `shell:true`
  fallback and does not accept a string-form command.
- Only local volumes are supported: `stateDir`, `workerHome`, `workspaces`, the selected
  `cwd`, resolved `argv[0]` and the config file path are first rejected lexically for UNC
  (`\\server\share`), device paths (`\\?\`, `\\.\`) and network-share forms, and the same
  rejection is repeated for the canonicalize/`realpath` final target. The config file path
  is first resolved to an absolute path relative to the cwd (relative-path behavior is
  unchanged), and this rejection layer completes before `realpath`, so an explicit
  UNC/device config root is never touched by `realpath`; it only canonicalizes the
  containing directory, and the filename itself is still subject to the symlink check.
  Thus a locally shaped input that resolves to these roots (e.g. a symlink/junction
  pointing at UNC) is also rejected before real use. A drive letter mapped to a network
  location cannot be recognized at this layer and must be guaranteed by the operator.
- The worker environment redirects `HOME`/`USERPROFILE`/`TEMP`/`TMP`/`APPDATA`/
  `LOCALAPPDATA` to the separate worker home, and preserves `COMSPEC`, `PATHEXT`,
  `SystemRoot`/`windir` from the operator environment (falling back to standard values
  when missing), because launching child processes and acpx command resolution need them;
  these variables come from the environment rather than route config and contain no
  credentials.
- passEnv environment names are validated and preserved case-insensitively on Windows;
  spellings such as `home`, `userprofile`, `path`, `comspec`, `appdata` are likewise
  rejected and do not override the worker home's `USERPROFILE`.
- Windows has no POSIX mode bits; Node reports synthetic values such as 0666/0444. cwr-acp
  on Windows neither reads nor verifies NTFS ACLs, nor checks whether stateDir/workerHome
  are under the user profile; it still rejects symlink/junction and hardlink, and keeps
  the "compare file identity after opening" check. The operator must therefore place the
  private config, stateDir and workerHome in an ACL-controlled current-user location (or
  establish an equivalent ACL for them); cwr-acp does not implement or claim this
  guarantee, and does not refuse to start because a location is non-compliant. These
  paths must also be on a local volume (see above): a drive letter mapped to a network
  location cannot be recognized at this layer and can only be guaranteed by the operator.
- On Windows Node reports `dev` as 0 for a path `lstat`, while the open-handle stat of the
  same file returns the real volume id. cwr-acp always requires the two file ids (`ino`)
  to match; it compares the volume id only when both sides report a non-zero `dev`. This
  keeps the post-open file identity check and does not misjudge every normal Windows file
  as replaced.
- Directory fsync is unavailable on Windows (Node does not expose a reliable directory
  handle fsync). `atomicJSON` still uses a same-directory temp file, file fsync and atomic
  rename, but no longer claims a directory-level durability barrier; `close` still requires
  cleanup confirmed. If the replacement rename returns `EPERM` on Windows, it retries
  the same complete temp file up to five times with bounded backoff, revalidating the
  destination and its ancestors before each retry. It never deletes the destination
  to force replacement. Persistent denial still fails the write and closes batch
  admission; other errors and POSIX writes are not retried.
- Only SIGINT (Ctrl+C) is a native signal on Windows; SIGTERM produces no native event.
  Cancellation is still available through `cancel`'s native control mailbox.
- Managed ancestor traversal is expanded "relative to its own root", so drive letters and
  UNC prefixes are not concatenated twice; `status`/`cancel`/`close` can also use an
  existing state directory on Windows with `create:false`.
- CI runs the same `npm ci --ignore-scripts`, `npm run check` and `npm run test:acpx` on
  `windows-latest` as on macOS/Linux, with the real acpx synthetic fixture suite running
  there; Windows-specific regressions do not use skip counts as evidence.

## Local Dispatch projection

`stats` provides text / JSON statistics, `dashboard` opens the loopback panel (business
data read-only, three local display preferences savable), `record` appends
source-attributed submission, revision, acceptance and takeover events on demand, and
`pending` lists still-actionable review records on demand. Runtime receipts remain the
source of truth for execution, and collaboration events do not modify the receipt's
`task_acceptance: unverified`. Statistics are light and observational: runtime facts are
derived automatically from existing receipts, and ordinary completion or normal closure
**requires** no annotation and is not an outstanding review obligation. A new dispatch may
provide a title/category; an available main-session ID is kept only in local private state
before the environment is scrubbed and is not passed to the worker. New run / continue work
orders also stay in private state, available for local replay on demand; they never enter
public shares. Reading history and collaboration events does not require the adapter,
worker home or original workspace to still be available. The project entry point looks up
local Git / folders by binding.cwd, and shows the saved path and limitation when a
directory is unavailable; it does not claim Codex project identity. Dates are bucketed by
the selected time zone; the CLI accepts `stats --time-zone IANA_ZONE`. Current acpx only
exposes runtime error codes and cannot confirm a provider HTTP 429 or internal retries;
details provide the same-source structured trail. These commands do not load the adapter;
`stats` and `pending` only read local private state, while `record` appends an optional
collaboration event without rewriting a runtime receipt. The projection derives a mutually
exclusive `review_state` per responsibility (`summary.review` gives the count per state);
an unregistered legacy responsibility is `legacy_untracked`, merely quiet history. See
[Dispatch](dispatch.en.md) for complete operations and the [data contract](dispatch-data.md)
for data semantics.

## Defaults and fallbacks

One default worker is a complete setup. Add this optional fragment at the top level
of the existing private config. `default` names a registered entry in `routes`;
`fallbacks` may be omitted or empty:

```json
{
  "routing": { "default": "kimi-worker", "fallbacks": [] }
}
```

Ordinary `run` omits `--route` and reads the current default in that same call. There
is no discovery command, catalog scan or record-writing step. Legacy configs retain
explicit `--route NAME`; an explicit selection uses only that route, without automatic
fallback. Names, models, channels, credentials and temporary preferences stay local.
An optional experience note fits in existing operator instructions; no worker catalog,
specialty schema or subscription expiry date is required.

`fallbacks` is advance authorization for those actual channels, task data and costs,
not a history of previously used routes. Automatic selection happens only before
adapter launch, runtime import and worker home/state writes: if the default executable
is missing/unlaunchable, or a required `passEnv` credential is absent, try authorized
backups in order, at most once each. Permission, workspace, `enabled: false`, unsafe
config, lock, work-order and dependency failures, and all failures after startup, do
not trigger this switch. The selected route still satisfies every existing check.
Skipped candidates create no phantom responsibility or turn; local receipts retain
the actual choice and bounded skip codes, without environment values or policy data
entering the aggregate share.

Change `routing.default` for new work and keep backup choices in the same location.
Policy changes do not change existing session execution identities; `continue` returns to
the original worker. To stop using an old channel, also set that route's `enabled`
to `false`, denying subsequent runs and continuations. This does not terminate an
already active turn; coordinate its stop through the original session. Status/cancel/
close remain available for recovery. Changing defaults needs no skill/cache edit or
second preference copy in SessionStart. Native defaults remain with the host and
existing local authorization; this ACP config does not execute native workers.

After initialization or execution starts, the coordinator checks the original
receipt/status, confirms the writer has stopped and inspects its work before handing
the remainder to an authorized backup. Never replay an ambiguous write order. Quality
failures use same-worker rework. Reuse an unchanged known availability failure within
the current task; without a backup, finish directly when the task permits it. Runtime
codes do not prove subscription expiry, exhausted credit or HTTP 429.

An unused route's missing entry, credential or workspace does not block an available
default. Configuration safety boundaries remain validated across routes; the selected
cwd must exist and exactly match that route's workspace allowlist.

## Everyday usage

The install-directory variables are for display only; use the registered absolute paths
in practice.

```sh
ENTRY=/absolute/canonical/repo/integrations/acpx/src/cli.mjs
CONFIG=/absolute/private/routes.json

# With routing.default configured; legacy config or an explicit channel uses --route NAME
node "$ENTRY" run --config "$CONFIG" \
  --cwd /absolute/approved/worktree --file /absolute/work-order.md --permissions read

# Get session_id from the receipt; add conditions to the same worker
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/increment.md --permissions read

# Explicit rework (optional shortcut): record the reason for this correction, then continue; ordinary continuation needs no annotation
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/rework-order.md --permissions read --revision-reason requirement_missed

# Use only when both the route and the current task are authorized; this approves all ACP permission requests
node "$ENTRY" continue --config "$CONFIG" --session UUID \
  --file /absolute/implementation-order.md --permissions full

node "$ENTRY" status --config "$CONFIG" --session UUID
node "$ENTRY" cancel --config "$CONFIG" --session UUID

# View still-actionable review records on demand (read-only; excludes legacy history and loads no adapter)
node "$ENTRY" pending --config "$CONFIG"

# A normal close is ordinary lifecycle completion; it needs no annotation and does not mean accepted
node "$ENTRY" close --config "$CONFIG" --session UUID

# Only when review evidence really needs to be retained, use the standalone record to append an explicit event
node "$ENTRY" record --config "$CONFIG" --session UUID --file /absolute/event.json
```

`cancel` writes a cancellation request corresponding to the current operation nonce, and
the running process checks the local control mailbox every 200ms. It is a local control
implementation and does not require the main model to repeatedly read worker state. A
`stopped:false` in the receipt explicitly means only that the request is confirmed sent;
wait for the execution command to return a terminal state and cleanup result. Ctrl+C and
SIGTERM also request cooperative cancellation. `close` closes a work responsibility and
preserves history; it refuses to close while active or cleanup is unconfirmed. `close` is
ordinary lifecycle completion and needs no acceptance annotation. `continue
--revision-reason` is an optional rework shortcut: the reason is validated in the ordinary
preflight, a write failure does not block an authorized task and is only surfaced through
the existing additive `dispatch_warning`, and no model is called again. Day to day you
only need run/continue/close, with nothing to record after each dispatch.

Exit codes: 0 means the runtime turn completed and cleanup is confirmed; 1 means execution
failed or cleanup is unconfirmed; 130 means cancelled; 2 means a local
config/precondition/control error. Even on exit 0, `task_acceptance` is always
`unverified`; main Codex must check the diff, key invariants and test evidence.

## State, context and security boundaries

stateDir holds the binding/receipt, Dispatch's local collaboration events and work orders,
the three display preferences (`dashboard-preferences.json`), and acpx's private store.
Directory 0700, files 0600; writes use a same-directory temp file, fsync and atomic
rename. Input rejects symlinks, hardlinks, FIFOs and other special files. The
workerHome/stateDir root may use the canonical path of a system ancestor directory, but
the root itself and managed descendants do not accept symlinks. The 0700 directory / 0600
file assertions hold only on platforms that expose POSIX mode; on Windows mode is not
privacy evidence, and the privacy boundary is in the section above. These checks reduce
damage from accidental links/races and do not constitute complete filesystem isolation
against a malicious same-UID process.

The CLI clears its own environment before importing acpx; it keeps PATH and a fixed
locale, resets HOME/XDG/CODEX_HOME/CLAUDE_CONFIG_DIR/TMPDIR, and passes through only
variables explicitly named by passEnv. The host shell and Codex environment are not
changed. On Windows it additionally resets TEMP/TMP/APPDATA/LOCALAPPDATA and preserves
COMSPEC/PATHEXT/SystemRoot. HOME separation does not restrict absolute-path access,
Keychain, or the original CLI's own native tools. Project AGENTS, agent built-in config
and local tools must also be accepted against the real profile.

Every `run` and `continue` must explicitly pass `--permissions read|full`. Omission
is rejected with `PERMISSIONS_REQUIRED` before adapter launch, prompt submission or
private-state mutation. There is no default read mode or inheritance from the previous
turn. `--category implementation` is metadata, not authorization. The coordinator supplies
the flag from current task authority; an investigation-to-implementation transition updates
both the work order and the mode, without asking for already-granted authorization again.
Status/cancel/close and stats/dashboard/record/pending do not require the flag.

`--permissions` selects cwr-acp's answer policy for ACP permission requests, not a
filesystem boundary: `read` uses approve-reads + non-interactive deny, and `full` uses
approve-all (which may include execution/network requests). Both constrain only requests
that actually reach the adapter permission flow. An adapter may expose operations that
produce no ACP permission request; in actual use an external worker under `read` has been
observed directly rewriting files without being rejected. So `read`'s "must not modify
files" is only work-order authorization wording, not enforcement. To get deterministic
filesystem read-only behavior, you must independently configure a host/OS sandbox locally
or use a disposable read-only environment; cwr-acp does not provide that boundary, does
not claim process-level network isolation, and does not claim that every adapter's every
native tool goes through the same permission mechanism.

Continuation checks the versioned `executionIdentity`, fixed cwd, saved
acpxRecordId/acpSessionId, argv and persistent handle. `cwr.acp.execution-identity/1`
includes the route, canonical executable and its hash, arguments, workerHome, environment
declarations, contextRevision and explicit model choice. It excludes the workspace list,
permission ceiling and timeoutMs. Every continuation still rechecks route enabled state,
current allowlist membership of the bound cwd and the requested permission ceiling. Adding
or reordering unrelated workspaces or changing the task budget does not invalidate the new
identity; revoking the cwd or full permission blocks the corresponding continuation. The
entry-point hash does not cover transitive dependencies or arbitrary profile files; profile
changes must update the revision.

A legacy binding only has `routeFingerprint`, without separate evidence of its original
identity. It migrates under lock only if the complete original fingerprint algorithm still
matches and current authorization passes. A mismatch stops with `ROUTE_CHANGED`: do not
guess that only an allowlist changed or blindly rewrite the hash. Do not restore revoked
authority to make migration pass. Keep the old session available for status/cancel/close,
inspect existing work and authorize the remaining responsibility separately. Historical
receipts remain unchanged. When a model is explicitly specified, it must match the
adapter's currently advertised model before the work order is sent; otherwise the work order
is not sent. This check does not authenticate the actual upstream model; provider identity
is still marked unverified. Credential values are not persisted and are not proof of identity
authenticity. The model/usage in records is only what the adapter reports.

The main session receives no thought and no raw tool payload; stdout output is at most an
8192 UTF-16 code-unit body-tail excerpt plus the evidence location. The full history is kept
by acpx. Large output is marked truncated; a timeout/stream error is not hidden by a final
success message. Raw agent error text is not written directly into the structured error
receipt; when diagnosis is needed it is written to a separate private diagnostic file and
the receipt gives only the path. That file may contain provider-sensitive content and must
be checked before sharing.

The workspace lock only coordinates the exact cwd among ACP commands sharing this
stateDir; overlapping writes from different cwd values do not automatically conflict.
Cross-project work orders must name the execution cwd, additional read roots, allowed write
roots and shared resources. These declarations do not grant host capabilities. On a missing
permission or tool, stop the affected operation and return partial work plus the concrete
gap; the coordinator may repair the environment within authority or narrow/split remaining
work, without broadening a parent-root allowlist or bypassing a denial. The lock cannot see
native workers, other installations, databases, ports, services or other shared resources.
The host must still obey one writer per overlapping write surface, or use a separate
worktree; a worktree itself also does not isolate the non-file resources above.

## Crashes and failures

Initialization and prompt submission each have a setup deadline of
`min(route.timeoutMs, 30000)` milliseconds, reported as `INIT_TIMEOUT` or
`PROMPT_SETUP_TIMEOUT` respectively. The task budget of `route.timeoutMs` starts at the
public runtime's `promptStarted` acknowledgement that the transport accepted the prompt,
and runs through canonical `result`, including runtime finalization. This is a hard deadline
for the whole turn; text/tool/status events never reset or extend it. Connection setup does
not consume that task budget. Receipt `budget` retains `setup_ms`, `task_ms`,
`prompt_started_at`, `task_deadline_at` and `task_elapsed_ms`. Elapsed time uses a monotonic
clock from prompt acknowledgement through the canonical result or task interruption,
excluding later stream drain/cleanup. The last three fields are null when no prompt
acknowledgement was observed; this does not prove the prompt was never sent.

Receipt `activity` freezes at the terminal decision, before cancellation and cleanup. It
retains only `observed_at`, `event_count`, `first_event_at`, `last_event_at`, a fixed
`last_event_type` enum and `last_event_age_ms`. Types are `text_delta`, `status`, `tool_call`,
`done`, `error` or `other`; event timestamps, type and age are null when no event was seen.
No prompt, thought, tool payload, name, path or free text is retained. Age is the monotonic
gap from the last observed event to that snapshot, not to a later status query.
`activity.event_count` counts events at the snapshot; the existing `observed_event_count`
still counts everything consumed before observation stops, including possible later cleanup
events. These fields distinguish events near the hard deadline from a long observation gap.
Events do not prove useful progress, an event gap does not prove a stopped writer, and
neither is used to infer a provider root cause.

CWR uses public `startTurn({timeoutMs: 0})` to disable the pinned acpx version's internal
prompt RPC timer and owns the task deadline itself. This prevents internal recovery from
turning progress without an RPC final into `end_turn`. The zero-value behavior depends on
the pinned version and must be checked with the real package and a synthetic adapter when
upgrading the dependency. Product code imports no private acpx modules.

A timeout or operator cancellation fixes the failed/cancelled outcome before cleanup;
a late completed/end_turn result cannot overwrite it. `TURN_TIMEOUT` never exits 0, and
partial output remains available. Event drain, cancel acknowledgement, turn settlement and
connection close each have an 8-second default cleanup bound; they do not extend an ended
task budget. Cleanup is reported separately; success text cannot erase unknown/unconfirmed
cleanup. Historical receipts are not recalculated.
 Cancelling initialization does not mean the underlying handshake has
exited; when cleanup cannot be confirmed through the interface, the lock and an uncertain
state are kept. After startup there is no automatic retry or silent native/ACP fallback;
limited preflight selection is described in [defaults and fallbacks](#defaults-and-fallbacks). When a
receipt is lost after submission, check status and the saved receipt first. Do not "confirm"
by re-sending the same write work order. A normal stop and a code failure attempt to close
ACP-owned connections; a cleanup failure, unresolved initialization, an observed active
adapter, or a directly dead process keeps the lock.

Status reads local state only. `last_receipt` / `last_runtime_status` / `last_error_code` come
from a valid receipt. If the receipt was persisted but the final binding update was
interrupted, status first reads the exact request id and start time in `active_turn`, then
checks the existing binding receipt pointer. Both must match the session, route, saved
handle identity and the receipt's own path. Foreign/stale/malformed or unsafe files never
become execution evidence. Without a valid pointer these values remain null; status never
scans for a guessed latest receipt. `receipt_evidence.source` identifies `active_turn` or
`binding`, with the request id, `reported_cleanup` and allowlisted `budget` / `activity`.
Fields absent from old receipts remain null; historical receipts are never rewritten.
`active_request` separately shows the binding's current request id, start time and matching
runtime status, error code and receipt; the last three are null without a receipt for that
turn. An earlier completed receipt may remain historical `last_*` evidence and can never
become the completion outcome of a newer active request.

This display recovery does not repair the binding, reclaim a lock or confirm that the
writer stopped. Top-level `cleanup` comes independently from the binding and remains
`unconfirmed` while `active_turn` exists, even if the receipt reported confirmed cleanup.
`receipt_evidence.reported_cleanup` is only the cleanup outcome recorded at receipt time
and grants no control authority. `owner_process_present` only means the PID probe hit; it
is not proof of that PID's identity or model health. A stale lock is not automatically
reclaimed, to avoid double-writes from PID reuse/leftover writers.

Exception recovery is done by the local operator checking owner.json, the session receipt,
the current adapter process and the actual diff. Only after confirming the old writer has
terminated remove the corresponding operation lock and workspace lock; keep the binding and
acpx store. cwr-acp does not implement an automatic recoverer, and in particular a dead PID must
not be treated as proof that all descendants have exited. Cleanup only confirms acpx-owned
processes/connections; it does not guarantee that a malicious daemonized or otherwise
host-detached descendant has been terminated.
After reconciling stopped writers and inspecting existing work, the coordinator explicitly
authorizes the remaining responsibility through `continue --permissions read|full`. A hard
deadline never renews itself, replays the original order or triggers post-launch fallback.

## Acceptance gate

### Layered Delivery 0.3.0 acceptance (2026-10-13)

Source `18a62f9` passed all five [CI jobs](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/38415570521).
Ubuntu/macOS check: 337 pass + 4 Windows-only skips. Windows: 340 pass + 1 POSIX-only
helper skip. Real acpx synthetic integration: 14 pass + 2 Windows-only skips on the
first two platforms, 16 pass on Windows. acpx stays pinned at 0.15.1; no new production dependency.

The local plugin was formally installed/enabled at 0.3.0, with exact canonical-source
parity for all 15 packaged files. A fresh independent root began from a natural
“delegate this” request, read the installed short entries, and selected the current
configured ACP default with explicit full permission on its first responsibility.
No CLI template or session was seeded; Dispatch/recovery/swarm was not loaded.
The worker repaired the module, the original test file stayed byte-identical, independent
checks passed, and the responsibility closed with history retained.

Other controlled cases cover self-repair/already-correct input, a precise question
followed by a same-session increment, stopping on missing capability, handback after
a coordinator policy edit, independent cancellation and restart continuation of two
real adapter sessions, and a three-item investigation with peer synthesis. The merger
preserved duplicate identity, version distinctions, counterevidence and unknowns from
inaccessible sources. Missing report identity led only to delivery repair in a new
request, preserving the original failure; runtime completion never became acceptance.

These observations do not establish universal model/provider/permission reliability.
Shared-HOME capability covers the pertinent adapter/profile under controlled conditions.
The 0.2 controls also completed small repairs, so no speed or success-rate improvement
is claimed. Outer feedback remains test-only; evidence does not promote it to a default.

The 2026-10-13 Recovery 0.2.0 source passed the complete `npm run check` on macOS
(280 tests: 276 pass, 4 Windows-only skips). Subsequent changes only isolated the
synthetic fixture and repaired failed-test teardown; all 4 fixture checks passed.
The final complete `npm run test:acpx` passed 12 tests (10 pass, 2 Windows-only skips),
covering normal completion, progress without a final, end_turn after cancellation,
and a 2-second inherited runtime timer versus a 6-second CWR task budget. This checks
the pinned public API, not real-provider health, old receipts or skill loading in an
existing chat. Cross-platform status belongs to the corresponding commit's CI.

On the same day, a real operator-configured ACP responsibility completed a read-only inspection
with explicit `--permissions read`, then continued public documentation edits in the same
session with explicit `--permissions full`. Both rounds returned complete final reports with
runtime `completed/end_turn` and cleanup `confirmed`; the coordinator checked runtime/cleanup,
the documentation diff, bilingual agreement, relative links and `git diff --check`. This local
acceptance applies only to the configured channel exercised here: permission-response policy
is not an OS sandbox and does not establish other adapter/provider/account behavior, provider
identity or general reliability. A fresh CLI root read the installed 0.2.0 routing instructions
and correctly continued the original ACP responsibility. After acceptance, normal close
reported idle/closed with history retained.

The 2026-09-21 default/fallback source update passed 256 integration checks on macOS
(252 pass, 4 Windows-only skips) and 8 real-acpx plus synthetic-ACP-server checks
(6 pass, 2 Windows-only skips). Coverage includes omitted defaults, explicit choices,
bounded fallbacks, existing-session compatibility, revocation and no post-launch
redispatch. This does not establish an updated installed plugin, live provider or
local default config. Cross-platform results belong to the corresponding commit's CI.

Separate local installation and live-route acceptance followed that day: the formally
reinstalled plugin matched canonical source, and a real run without `--route` used
the default channel and completed. A separate private candidate config simulated a
missing default entry; the live run selected only the authorized backup and completed,
retaining the `BAD_EXECUTABLE` skip reason. Both cleanups were confirmed and sessions
closed normally, without fault injection into the everyday config. This proves those
tested default/fallback paths, not other providers, plan status or automatic recovery
after startup.

On 2026-09-20, the Dispatch v3 project entry point and display integration re-ran
`npm ci --ignore-scripts`, `npm run check` and `npm run test:acpx` on the canonical macOS
host: the integration-layer checks numbered 223 items, 219 pass and 4 Windows-only skips;
the real acpx + synthetic ACP server integration numbered 6 items, 4 pass and 2 Windows-only
skips. They cover local state/path boundaries, same-session continuation, the permission
handshake, cancellation and cleanup, and Dispatch's accounting, proactive review state,
optional revision-annotation failure not blocking, binding recheck after holding a lock,
loopback/privacy, the bilingual share allowlist, the four animal themes, cross-timezone
bucketing, real-directory grouping and preference persistence. The dashboard was additionally
verified in real desktop and narrow-viewport browsers for the statistics home, filters,
detail, theme switching, keyboard focus, and all 32 real download combinations of four
themes × two languages × landscape/portrait × SVG/PNG.

The integration test uses a synthetic adapter process with no model, no account and no
network; it cannot prove a real provider's identity, billing or quality. The synthetic
cancellation case waits for an audit file to prove the prompt reached the adapter, then
issues cancel and asserts `cancelled`, `cleanup=confirmed` and a subsequent `idle`. This
delivery did not modify Python/native hook source and did not re-run the native context
probe; the previous 25 Python regressions and real root/child input-boundary evidence belong
to their own historical acceptance.

Windows-specific cases (drive-letter root `create:false`, junction-ancestor rejection, UNC
stateDir rejection, explicit UNC/device config file path rejected before `realpath`, adapter
environment assertions, a full `run` of the `.cmd` batch shim) run and assert only on
`windows-latest`, and do not use another platform's skip as evidence; the junction case has
no built-in skip branch, and an environment that cannot create a junction fails outright
rather than skipping. The POSIX mode assertion is likewise not treated as evidence of Windows
ACL privacy.

An earlier local dogfood used one registered external route to complete a review fix of this
repository and, in the same ACP session, continue with evidence correction and permission
wording rework; every round's cleanup was confirmed and the private main-session marker search
was 0. One `read` continuation nevertheless directly rewrote documentation, and this
counterexample is exactly the evidence above that the permission-response policy cannot be
treated as a filesystem boundary. The opt-in Python/native probe was not re-run in this
delivery; native source was unchanged and the existing Python regressions pass, but these
facts do not impersonate new native-process acceptance.

CI: the repository adds `.github/workflows/ci.yml`, running the Python native tests on Ubuntu,
and `npm ci --ignore-scripts`, the ACP checks and the real synthetic acpx integration on Ubuntu
and macOS; after adding Windows, the same ACP steps also run on `windows-latest`, and Windows
PowerShell 5.1 actually executes the `UTF8Encoding($false)` form used by the native picker
guide, asserting the output has no UTF-8 BOM and still parses as JSON. No secrets, no live
provider calls. This delivery was written and self-tested on a macOS host and was not run on a
local Windows host; Windows conclusions are subject to the target commit or PR's
`windows-latest` checks, and local results do not prove any GitHub run is green. Real Windows
adapter/model acceptance still requires the operator to complete it separately per exact route.

Before adopting this into everyday delegation, the operator must still verify input,
provider/model and permission boundaries per exact adapter/profile; when read-only must be
enforced, a host/OS sandbox or disposable read-only environment must be configured separately.
Acceptance of one route cannot be extrapolated to other adapters, nor does it change the
native route.

## Upstream references

Reviewed on 2026-09-15, against the `v0.15.1` public source interface of `openclaw/acpx`:

- `src/runtime/public/contract.ts`: startTurn's events/result, permission and lifecycle
  interfaces.
- `src/runtime.ts`: public runtime/store and handle decoder exports.
- `src/runtime/engine/manager.ts`: persistent recovery, saving handles, connection cleanup
  and the boundary for retaining sessions.
- `src/runtime/engine/reuse-policy.ts`: session reuse conditions.
- `src/acp/client-process.ts`: argv identity.

Source addresses take the form `https://github.com/openclaw/acpx/blob/v0.15.1/<path>`. This
implementation calls the public API it relies on and does not copy upstream engine code.
The acpx dependency retains its own license; new integrations/plugins code follows
SUL-1.0 in the root `LICENSING.md`, and this document follows its documentation license.
