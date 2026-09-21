# Worker Routing contributor contract

This independent repository is the canonical source for the Worker Routing
plugin and its optional main-session context integration.

- Edit `plugins/worker-routing/` for delegation policy and role instructions.
- Edit `integrations/main-session/` for the native SessionStart adapter.
- Edit `integrations/acpx/` for the optional ACP transport. Keep route names,
  provider/model priorities, account state, worker homes, and route config outside Git.
  `config.mjs` owns optional `routing.default`/`routing.fallbacks` in that same private
  config. Automatic fallback ends before adapter launch and cannot bypass permission,
  workspace or disabled-route checks. Default changes do not alter a bound session's
  fingerprint; revocation blocks continuation but leaves control recovery available.
  Keep one selected launch and truthful selection evidence without extra dispatch tasks.
- Dispatch source lives in `integrations/acpx/src/dispatch.mjs`, `dashboard.mjs`,
  `share.mjs` and `dashboard/`. `time.mjs` owns shared calendar bucketing;
  `workspaces.mjs` resolves private local Git/folder identity; `observations.mjs`
  retains only structured runtime evidence. `preferences.mjs` permits only theme,
  language and timezone writes outside Git. Project paths and runtime notes never
  cross the public share allowlist. Receipts own runtime truth; append-only review
  events own attributed collaboration annotations; projections are rebuildable.
  Keep HTTP loopback-only. Exported receipt data stays aggregate-only; explicit
  author-entered slogans/credits are a separate bounded, XML-escaped presentation
  input and must never be inferred from private records or account identity. Never
  publish real state or infer acceptance, rework, provider identity or quota savings
  from completion.
  Validate accounting/privacy/shutdown with the ACP suite and exercise the actual
  dashboard in desktop and narrow browser viewports after UI changes.
- `integrations/acpx/src/brand.mjs` owns the cat logo. The plugin asset
  `plugins/worker-routing/assets/cat.svg` is derived; regenerate it with
  `npm run brand:sync` from `integrations/acpx/` after changing the cat artwork.
  Its `.gitattributes` LF rule preserves exact renderer parity on Windows too.
- `integrations/acpx/src/mark.mjs` owns the fixed line product mark used in the
  page header, favicon and share header. It does not replace the Canon cat artwork
  or plugin icon.
- `integrations/acpx/src/themes.mjs` owns the named theme palettes; the adjacent
  `mascots.mjs` owns their companion artwork. The folded-ear cat and sage/blush default are the Canon identity:
  preserve the cat vector and colours when adding adjacent family themes.
- `share-style.mjs` owns bounded author text, bilingual presets and style choices;
  `ornaments.mjs` owns hand-drawn decorative paths shared by exports and dashboard.
  Share drafts stay in browser memory, separate from persistent dashboard preferences.
- Public website source lives in `integrations/site/`; `dist/` is generated and
  ignored. Build with `node integrations/site/build.mjs` and check with
  `node integrations/site/check.mjs`. Browser assets use the explicit build manifest;
  never add private config, receipts, dashboard server modules or real task data.
  `demo.mjs` owns synthetic examples and the interactive chart uses only its daily
  turn counts. `page.mjs` owns the shared shell and homepage; `guide.mjs` owns
  the bilingual on-site guide. Home links should use the local guide; full
  repository references remain explicitly labelled. `artwork.mjs` composes the existing Canon
  artwork; `--sync-banner` refreshes derived plugin banners. Verify desktop/mobile
  English and Chinese layouts and actual sampler/download/copy interactions after
  site changes. Pages account activation and deployment are separate from source.
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
- Keep paired public guides in Chinese and English aligned; `docs/README.md` and
  `docs/README.en.md` index them. Runtime skill instructions stay canonical in English.
- Update README and installation docs for changed behavior, dependencies, paths,
  privacy boundaries, commands, and acceptance claims.
- Commit only explicit reviewed component paths. Source, local installation,
  context delivery, actual model execution, and GitHub state are separate claims.
