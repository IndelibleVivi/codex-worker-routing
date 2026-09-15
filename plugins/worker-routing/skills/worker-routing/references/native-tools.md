# The current host's native collaboration tools

This page records the host's schema at packaging time and is read only when these tools
are actually used. It is not a cross-host or future-version guarantee; before calling,
follow the schema and return states currently visible. When a tool is missing, stay solo
or use the equivalent capability the host explicitly provides; do not fabricate an
adapter, MCP, hook, or job system.

## Spawning and routing

`collaboration.spawn_agent` currently supports `task_name`, `agent_type`, `model`,
`reasoning_effort`, and `fork_turns`. A new independent work order explicitly sets
`fork_turns: "none"` by default and writes the full smallest-sufficient work order and the
worker-role semantics in the message. Do not claim that this value isolates global or
project instructions, skills, tools, or private instructions attached automatically in
the provider request.

Choose `agent_type`, `model`, or `reasoning_effort` only when the host's live inventory
and the current authorization support it; do not freeze specific model names into this
skill. A task name should distinguish the responsibility, but do not open a new child for
every mechanical step.

The Codex app's `create_thread` creates a new user-visible task and is not used for
internal delegation inside the current task.

## Waiting and increments

- `list_agents` shows the child's actual state; do not guess from an old record that it is still running.
- `wait_agent` waits for a mailbox update. Prefer the host's blocking wait and completion messages: a timeout, silence, or active yield in a healthy run is not a failure and not an interrupt condition; waiting is not cancellation. Query the worker only to recover it, to resolve an ambiguous state, or when intervention is needed, and do not short-poll a healthy worker.
- For a worker that is still active, use `send_message` to send a constraint or evidence increment that affects the current work.
- For continuation or rework of a worker that is not currently running a turn, use `followup_task` directly to trigger the next turn with the same child, context, and responsibility.

## Completion and diagnosis

Do not use `interrupt_agent` as a routine completion ceremony. Use it when an active turn
must stop, or when the live host explicitly requires it for cleanup. Continue a completed
or idle worker with `followup_task`; for an ambiguous or errored state, check `list_agents`
before deciding whether the same child can continue. Before taking over or switching
workers, confirm that the old writer has stopped.

The normal UI may hide spawn metadata. That is presentation, not evidence that no child
exists. For diagnosis, use the live `list_agents` or thread trace. When the current Codex
config schema exposes it, `hide_spawn_agent_metadata = false` under
`[features.multi_agent_v2]` can temporarily make spawn metadata visible; normal delegation
does not depend on keeping that diagnostic setting enabled.
