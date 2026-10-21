// SPDX-License-Identifier: SUL-1.0
// Public, bilingual views of the cooperation contract and optional ACP mechanics.
// Authored explanation only: this module never reads configuration or receipts.
export function renderWorkLoop(lang='en'){
 const T=(cn,en)=>lang==='zh'?cn:en;
 return `<figure class="work-loop" aria-label="${T('从目标到交付，以及返回原 worker 的帮助路径','From goal to delivery, with help returning to the same worker')}">
 <div class="loop-heading"><span class="eyebrow">${T('一份完整责任，连贯做完','ONE RESPONSIBILITY, KEPT TOGETHER')}</span><span class="loop-channel">Native / ACP</span></div>
 <ol class="loop-spine">
  <li class="loop-node loop-main"><span class="loop-owner">MAIN AGENT</span><h3>${T('守住目标，组织分工','Keep the goal. Shape the work.')}</h3><p>${T('接到工程目标，按已有通道选择交出完整责任，写清边界与完成条件。','Take an engineering goal, honor the chosen channel, and hand over a whole responsibility with boundaries and completion criteria.')}</p><span class="loop-payload">${T('目标 · 工单 · 权限','Goal · Work order · Permissions')}</span></li>
  <li class="loop-node loop-worker"><span class="loop-owner">WORKER</span><h3>${T('自己检查，也自己修正','Check, repair, and deliver.')}</h3><p>${T('调查、实现、自查与普通返修留在同一责任里。遇到关键判断缺口，带着成果和精确问题回来。','Keep investigation, implementation, self-check and ordinary repairs together. Bring back progress and a precise question when a key judgment is missing.')}</p><span class="loop-payload">${T('调查 → 实现 → 检查 → 修正','Investigate → Implement → Check → Repair')}</span></li>
  <li class="loop-node loop-return"><span class="loop-owner">MAIN AGENT</span><h3>${T('接住证据，推进交付','Read the evidence. Move forward.')}</h3><p>${T('查看实际成果、覆盖与冲突，定向检查疑点；条件达标后整合交付，需要帮助时补充判断。','Inspect artifacts, coverage and conflicts; check concrete doubts. Integrate supported work for delivery, or supply the judgment needed to continue.')}</p><span class="loop-payload">${T('实际成果 · 检查证据 · 最终交付','Artifacts · Check evidence · Final delivery')}</span></li>
 </ol>
 <div class="loop-feedback"><span class="feedback-arrow" aria-hidden="true">↶</span><div><strong>${T('帮一把，把下一步送回原 worker。','A little help. Then back to the same worker.')}</strong><p>${T('关键判断、补充条件或具体返修，优先继续原会话；有用的执行留在 worker 一侧。','Return decisions, added constraints or specific rework to the original session; keep useful execution with its worker.')}</p></div><span class="feedback-tag">${T('原会话续做','SAME SESSION')}</span></div>
 <figcaption>${T('这张图描述插件给 agent 的协作纪律。主 agent 作出委派与验收判断；小事、临近完成的工作或 solo 请求可以直接做。','This is the cooperation policy delivered to agents. The main agent judges delegation and acceptance; tiny, nearly finished or solo work can stay direct.')}</figcaption>
 </figure>`;
}

export function renderBatchFlow(lang='en'){
 const T=(cn,en)=>lang==='zh'?cn:en;
 return `<div class="batch-flow">
 <div class="batch-intro"><span class="eyebrow">OPTIONAL ACP / FINITE BATCH</span><h3>${T('分工由主脑决定，机械步骤交给 CLI。','The main agent chooses the work. The CLI handles the mechanics.')}</h3><p>${T('一份主 agent 编写的 order spec，连接工单准备、有限批量执行与增量读取。可以交出独立责任，也可以声明前驱和所需报告，让输入齐备的后继继续工作。','One order spec authored by the main agent connects preparation, finite execution and incremental collection. Hand over independent responsibilities, or declare predecessors and required reports so successors can continue when their inputs are ready.')}</p></div>
 <ol class="batch-spine">
  <li><code>prepare</code><strong>${T('整理工单','Assemble orders')}</strong><span>${T('机械生成 orders + manifest，不启动 worker。','Generate orders and a manifest mechanically; launch no worker.')}</span></li>
  <li><code>batch</code><strong>${T('按依赖与资源准入','Admit ready work')}</strong><span>${T('检查前驱交付、授权与资源，绑定确切输入，逐项保存已结算结果。','Check predecessor deliveries, authorizations and resources; bind exact inputs and persist each settled result.')}</span></li>
  <li><code>collect</code><strong>${T('先读回来的部分','Read what has landed')}</strong><span>${T('只读已结算索引，不等整批结束；剩余责任继续保留。','Read the settled index without waiting for the rest; retain outstanding responsibilities.')}</span></li>
 </ol>
 <p class="batch-boundary">${T('ACP 运行器保留 session、回执与有界交付线索；缺失或失败的前驱会阻止依赖任务启动。worker 自述、实际运行状态和主脑验收分别判断。共享 HOME 的并发安全未知时，按该资源串行。','The ACP runner retains sessions, receipts and bounded delivery clues; a missing or failed predecessor blocks dependent work. Worker reports, observed runtime state and main-agent acceptance remain distinct. Serialize a shared HOME when its concurrency safety is unknown.')}</p>
 </div>`;
}
