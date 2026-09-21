# Product page and banners

[中文](website.md) | English

Website source lives in [`integrations/site/`](../integrations/site/) and builds with
Node.js 22+ standard libraries, with no extra dependencies or server. The English
entry is `/codex-worker-routing/` and Chinese is `/codex-worker-routing/zh/`.
The on-site guides live at `/guide/` and `/zh/guide/` under that same repository subpath.

**Source update, not deployed** (2026-09-21): the ACP guide now explains one default
worker, default changes and prelaunch fallbacks; the FAQ clarifies authorized paid
routes. Local build/check, English/Chinese desktop and mobile copy, expanded FAQs
and no-JavaScript guides passed. The deployment record below does not cover this copy.

**Live** (2026-09-21): [English](https://indeliblevivi.github.io/codex-worker-routing/) ·
[中文](https://indeliblevivi.github.io/codex-worker-routing/zh/). GitHub Actions Pages
hosts the site with HTTPS enabled. The bilingual and interactive update was published from `6db8294`; its
[Pages deployment](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35544461878) and
[commit CI](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35544461366) succeeded.
Both public homepages, guides, scripts, styles and sitemap match the accepted build.
Desktop and mobile browser checks passed for chart selection, reset, keyboard input,
section and language navigation, and the no-JavaScript fallback.

Historical first deployment: [run 35536211919](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35536211919),
source `d84458c`; its public language entries, assets and browser interactions were
checked at that release.

## Build and preview

Run from the repository root:

```sh
node integrations/site/build.mjs
node integrations/site/check.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory integrations/site/dist
```

Open `http://127.0.0.1:8080/`, or `/zh/` for Chinese. Relative asset paths also support
the GitHub Pages repository subpath. Stop the preview with Ctrl-C.

Page text, language switching, on-site guides, FAQs, project and author links, and
the default SVG work without JavaScript. Homepage setup, Dispatch and boundary links
lead to the matching on-site guide section. Each section explicitly labels its full
repository reference; repository and licensing entries remain external links.

With JavaScript, select a sample chart bar to inspect that day's worker turns; select
it again or choose “Full week” to restore the weekly total. Keyboard input works too.
Without JavaScript the bars and weekly total remain static. The chart uses synthetic
turn counts only, without inventing personal tasks, usage or runtime details. You can
also switch four companions and four bilingual presets, download the current SVG,
and copy the installation prompt. If clipboard access is denied, the prompt is selected
for manual copying. This sampler is not the full Dispatch editor: authored credits,
numeral styles, ornaments and PNG exports are available in [local Dispatch](dispatch.en.md).

## Related projects

The product page and both READMEs link to MCP Boundary for MCP engineering design,
review and verification, and to Servotab for everyday repository engineering methods.
English and Chinese pages use Boundary's matching language entry. The related links
use CWR typography, grouped on a pale sage surface with stitched edges. Project
names and arrow links lead, followed by a short use case. Desktop places the two
equal-width entries beside the section heading; narrow screens stack them. Each destination retains its own website identity.

The footer distinguishes the project repository from Faye's GitHub profile and includes
**Co-created by Faye & Cove**. Six short FAQs cover installation choices, delegation
control, models and access, context, accounting and share data. Links and collapsible
answers also work without JavaScript.

Historical acceptance record for the first related-project release:
[PR #3](https://github.com/IndelibleVivi/codex-worker-routing/pull/3) merged as
`0c9a142`; main CI `35538945548` and [Pages run `35538947058`](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35538947058)
succeeded. Both public language pages returned `200` on 2026-09-21, and browser checks
confirmed the two related links and their language destinations. Before release,
English/Chinese desktop/mobile layouts, no-JavaScript links, sampler switching and
installation-prompt copying were checked. The download button reported the expected
SVG filename, but no browser download event was obtained, so that was not counted as
file-download acceptance.

## Source and privacy

- `page.mjs` / `style.css`: shared shell, bilingual homepages and responsive layout.
- `guide.mjs`: bilingual on-site guide content; shares the shell without loading the homepage script.
- `client.mjs`: progressive enhancement; no API calls, persistent storage, cookies or analytics.
- `demo.mjs`: explicitly synthetic data: 24 tasks / 42 turns / 840K observed tokens.
- `artwork.mjs`: composes the Canon cat, line product mark, stitching and paper notes without changing the original cat vector.
- `assets/social-en.png` / `social-zh.png`: same-origin 1200×630 social previews.
- `build.mjs`: copies only listed pure renderer modules, never the dashboard server, configuration or receipts.
- `dist/`: generated, ignored and the only directory to publish.

The site does not connect to anyone's Dispatch. Every number is synthetic; images,
fonts, scripts and styles are local resources. System fonts mean letterforms and
small line-wrap differences can vary across operating systems. Software and assets
keep the repository's [existing license map](../LICENSING.md), with no new grant.

## Update artwork and banners

```sh
node integrations/site/build.mjs --sync-banner
node integrations/site/check.mjs
```

This synchronizes `plugins/worker-routing/assets/banner-en.svg` and `banner-zh.svg`.
Each README uses its matching 1600×640 banner. Hero artwork is 660×580; social previews
are 1200×630.

After editing `artwork.mjs`, render the generated `dist/assets/social-en.svg` and
`social-zh.svg` at 1200×630 and device scale factor 1 in a browser. Save borderless
screenshots to the matching `assets/social-*.png`, then rebuild. Check the edges,
title and right-aligned repository address for overlap. Page changes require actual
desktop/narrow-screen, English/Chinese, theme/preset/download, clipboard-denial,
keyboard-focus and no-JavaScript checks. A build check does not replace visual acceptance.

## Publish to GitHub Pages

The [Pages workflow](../.github/workflows/pages.yml) is **manual-only**; a normal push
does not deploy. The repository already uses GitHub Actions as its Pages source.
For an authorized update:

1. Confirm the source is committed to main and Pages source is still **GitHub Actions**.
2. Run **Publish product page** manually from main.
3. Confirm build/check and deployment jobs succeed. Only `integrations/site/dist` may be uploaded.
4. Open both language entries, the guides and social previews; check links, interactions and repository-subpath resources.
5. Update this guide and README hosting status. Workflow success is not browser acceptance.

Public address: `https://indeliblevivi.github.io/codex-worker-routing/`.
If deployment fails, inspect that Actions run. A failed build does not replace the
published version. To restore a previous version, build and republish verified source;
do not upload the repository root or use private statistics in examples.

The workflow follows GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
