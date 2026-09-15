---
name: acp-worker
description: Run or continue an explicitly named, operator-enabled external ACP coding-agent route using the optional cwr-acp integration. Trigger only when the user requests that external route or has already configured explicit ACP routing for this responsibility. Ordinary delegation, native Codex subagents, or merely seeing an ACP-capable CLI do not activate this skill.
---

# Optional external ACP worker

This skill does not choose a default provider or route. That preference belongs in
operator-owned configuration outside the plugin and may change with the operator's
current subscriptions. Native Codex workers keep their existing collaboration tools;
do not wrap them in this CLI, switch the main model, or treat one route's failure as
authorization to launch another. An ACP worker is a separate agent session, not a
native Codex child or a new user-visible Codex task.

Use the same complete responsibility, minimal sufficient work order, engineering
constraints, same-worker rework, and coordinator acceptance rules as worker-routing.
An external worker may not delegate again. Inspect the real diff and evidence before
accepting its result; `runtime_status=completed` is not engineering acceptance.

## Availability and authorization

Use only an operator-registered canonical integration entrypoint and config path.
The executable is `integrations/acpx/src/cli.mjs` in the canonical source checkout,
or its locally installed `cwr-acp` bin. Do not infer this path from the plugin cache.
Read `docs/acp-integration.md` in that checkout for installation and limits.

The optional runtime must already be installed and its local ACP fixture tests must
have passed. Do not install packages, import private main-session instructions,
reuse personal agent profiles, copy credentials, change enabled routes, or authorize
new data transfer just to make this skill available. Report the specific missing
prerequisite and keep the existing native route available.

## Commands

Use the trusted, operator-supplied paths in place of ENTRY and CONFIG:

```sh
node ENTRY run --config CONFIG --route NAME --cwd WORKSPACE --file ORDER
node ENTRY continue --config CONFIG --session UUID --file INCREMENT
node ENTRY status --config CONFIG --session UUID
node ENTRY cancel --config CONFIG --session UUID
node ENTRY close --config CONFIG --session UUID
```

`run` creates an independent responsibility. Keep its returned integration UUID.
`continue` resumes that exact conversation; it cannot silently create a fresh one.
`--permissions` selects this integration's ACP permission-response policy, not a
filesystem boundary. The default `read` answers requests with approve-reads plus
non-interactive denial; `full` uses approve-all, which answers ACP permission
requests including execution and network requests. Both cover only requests that
actually reach the adapter's permission flow: an adapter can expose operations that
never raise one, so never claim `read` prevents writes or describe the policy as an
OS sandbox. Deterministic filesystem read-only behavior needs a host/OS sandbox or
a disposable read-only environment configured independently of this integration;
cwr-acp does not provide that boundary. `full` additionally requires a route that
permits full mode and current task authorization, and its authority still comes
from the work order and the current task.

Only the small work order is intentionally handed over. Registered environments,
agent homes and shared repository rules still require real input-boundary review.
Use a separate worktree or coordinate non-overlapping writers explicitly. The
integration's workspace lock cannot see native workers, other installations,
ports, databases, services, or external shared resources.

## Wait, cancel, continue, accept

The CLI blocks until its turn result and owned-connection cleanup. Use the host's
normal shell execution/wait semantics. Do not short-poll a healthy worker, restart
it because the shell tool yielded, or promise an automatic background wakeup.

`cancel` only acknowledges a cancellation request. Wait for the running command's
terminal result and cleanup before taking over. A lost reply is ambiguous: use
`status` and the recorded receipt before considering a retry. Keep unconfirmed
cleanup/stale locks for explicit reconciliation; never auto-delete them.

The CLI prints a bounded output excerpt plus an evidence pointer. Detailed tool
and conversation state stays in the private local acpx store. Missing usage stays
unknown. Advertised model/usage fields are adapter reports, not billing evidence or
proof of provider identity. Continue the same session for authorized implementation
and rework. Close the responsibility after acceptance; closing does not delete history.
