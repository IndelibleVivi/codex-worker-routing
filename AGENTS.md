# Worker Routing contributor contract

This independent repository is the canonical source for the Worker Routing
plugin and its optional main-session context integration.

- Edit `plugins/worker-routing/` for delegation policy and role instructions.
- Edit `integrations/main-session/` for the native SessionStart adapter.
- Edit `integrations/acpx/` for the optional ACP transport. Keep route names,
  provider/model priorities, account state, worker homes, and route config outside Git.
- Dispatch source lives in `integrations/acpx/src/dispatch.mjs`, `dashboard.mjs`,
  `share.mjs` and `dashboard/`. Receipts own runtime truth; append-only review
  events own attributed collaboration annotations; projections are rebuildable.
  Keep HTTP loopback-only and exports aggregate-only. Never publish real state
  or infer acceptance, rework, provider identity or quota savings from completion.
  Validate accounting/privacy/shutdown with the ACP suite and exercise the actual
  dashboard in desktop and narrow browser viewports after UI changes.
- `integrations/acpx/src/brand.mjs` owns the cat logo. The plugin asset
  `plugins/worker-routing/assets/cat.svg` is derived; regenerate it with
  `npm run brand:sync` from `integrations/acpx/` after changing the mark.
- `integrations/acpx/src/themes.mjs` owns the named theme palettes; the adjacent
  `mascots.mjs` owns their companion artwork. The folded-ear cat and sage/blush default are the Canon identity:
  preserve the cat vector and colours when adding adjacent family themes.
- Keep provider IDs and personal preferences in operator-owned configuration.
- Never place personal instructions, chats, memory, tokens, real request captures,
  machine paths, or private continuity in this repository, including fixtures.
- Keep examples synthetic and installation reversible. The installer must not
  rewrite AGENTS, approve hook trust, or change model/provider configuration.
- Main context must arrive before the first root model request. Worker spawning
  uses `fork_turns="none"`; new work must preserve the root/child input boundary.
- Keep installed copies separate from source. Use the plugin-creator update flow
  for an existing local installation; never patch a cache in place.
- `LICENSE` governs software and functional material under `SUL-1.0`;
  `LICENSE-DOCUMENTATION.md` governs documentation under `CC-BY-NC-SA-4.0`.
  Keep the exact path map in `LICENSING.md` aligned, and do not call the project
  OSI open source or change these grants without the owner's explicit choice.
- Check `python3 -m unittest discover -s tests -p 'test_*.py'` after Python changes.
  Run the opt-in native context probe for changes to hook delivery or spawning.
- After ACP changes, run `npm ci --ignore-scripts`, `npm run check`, and
  `npm run test:acpx` from `integrations/acpx/`. Track `package-lock.json`, never
  `node_modules/`, private route state, adapter profiles, or receipts.
- Update README and installation docs for changed behavior, dependencies, paths,
  privacy boundaries, commands, and acceptance claims.
- Commit only explicit reviewed component paths. Source, local installation,
  context delivery, actual model execution, and GitHub state are separate claims.
