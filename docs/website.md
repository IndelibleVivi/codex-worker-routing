# 产品页面与 Banner

网站源码位于 [`integrations/site/`](../integrations/site/)，使用 Node.js 22+ 标准库构建。
无额外依赖或服务端。英文入口 `/codex-worker-routing/`，中文入口
`/codex-worker-routing/zh/`。当前状态：**source candidate；尚未启用 Pages 托管**。

## 构建与预览

从仓库根目录运行：

```sh
node integrations/site/build.mjs
node integrations/site/check.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory integrations/site/dist
```

打开 `http://127.0.0.1:8080/`，中文在 `/zh/`。资源使用相对路径，也支持部署到
GitHub Pages 的 repository subpath。停止预览使用 Ctrl-C。

页面正文、语言切换、文档链接和默认 SVG 在关闭 JavaScript 时仍可用。
开启 JavaScript 后可切换四个伙伴与四组双语预设、下载当前 SVG，以及复制安装提示；
clipboard 被拒绝时选择原文供手动复制。示例不是完整 Dispatch 编辑器，完整的
署名、字体、装饰及 PNG 导出在本地[派工台](dispatch.md)中使用。

## 真源与隐私

- `page.mjs` / `style.css`：双语静态内容与响应式布局。
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
仓库管理员明确决定公开上线后：

1. 在仓库 Settings → Pages 选择 **GitHub Actions** 为 source。
2. 从 main 手动运行 **Publish product page**。
3. 确认 build/check 和部署 job 均成功；发布 artifact 只能是 `integrations/site/dist`。
4. 实际打开英文、中文入口、社交图，检查链接、交互和 repository subpath 资源。
5. 更新本指南与 README 的托管状态，不把 workflow 成功等同于浏览器验收。

预定地址：`https://indeliblevivi.github.io/codex-worker-routing/`。
部署失败时检查该次 Actions 日志；构建失败不会替换已发布版本。恢复以前版本时，
从已核实的源版本构建并重新发布；不要上传仓库根目录，也不要把私人统计放进示例。

流程依据 GitHub 的[自定义 Pages workflow 文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
