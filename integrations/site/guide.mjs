// SPDX-License-Identifier: SUL-1.0
// On-site getting-started / Dispatch / boundary guide for the public product page.
// Pure text projection: no private paths, receipts, route names or account data.
export function renderGuideContent(lang='en'){
 const zh=lang==='zh';
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // tp: pick Chinese/English, then XML-escape. T: pick without escaping (for authored code).
 const tp=(cn,en)=>esc(zh?cn:en);
 const T=(cn,en)=>zh?cn:en;
 const REPO='https://github.com/IndelibleVivi/codex-worker-routing';
 // Full repository references are explicitly labelled external links.
 const doc=(label,path)=>`<a class="guide-source" href="${REPO}/blob/main/docs/${path}" target="_blank" rel="noopener">${esc(label)} <span aria-hidden="true">↗</span></a>`;
 const refZh='完整仓库文档';
 const refEn='Full repository reference';

 // Each language points to its matching full reference.
 const refs={
  start:   zh?doc(refZh,'first-delegated-task.md'):doc(refEn,'first-delegated-task.en.md'),
  deleg:   zh?doc(refZh,'first-delegated-task.md'):doc(refEn,'first-delegated-task.en.md'),
  acp:     zh?doc(refZh,'acp-integration.md'):doc(refEn,'acp-integration.en.md'),
  dispatch:zh?doc(refZh,'dispatch.md'):doc(refEn,'dispatch.en.md'),
  sharing: zh?doc(refZh,'dispatch.md'):doc(refEn,'dispatch.en.md'),
  context: zh?doc(refZh,'context.md'):doc(refEn,'context.en.md'),
 };

 const toc=[
  ['start',      tp('开始使用','Getting started')],
  ['delegation', tp('委托与验收','Delegation & acceptance')],
  ['optional-acp',tp('可选 ACP 通道','Optional ACP route')],
  ['dispatch',   tp('本机 Dispatch','Local Dispatch')],
  ['sharing',    tp('分享卡与隐私','Share cards & privacy')],
  ['context',    tp('上下文与边界','Context & boundaries')],
 ];

 // Synthetic, non-personal bounded work order. Escaped before insertion.
 const workOrder=T(
`修复空行导致的 CSV 导入失败。
范围：一个函数外加一个针对性检查。
补一个能复现该 bug 的检查，运行它，并交回 diff 与结果。
不要改动公开 API 或无关文件。
若修复必须越界，请停下来说明。`,
`Fix the CSV import failure caused by blank rows.
Scope: one function plus one focused check.
Add a check that reproduces the bug, run it, and return the diff and result.
Do not touch the public API or unrelated files.
Stop and report if the fix would cross that boundary.`);

 const section=(id,eyebrow,title,body,refsHtml)=>`<section class="guide-section" id="${id}">
 <p class="eyebrow">${esc(eyebrow)}</p>
 <h2>${esc(title)}</h2>
 ${body}
 ${refsHtml?`<p class="guide-sources">${refsHtml}</p>`:''}
</section>`;

 const startBody=`<p>${tp('Worker Routing 是一个只含说明的插件：它不创建模型、不保存 API key，也不实现 Codex 的多 agent 运行时。它给主 agent 判断规则——何时委托、交出什么、如何接回结果；可以从原生 Codex workers 开始。','Worker Routing is an instruction-only plugin: it creates no models, stores no API keys, and does not implement the Codex multi-agent runtime. It gives your main agent rules for when to delegate, what to hand over, and how to return the result. You can start with native Codex workers.')}</p>
 <ul>
  <li>${tp('让 Codex 内置的 plugin-creator 把 plugins/worker-routing 注册到你的个人 marketplace，保留现有主模型与 provider。','Ask Codex\u2019s built-in plugin-creator to register plugins/worker-routing into your personal marketplace, keeping your current model and provider.')}</li>
  <li>${tp('安装后新开一个主会话确认它真的加载了——注册成功不等于当前会话已生效。','Then open a new main session to confirm it loaded: registration is not activation.')}</li>
  <li>${tp('它只改变后续调度：不接管请求，也不替你选模型或付费路线。ACP 执行通道与主会话上下文集成是两个独立可选项，需要时再配置。','It only changes future routing: no request is taken over, no model or paid route chosen for you. The ACP route and main-session context integration are separate optional additions.')}</li>
 </ul>`;

 const delegBody=`<p>${tp('值得委托的是一块能独立收尾的责任：调查、修改、自测一起交给同一个 worker。工单写清目标、边界，以及完成时要交回什么。小任务或临近完成的工作留在主会话——交接也有成本。','Delegate a responsibility that can finish on its own: investigation, change and self-check for one worker. A work order names the outcome, boundaries and what to return; small or nearly finished tasks can stay with the main agent.')}</p>
 <pre><code>${esc(workOrder)}</code></pre>
 <ul>
  <li>${tp('需要修正时，优先在原会话继续，而不是新起一个 worker。','For a correction, continue the same session, not a new worker.')}</li>
  <li>${tp('主 agent 交付前要检查真实 diff 与相关检查。worker 说「完成」只是它的结论，不等于工程验收。','Before delivery the main agent reviews the diff and checks. \u201cDone\u201d from a worker is a claim, not acceptance.')}</li>
  <li>${tp('说「自己来」或「solo」，工作就留在主会话，主 agent 也应避免重复实现已经交出的责任。','Say \u201csolo\u201d or \u201cdo not delegate\u201d to keep the work in the main session; the main agent should also avoid re-implementing work already delegated.')}</li>
 </ul>`;

 const acpBody=`<p>${tp('可以从一个默认小工开始，不需要比较模型或填写特长。原生 worker 使用宿主工具；你也可以把已登记的 ACP route 设为日常默认，交给它自己的独立会话。','Start with one default worker, without comparing models or writing capability profiles. Native workers use host tools; a registered ACP route can also be your everyday default with its own separate session.')}</p>
 <ul>
  <li>${tp('route 配置、worker home、workspace 白名单、provider 与账号选择都留在 Git 外，由你掌握。','Route config, worker home, workspace allowlist and provider/account choices stay outside Git, under your control.')}</li>
  <li>${tp('在现有 ACP 配置里设 routing.default，正常 run 就能省略 --route；换渠道只改这一处。routing.fallbacks 可留空，备用必须预先获准。','Set routing.default in the existing ACP config and omit --route on ordinary runs. Change channels in that one place; routing.fallbacks may stay empty and backups require prior authorization.')}</li>
  <li>${tp('自动备用只处理启动前的入口不可用或必要环境凭据缺失。启动后先恢复原执行；改默认保留旧会话，明确停用旧渠道则阻止后续续做。','Automatic backups handle only unavailable entries or missing required environment credentials before launch. After startup, recover the original execution first. Changing the default preserves existing sessions; disabling a channel blocks further continuation.')}</li>
  <li>${tp('工单通过你可配置的 agent 传出去；--permissions read|full 只决定 cwr-acp 如何应答 ACP 权限请求，它不是 OS 文件沙箱，也不构成隔离。','The work order goes to your configured agent. --permissions read|full only decides how cwr-acp answers ACP permission requests; it is not an OS sandbox and gives no isolation.')}</li>
  <li>${tp('能启动 route 或列出模型，不等于真实推理成功；初始化与执行是两个观测层。','A route starting or a model listed does not prove real inference succeeds; initialization and execution are separate.')}</li>
 </ul>
 <div class="guide-note"><p>${tp('第一次试用可以交出一个小而完整的任务：改一个函数、补一个检查，再看真实 diff 与检查结果。','For a first run, hand over a small, complete task: edit one function, add a check, then review the actual diff and result.')}</p></div>`;

 const dispatchBody=`<p>${tp('Dispatch 在本机呈现 ACP 回执与主动记录的复查笔记。业务数据只读；主题、语言和时区可以保存。它不安排工作，也不建第二套任务数据库。原生 Codex 活动在这里没有数据源——每个数字都明确只覆盖 ACP。','Dispatch displays local ACP receipts and review notes you add on purpose. Business data is read-only; theme, language and timezone can be saved. It schedules nothing and adds no second job database. Native Codex activity has no data source here: every metric is ACP-only.')}</p>
 <pre><code>${esc(`node integrations/acpx/src/cli.mjs dashboard --config /absolute/private/config.json
node integrations/acpx/src/cli.mjs stats --config /absolute/private/config.json --since 7d`)}</code></pre>
 <ul>
  <li>${tp('统计口径：运行完成不等于工程验收；已观测 tokens 是已知工作量，不是省下的 Codex 额度，也不是计费证据；缺少用量保留为未知而非零。','Accounting: runtime completion is not acceptance; observed tokens are known workload, not quota saved and not billing evidence; missing data stays unknown.')}</li>
  <li>${tp('项目按实际工作目录找回：本机 Git 仓库把链接的 worktree 归入同一仓库，另有文件夹过滤；这不是 Codex 保存的项目名，也不用聊天文本推断身份。','Projects come from the working directory: Git repositories group linked worktrees, with a folder filter. These are not saved Codex project names; no chat text infers identity.')}</li>
  <li>${tp('用量覆盖度指出多少任务有可归属数据；普通完成或关闭不需标注，也不产生待办。','Usage coverage states how many tasks have attributable data; ordinary completion needs no annotation or to-do.')}</li>
 </ul>`;

 const sharingBody=`<p>${tp('分享卡预览 1600×900 横版与 1080×1350 竖版，可导出 SVG 或 PNG。主题、中英文、版式各自独立：四种主题 × 两种语言 × 两种版式 × SVG/PNG 共 32 种组合，文件名带主题、语言、格式与日期。','Share cards preview 1600×900 landscape and 1080×1350 portrait, as SVG or PNG. Theme, language and layout are independent: four themes × two languages × two layouts × SVG/PNG give 32 combinations, named with theme, language, format and date.')}</p>
 <ul>
  <li>${tp('数字笔触可选 Soft / Book / Mono，装饰可选 Thread / Bloom / None；手绘装饰只来自本地 SVG。','Numerals offer Soft / Book / Mono, ornaments Thread / Bloom / None; decorations stay in local SVG.')}</li>
  <li>${tp('文案从四组双语预设起步、可自由编辑；另有可选署名。这两项是你主动输入的展示文本，以纯文本转义后进入图片，绝不会从私人记录或账号身份推断。','The slogan starts from four bilingual presets and is editable; an optional shared-by credit is separate. Both are text you enter, escaped as plain text, never inferred from records.')}</li>
  <li>${tp('统计部分只接受汇总数字、时间范围、时区与覆盖度；工单、输出、私有 route 名、路径与内部 ID 不会自动填入卡片，也不会自动上传。','The statistics portion accepts only aggregate totals, period, timezone and coverage. Work orders, outputs, private route names, paths and internal IDs are never filled in automatically, and nothing auto-uploads.')}</li>
 </ul>
 <div class="guide-note"><p>${tp('草稿只留在浏览器内存、刷新即重置，与持久化的本机展示偏好分开——只有主题、语言与时区会被保存。','Drafts live only in browser memory and reset on refresh, separate from persistent display preferences: only theme, language and timezone are saved.')}</p></div>`;

 const contextBody=`<p>${tp('可选的主会话集成用原生 SessionStart hook，在第一个 root 请求之前加载你的私人说明，只注入 root；新 worker 不继承主对话历史。主上下文必须先于首次 root 请求到达，新委托才保持 root/child 输入边界。','The optional main-session integration uses a native SessionStart hook to load your private instructions before the first root request, into the root only; new workers do not inherit the main conversation. Main context must arrive before that first request for new work to keep the root/child boundary.')}</p>
 <ul>
  <li>${tp('hook 只作用于 root，需要你 review 并信任；安装器不会改写 AGENTS、自动批准 hook，或改动模型与 provider 配置。','The hook applies to the root only and must be reviewed and trusted by you; the installer does not rewrite AGENTS, auto-approve hooks or change model/provider config.')}</li>
  <li>${tp('共享工程规则仍可能随宿主到达 worker——「共享规则」不等于把文件访问限制在某个目录；路由配置本身不提供隔离。','Host-shared engineering rules may still reach workers — \u201cshared rules\u201d is not limiting file access to one directory; route config alone provides no isolation.')}</li>
  <li>${tp('文件权限由宿主与 sandbox 决定，这套机制不会阻止已获准使用文件工具的进程读取本机其它文件。','File permissions come from the host sandbox; this does not stop a process with file tools reading other local files.')}</li>
 </ul>
 <div class="guide-note"><p>${tp('接入后，在新会话中确认主 agent 收到了完整说明，再用一份不含私人内容的小工单检查 worker 的输入。完整安装文档提供验证与恢复步骤。','After setup, use a new session to confirm the main agent received the instructions, then check worker input with a small work order containing no private material. The installation reference covers verification and recovery.')}</p></div>`;

 return `<header class="guide-heading">
 <p class="eyebrow">${tp('指南 / 现场笔记','GUIDE / FIELD NOTES')}</p>
 <h1>${tp('一份工单出去，结果与证据回来。','A work order goes out. Evidence comes back.')}</h1>
 <p>${tp('从第一次委托，到本机 Dispatch 与分享卡：讲清日常用法、真正会发生什么，以及数据与权限的边界。','From first delegation to local Dispatch and share cards: the flow, what happens, and the data boundaries.')}</p>
</header>
<nav class="guide-toc" aria-label="${tp('本页章节','On this page')}">
 ${toc.map(([id,label])=>`<a href="#${id}">${label}</a>`).join('')}
</nav>
<div class="guide-sections">
${section('start',T('01 / 开始使用','01 / GETTING STARTED'),T('插件负责调度；其它都可以后加。','The plugin routes work. Everything else is optional.'),startBody,refs.start)}
${section('delegation',T('02 / 委托与验收','02 / DELEGATION & ACCEPTANCE'),T('交出一整块责任，而不是一条指令。','Hand over a whole responsibility, not a command.'),delegBody,refs.deleg)}
${section('optional-acp',T('03 / 可选 ACP 通道','03 / OPTIONAL ACP ROUTE'),T('外部通道可加可不加。','An external route is optional.'),acpBody,refs.acp)}
${section('dispatch',T('04 / 本机 Dispatch','04 / LOCAL DISPATCH'),T('回执自然留下足迹。','Receipts leave a trail.'),dispatchBody,refs.dispatch)}
${section('sharing',T('05 / 分享卡与隐私','05 / SHARE CARDS & PRIVACY'),T('自己做主的一张小卡。','A little card that stays yours.'),sharingBody,refs.sharing)}
${section('context',T('06 / 上下文与边界','06 / CONTEXT & BOUNDARIES'),T('这是输入装配边界，不是文件沙箱。','An input boundary, not a filesystem sandbox.'),contextBody,refs.context)}
</div>`;
}
