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
- For continuation or rework of an idle worker, use `followup_task` to trigger the next turn, keeping the same child's context and responsibility.

## This host's wrap-up rules

In this host version, once a child reaches `FINAL_ANSWER`, `task_complete`, `idle`, or
`errored`, call `interrupt_agent` first to wrap up its state; afterwards, for continuation
or rework, call `followup_task` on the same child. Do not interrupt a working child
because a healthy wait timed out, went silent, or simply took time.

When a tool return is ambiguous, use `list_agents` to verify the existing child first, so
you do not duplicate the same responsibility. Before taking over or switching workers,
also confirm the old worker has stopped writing.
