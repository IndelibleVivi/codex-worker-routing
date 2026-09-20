# Provenance and maintenance boundaries

[中文](PROVENANCE.md) | English

This is an independently maintained original workflow project. The initial routing
policy was extracted from an internal engineering workshop along component
boundaries, and this independent repository became the subsequent canonical source;
the internal workshop's Git history, adjacent projects, personal notes and work
records were not migrated in.

The repository contains handwritten routing/worker instructions, a native SessionStart
adapter script, an installer, synthetic tests and usage documentation, plus an optional
ACP integration based on the public `acpx/runtime` API. The Responses and ACP test events
are local protocol fixtures; there is no real account, private request or model output,
and no Codex runtime or external adapter implementation is copied. `acpx` and its
transitive dependencies retain their own third-party licenses.

The cat mark went through this project's image-generation exploration, and the
folded-ear cat was redrawn as native SVG; running and distribution use the vector
implementation in `integrations/acpx/src/brand.mjs`; the concept art is not a runtime
dependency. The rabbit, dog and bear in the adjacent themes are native SVG drawings for
this project, maintained by `integrations/acpx/src/mascots.mjs`, preserving the same
family's design language.

Dispatch's compact workbench, line product mark and separate share layout evolved from
the v3 design candidates provided by this project; the candidates' synthetic data and
simulated runtime situations were not migrated into the production data path. Actual
statistics are projected from private receipts.

The public product page and banners are composed from this project's existing cat mark,
line mark and hand-drawn decorations; `integrations/site/artwork.mjs` is the composition
source of truth for the page illustrations and banners. The site uses no external images,
fonts or analytics; the Dispatch sample and the sample share card come from independent
synthetic data and do not read real receipts. The social preview PNG is a raster export
of the same-source SVG.

The interfaces reference OpenAI's [Hooks](https://learn.chatgpt.com/docs/hooks) and
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) documentation,
independently observed with local binaries. This project is not an official OpenAI
product or a fork maintained by it.

Software and functional material use `SUL-1.0`, documentation uses `CC BY-NC-SA 4.0`;
the specific file scope, external links and license boundaries are in
[LICENSING.md](LICENSING.md). This is a source-available project, not OSI open source;
repository visibility does not expand license grants.
