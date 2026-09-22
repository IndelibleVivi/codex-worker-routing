# 产品页面与 Banner

中文 | [English](website.en.md)

网站源码位于 [`integrations/site/`](../integrations/site/)，使用 Node.js 22+ 标准库构建。
无额外依赖或服务端。英文入口 `/codex-worker-routing/`，中文入口
`/codex-worker-routing/zh/`。站内指南分别在 `/guide/` 与 `/zh/guide/`，
相对于同一 repository subpath。

**本次更新已发布**（2026-09-21）：站内 ACP 指南已加入单一默认小工、默认切换与
启动前备用的说明，FAQ 明确只使用获准付费路线。源码 `8f3c27b` 的
[Pages 发布](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35553778616)成功；
公网中英首页、指南、脚本、样式与 sitemap 均返回 200，并与验收 build 逐字节一致。
公网浏览器的中英桌面/手机文案、展开 FAQ、文档语言链接及无 JS 指南检查通过，无横向
溢出或 console/page 错误。此次保留既有视觉与交互。

**已上线**（2026-09-21）：[English](https://indeliblevivi.github.io/codex-worker-routing/) ·
[中文](https://indeliblevivi.github.io/codex-worker-routing/zh/)。GitHub Actions Pages
负责托管，HTTPS 已开启。此前双语与交互更新由源码 `6db8294` 发布，
[Pages 发布](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35544461878)与
[该提交 CI](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35544461366)均成功。
中英文首页、站内指南、脚本、样式与 sitemap 在公网与已验收 build 一致；
桌面与手机浏览器实测柱状图、重置、键盘、章节与语言跳转、无 JavaScript 回退通过。

历史首次部署：[run 35536211919](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35536211919)，
源码 `d84458c`；其公网中英文入口、资源及浏览器交互已在当次验收。

## 构建与预览

从仓库根目录运行：

```sh
node integrations/site/build.mjs
node integrations/site/check.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory integrations/site/dist
```

打开 `http://127.0.0.1:8080/`，中文在 `/zh/`。资源使用相对路径，也支持部署到
GitHub Pages 的 repository subpath。停止预览使用 Ctrl-C。

页面正文、语言切换、站内指南、FAQ、相关项目和作者链接、默认 SVG 在关闭 JavaScript 时仍可用。
首页安装、Dispatch 和边界说明优先进入对应语言的站内指南章节；每节明确标注
「完整仓库文档」供进一步阅读，仓库与许可入口仍保留外链。
开启 JavaScript 后可点选示例柱状图的某一天查看轮次，再次点选或按「看全周」恢复
周汇总；支持键盘操作，关闭 JavaScript 时保留静态柱与周汇总。它只展示合成执行轮次，
不生成个人工单、用量或 runtime 明细。也可切换四个伙伴与四组双语预设、下载当前 SVG，以及复制安装提示；
clipboard 被拒绝时选择原文供手动复制。示例不是完整 Dispatch 编辑器，完整的
署名、字体、装饰及 PNG 导出在本地[派工台](dispatch.md)中使用。

## 搜索元数据与边界

`page.mjs` 维护中英首页和指南的独立 title / description、自指 canonical、
互指的 `en` / `zh-CN` / `x-default` hreflang，以及 Open Graph / Twitter 卡片。
分享预览使用对应语言的同源 1200×630 PNG。

JSON-LD 用 `WebSite` 与 `SoftwareSourceCode` 描述网站和公开源码，用 `WebPage`
描述每个页面。共享实体使用稳定的 URL 与双语声明；指南的 `BreadcrumbList`
连接对应语言的首页与指南。软件节点指向仓库 `LICENSE`，完整路径级许可仍以
[`LICENSING.md`](../LICENSING.md) 为准。元数据不读取本机配置或运行回执。

`check.mjs` 检查四页标题与摘要互异、公开域名和 canonical、语言互指、社交图存在性、
JSON-LD 关系与语言、指南导航层级，以及 sitemap 恰好覆盖四个 canonical 页面。
它也检查正常页没有 `noindex` / `nofollow` / `none` 等限制索引或链接跟踪的指令
（包括 `googlebot`），错误页保留 `noindex`。构建与检查均仅需 Node.js。

**SEO 更新已发布（2026-09-22）**：源码 `e423bd2` 的
[CI](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35709426584)
五项 jobs 和 [Pages 发布](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35709605726)
均成功。公网四页、sitemap 与两张分享图均返回 200，且与本地 build 逐字节一致。
真实浏览器检查四页的中英桌面/手机布局、标题与 JSON-LD、无 JS 正文、首页示例交互、
SVG 下载与复制通过，无横向溢出或 console/page errors。搜索引擎收录、排名与
rich results 在该次元数据发布时未验证；Search Console 后续状态单独记录。

本网站部署在 repository subpath；有效的 `robots.txt` 必须位于 origin 根目录，
不由本仓库控制。Search Console 可使用以下 URL-prefix property，验证后提交 sitemap：

- Property：`https://indeliblevivi.github.io/codex-worker-routing/`
- Sitemap：`https://indeliblevivi.github.io/codex-worker-routing/sitemap.xml`

`page.mjs` 的共享 `<head>` 包含 Google 提供的 `google-site-verification` 标记，
用于上述网址前缀的 HTML 标记验证。它是有意公开的所有权证明，不是登录凭据，
也不引入 analytics 或浏览器网络请求。验证成功后仍须保留；移除前先安排替代验证方式。
源码包含标记与 Google 账号端验证成功是两项独立状态。

资源验证、sitemap 提交与 URL Inspection 是独立的账号操作，需要对应账号权限。
可依据 [Google 标题指南](https://developers.google.com/search/docs/appearance/title-link)、
[多语言标注](https://developers.google.com/search/docs/specialty/international/localized-versions)、
[sitemap 指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
和 [robots.txt 适用范围](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec)
继续核对。

## 相关项目入口

产品页和两种语言的 README 按用途链接到 MCP Boundary 与 Servotab：前者用于
MCP 工程设计、审查与验证，后者提供一般仓库工作的工程方法。中英文页面分别
链接 Boundary 的对应语言入口。推荐区沿用 CWR 的字体，以浅鼠尾草底色和针脚边缘
收拢两个入口，突出项目名与箭头，每项配一句用途；桌面上两个等宽入口并列于
区块标题右侧，窄屏纵向排列。目标网站保留各自视觉。
页脚区分项目仓库与 Faye 的 GitHub 主页，并显示 **Co-created by Faye & Cove**。
FAQ 用六个短问题说明安装选项、委派控制、模型与访问范围、上下文、统计和分享数据。
这些入口与折叠问答在关闭 JavaScript 时仍可用。

以下是相关项目入口首次上线的历史验收记录：
[PR #3](https://github.com/IndelibleVivi/codex-worker-routing/pull/3) 合并为
`0c9a142`，main CI `35538945548` 与 [Pages run `35538947058`](https://github.com/IndelibleVivi/codex-worker-routing/actions/runs/35538947058)
均成功。2026-09-21 公网中英文页面返回 `200`，浏览器确认两个相关入口及其语言地址；
发布前已检查中英文桌面/手机布局、无 JavaScript 链接、示例切换和安装提示复制。
下载按钮显示了预期 SVG 文件名的启动回执，浏览器下载事件未取得，故不把它计作文件下载验收。

## 真源与隐私

- `page.mjs` / `style.css`：共享页面外壳、双语首页、响应式布局与四页搜索元数据（title、description、canonical、hreflang、社交卡片、JSON-LD）；其中产品名称、仓库与许可为模块内公开常量，不含私有字段。
- `guide.mjs`：站内双语指南正文；复用页面外壳，不加载首页交互脚本。
- `client.mjs`：渐进增强；无 API 请求、持久存储、cookies 或 analytics。
- `demo.mjs`：明确标注的合成数据，24 份任务 / 42 轮 / 840K observed tokens。
- `artwork.mjs`：组合 Canon 猫、线条产品标识、针脚与便签；不修改原始猫矢量。
- `assets/social-en.png` / `social-zh.png`：1200×630 的同源社交预览。
- `build.mjs`：只复制明示的纯渲染模块；不打包 dashboard server、配置或 receipts。
- `dist/`：生成目录，不进入 Git；这是唯一发布目录。

网站不连接用户的 Dispatch。所有数字都是合成示例；图片、字体、脚本与样式均为
本地资源。字体采用系统字体，因此不同操作系统上的字形和细微换行可能不同。
软件与素材沿用仓库[现有许可映射](../LICENSING.md)，不新增许可授权。

## 更新插画与 Banner

```sh
node integrations/site/build.mjs --sync-banner
node integrations/site/check.mjs
```

这会同步 `plugins/worker-routing/assets/banner-en.svg` 与 `banner-zh.svg`，
README 分别引用这两张 1600×640 Banner。Hero 为 660×580；社交图为 1200×630。

修改 `artwork.mjs` 后，在浏览器以 1200×630、device scale factor 1 渲染生成的
`dist/assets/social-en.svg` 与 `social-zh.svg`，将无边距截图存回相应
`assets/social-*.png`，再重建。检查图片边缘、标题与右对齐仓库地址不重叠。
页面变更需实际检查桌面与窄屏、中英文、主题/预设/下载、clipboard 拒绝路径、
键盘焦点和无 JavaScript 回退；构建检查不能替代视觉验收。

## GitHub Pages 发布

[Pages workflow](../.github/workflows/pages.yml) **仅接受手动触发**，普通 push 不部署。
仓库已选择 GitHub Actions 为 Pages source。后续获准发布更新时：

1. 确认待发布源码已提交到 main，Pages source 仍为 **GitHub Actions**。
2. 从 main 手动运行 **Publish product page**。
3. 确认 build/check 和部署 job 均成功；发布 artifact 只能是 `integrations/site/dist`。
4. 实际打开英文、中文入口、站内指南和社交图，检查链接、交互和 repository subpath 资源。
5. 更新本指南与 README 的托管状态，不把 workflow 成功等同于浏览器验收。

线上地址：`https://indeliblevivi.github.io/codex-worker-routing/`。
部署失败时检查该次 Actions 日志；构建失败不会替换已发布版本。恢复以前版本时，
从已核实的源版本构建并重新发布；不要上传仓库根目录，也不要把私人统计放进示例。

流程依据 GitHub 的[自定义 Pages workflow 文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
