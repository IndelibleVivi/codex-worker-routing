# Input boundaries and verification

[中文](context.md) | English

`fork_turns="none"` excludes the parent conversation history; it does not replace
user-level or project AGENTS. Role instructions or a higher-priority AGENTS file
do not make earlier text disappear from the provider request.

This integration keeps private main-session instructions outside ordinary AGENTS
discovery and injects them into the root through SessionStart. A new temporary
child work order does not inherit the parent conversation, so it does not copy
that root context. The main agent protects the work order; workers stay within
the engineering scope they are allowed to read and change.

The native synthetic probe uses a real Codex process and a local model-protocol
fixture. It checks that long text reaches the first root request, engineering
rules reach the child, private root and simulated-recall markers do not reach
the child, follow-ups to the same child preserve the boundary, and both
completion signals receive an interrupt.

Verify separately: files/configuration exist; the plugin is installed and
enabled; the hook is trusted; the root receives the full input; child input
boundaries hold; the selected provider actually executes; and the ordinary
main-session experience works for the user.

Check existing recall, project hooks, tool instructions and other input layers
in the actual environment. Simulated recall verifies event routing, not the
business behavior of a real memory service. File permissions belong to the
host; this mechanism does not prevent a process with authorized file tools from
reading other local files.

The source supplies no account configuration, tokens, proxy or paid route.
Before using an external model, confirm that the actual attached context fits
the task's authorization, then verify it with a bounded engineering task.
