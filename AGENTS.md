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
  execution identity; revocation blocks continuation but leaves control recovery available.
  Require explicit per-turn permissions on run/continue. Versioned execution identity
  excludes mutable workspace/permission/budget policy; validate those authorizations on
  every continuation. Legacy bindings migrate only after an exact old-fingerprint match
  under lock. Preserve historical receipts and monotonic timeout/cancellation outcomes.
  Status may recover display evidence only from exact identity-matching receipt pointers;
  this read never repairs bindings or confirms cleanup. Keep payload-free activity snapshots
  separate from writer liveness and freeze them before cancellation/cleanup; events never
  reset the hard task deadline.
  Keep setup, prompt-start task budget, and cleanup boundaries independently testable
  against the pinned public acpx runtime, including progress without a final response.
  Keep one selected launch and truthful selection evidence without extra dispatch tasks.
  The packaged `plugins/worker-routing/skills/worker-routing/references/worker-contract.md` is the single
  authored worker responsibility contract. ACP assembles it into every actual order;
  native handoffs deliver the same body. Keep optional report schemas out of ordinary
  prompts. `delivery.mjs` owns bounded per-request collection; `batch.mjs` owns finite
  CLI subprocess admission and collection, local to one batch, publishing every settled
  result into the durable index as it lands. Publish an optional batch start handle
  after its initial index and before any child admission; a failed handle write must
  leave no child and settle the owned index as partial. Preserve full batch/collect
  consumers; compact views are explicit, whole-response UTF-8 budgets include metadata
  and the stdout newline, and invalid consumer limits must fail before admission.
  Keep result publication revisions, visible text clipping/detail omissions, cursor
  validation and identity-based expansion together in `batch.mjs`. Cursor tokens are
  read positions, not authentication or control authority; an updated early result
  may replay unchanged later entries, so consumers merge by job id and revision.
  `prepare.mjs` owns mechanical order-spec to
  orders+manifest assembly and launches nothing. The shared nonce
  cancellation writer lives in `state.mjs`; a start handle records
  locks held, not prompt acknowledgement. Check actual child admission against its
  planned resources before launch. Worker reports remain declarations, separate from observed runtime/check evidence. Missing, stale or
  conflicting evidence cannot become acceptance. Never execute report-supplied
  commands. `verify.mjs` accepts task-confirmed checks in an explicit task environment;
  relocated environment is not an OS sandbox. Recovery/Dispatch/swarm references load
  only on their concrete trigger. Shared worker HOME concurrency requires evidence for
  the actual adapter topology; distinct cwd or read policy is insufficient. Keep outer
  feedback test-local until bounded comparison justifies adoption; no default loop.
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
- `integrations/acpx/src/storage.mjs` owns the adapter-free storage inventory,
  per-session scratch manifests, explicit cleanup plans and apply receipts.
  CLI and dashboard use this same backend. Keep disk details out of Dispatch's
  snapshot/share projection. Scan only exact configured roots or explicitly
  supplied inspection-only retired homes, without following links, crossing
  filesystems or reading session/log/database payloads. Preserve explicit scan
  limits and incomplete results. Only matching manifest-owned scratch with a
  closed, cleanup-confirmed CWR binding, no active turn/locks and elapsed
  retention can qualify; legacy tmp/cache, persistent history, logs, databases,
  orders and receipts never qualify. Keep scratch stable across continuation;
  new scratch uses a short stateDir child with a durable binding pointer; missing
  known managed manifests never downgrade to legacy tmp. Retain original v1
  managed paths for existing responsibilities until their lifecycle is reconciled;
  pre-manifest bindings retain legacy tmp. Revalidate saved plans under execution locks,
  reject changed trees/ownership/config and uncertain writers, and report
  partial deletion truthfully. No automatic GC or route migration. Update paired
  storage guides and exercise the real CLI/HTTP and dashboard flows with
  disposable synthetic data after lifecycle or deletion changes.
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
  the bilingual on-site guide. `workflow.mjs` owns the shared bilingual cooperation
  and finite-batch views; distinguish agent judgment from deterministic ACP mechanics.
  Home links should use the local guide; full
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
