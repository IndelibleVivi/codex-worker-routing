# Installation, switching and recovery

[中文](installation.md) | English

The routing plugin and main-session context integration are separate installation
surfaces. Install only the plugin if you only need delegation policy.

## Plugin

Use Codex's built-in plugin-creator to register `plugins/worker-routing` in your
own personal marketplace. Keep one canonical source and one discovery entry.
Check who owns an existing directory with the same name before changing it;
do not overwrite another plugin.

After updating source, use plugin-creator's `read_marketplace_name.py` to verify
the marketplace, then run `update_plugin_cachebuster.py <plugin-path>` and the
normal `codex plugin add` flow. Do not edit an installed cache in place. Verify
discovery in a new main session after installation.

Defaults and fallbacks require updated canonical ACP source and plugin instructions;
an existing session does not reload its instructions automatically. Existing
`routes.json` files and explicit `--route` remain compatible, without migrating
receipts or sessions. Once `routing.default` is configured, routine ACP channel changes
only edit that private file; do not copy the current route name into SessionStart.
See [ACP setup](acp-integration.en.md#defaults-and-fallbacks) for configuration and revocation.

## Local Dispatch dashboard

Dispatch ships with the optional ACP source, without an additional frontend
dependency or system service. Operators with the ACP runtime installed can use
the canonical CLI's `stats`, `pending` and `dashboard`; reading history does not
start an adapter. The `acp-worker` skill describes natural collaboration records.
Refresh its installed copy and the bundled cat icon through the plugin flow above:
source edits do not replace instructions already loaded in an existing session.

The dashboard initially uses the device timezone. Theme, language and timezone
are stored in `dashboard-preferences.json` under the private, Git-external
`stateDir`, and survive port changes. Only these display preferences can be
written by the dashboard; business data remains read-only. See the
[Dispatch guide](dispatch.en.md) for commands, data boundaries, exports and shutdown.

## Automatic main-session loading

1. Prepare `main-session.md` outside Git with private instructions belonging only
   to the main coordinator. Preserve the original and a recovery copy; keep the
   existing AGENTS for now. The file must be nonempty UTF-8, at most 65536 bytes.
2. Preview, then install from the repository root:

   ```bash
   python3 integrations/main-session/install.py \
     --instructions "$HOME/.codex/private-instructions/main-session.md"

   python3 integrations/main-session/install.py \
     --instructions "$HOME/.codex/private-instructions/main-session.md" --apply
   ```

   The default target is `CODEX_HOME`, or `~/.codex` when unset. The installer
   copies the script to `worker-routing/main_session.py`, merges one SessionStart
   handler, and backs up the previous `hooks.json` and any existing script under
   `worker-routing/backups/`. It does not alter AGENTS, model/provider config,
   other hooks or native hook trust.

   It first normalizes `$CODEX_HOME` to a lexical absolute path, then canonicalizes
   its parent/ancestors while leaving the final component unfollowed. Ancestor
   symlinks therefore retain the existing canonical command path, and invoking
   through an alias does not add a duplicate handler. A symlink at `$CODEX_HOME`
   itself, including a dangling one, is rejected by the checks below.

   Before reading or writing any managed output, non-following `lstat` checks
   require `$CODEX_HOME` to be absent or a real directory; `hooks.json` and
   `worker-routing/main_session.py` must be absent or single-link regular files;
   `worker-routing/` and `worker-routing/backups/` must be absent or real directories.
   Symlinks, hardlinks, FIFOs, sockets/devices and mismatched types fail with zero
   mutations in both dry-run and `--apply`. Errors name only the managed path and
   its type. Runtime and `hooks.json` are published using same-directory staging
   and atomic replacement.
3. In Codex `/hooks`, review and trust the exact **Loading main-session instructions**
   definition. It reads the selected file only for root SessionStart events
   `startup|resume|clear|compact`. `additionalContextLimit: 0`, together with the
   script's explicit byte limit, delivers the full text instead of allowing the
   default threshold to replace long input with an external file reference.
4. Confirm that a new root request receives the complete private instructions
   automatically before moving that material out of shared AGENTS. Shared AGENTS
   keeps engineering rules and worker boundaries. Do not remove existing
   main-session input prematurely.
5. Create a child with `fork_turns="none"` from a new main session and inspect the
   actual request or equivalent trusted evidence. Updating disk does not clear
   private AGENTS instructions already loaded by an older main session.

For a missing, blank, non-UTF-8 or oversized file, the hook reports an error and
returns `continue: false`. Verify the host's handling of cancellation for the
installed version. After disabling hooks, revoking trust or moving the file,
do not continue claiming automatic main-session loading works. The native
interface is documented in [Codex Hooks](https://learn.chatgpt.com/docs/hooks).
Use normal review in everyday operation, not the test-only hook-trust bypass.

## Recovery and removal

- Disabling or uninstalling the routing plugin affects future delegation;
  existing children still need to finish or be closed out.
- Restoring private instructions to shared AGENTS restores the previous exposure
  boundary. Stop new delegation, restore the original text and confirm the main
  session loads it, then remove this integration's SessionStart handler.
- Do not overwrite all of `hooks.json` with an old backup. Remove only the handler
  whose command points to `worker-routing/main_session.py`, retaining changes
  made by other sources since installation.
- Private files and backups remain under the user's control. The installer does
  not delete them; reinstalling the same path does not duplicate the handler.
  Review a changed definition again through the native trust flow.
