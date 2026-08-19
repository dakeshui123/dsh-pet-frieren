# 设计：桌宠跟随 Agent 状态（9 状态素材全部驱动）

日期：2026-08-19
状态：已获用户批准（含三处自定义决策与"会话切换跟随"补充需求）

## 1. 背景与问题

dsh-pet-frieren 是 DeepSeek Harness 网页版（`dsh --profile web`）的桌宠插件：

- node half（`lib/index.js`）：通过宿主 `webServer` 注册素材路由，无需改动。
- client half（`lib/client.js`）：浏览器端 bundle，纯 DOM overlay + rAF 帧动画。

素材 atlas（`spritesheet.webp`，8列×9行，192×208px/帧）有 9 个状态行，但当前
`lib/client.js` 的 `ANIMS` 只定义了 3 个（idle / waving / jumping），其余 6 行
（running-right、running-left、failed、waiting、running、review）从未显示；且插件
`inject: []` 不接入任何 dsh 服务，完全不感知 Agent 状态。9 行素材中 6 行正是为
Agent 运行状态（运行、等待、评审、报错）设计的，缺少从 Agent 状态到动画的通路。

## 2. 目标

桌宠实时反映 Agent 状态：9 个素材行全部驱动；用户切换会话时桌宠跟随新会话的
状态；保留并改造现有交互（拖拽、点击、隐藏）。

## 3. Agent 状态 → 动画映射与优先级

优先级从高到低（高优先级状态出现时覆盖低优先级）：

| 优先级 | 桌宠状态 | 信号来源 | 素材行 | 播放方式 |
|---|---|---|---|---|
| 1 | 报错 | `session.lastAgentError != null` | row 5 failed | 播放一次，定格最后一帧，直到错误清除 |
| 2 | 等待审批/提问 | `pendingInteraction: 'approval' \| 'question'` | row 6 waiting | 循环 |
| 3 | 计划评审 | `pendingInteraction: 'plan-review'` | row 8 review | 循环 |
| 4 | 运行中 | `running === true` | row 7 running | 循环（对应 GUI 中持续前进的进度条语义） |
| 5 | 空闲 | 以上皆否（含无会话） | row 0 idle | 循环 |

信号来源均为当前会话（`sessions.list` 快照的 `current`）：
`running`/`pendingInteraction` 取自 `byId[current]` 列表条目；
`lastAgentError` 取自 `sessions.binding(current)?.session` 会话快照。
`current === undefined` 或 `byId[current]` 缺失（地址链断裂等理论场景）→ idle。

## 4. 会话切换跟随

- 订阅 `sessions.list`；GUI 中切换会话会更新快照的 `current`。
- `current` 变化时：释放旧会话订阅 → 通过 `sessions.binding(id)?.session`
  订阅新会话快照（若 binding 尚不存在则仅依赖列表条目，binding 可用后再补订阅）→
  重算桌宠状态并切换动画。
- 子代理会话天然覆盖：`byId[current]` 包含子代理条目（`origin: 'subagent'`），
  其 `running` 反映子代理活动；切换到子代理时桌宠跟随子代理状态。
- `current === undefined`（无会话）→ idle。
- 会话快照的 `lastAgentError` 从非空变空视为一次状态变化（failed → 恢复）。

## 5. 交互设计

| 交互 | 行为 |
|---|---|
| 单击 | 挥手一次（wave，one-shot，结束后恢复常驻 Agent 状态动画） |
| 双击 | 跳跃一次（jump，one-shot）。用约 260ms 点击窗口区分：第一击暂缓挥手，窗口内第二击到达则取消挥手改为跳跃 |
| 拖拽 | 移动桌宠（位置记忆保持不变）。拖拽中水平位移 dx<0 → row 2 向左跑；dx>0 → row 1 向右跑；纯垂直拖动保持当前动画。松手后恢复常驻动画。**260ms 单击窗口内开始拖拽时，取消暂缓的挥手定时器**（否则挥手会打断方向跑动画） |
| 悬停 | 桌宠右上角浮现小 ✕ 关闭按钮；点击隐藏（持久化到 localStorage，键沿用现有 HIDDEN_KEY）。**✕ 按钮的 `pointerdown` 必须 `stopPropagation`**，否则事件冒泡到根元素会误入拖拽态 |
| 隐藏后恢复 | 原位置显示一枚半透明小徽章（约 36px，桌宠头像图样），悬停提示"显示桌宠"，点击恢复显示。徽章位置跟随保存的桌宠位置（复用现有视口钳制逻辑） |
| 空闲自动 | 仅 idle 期间：每 12~30s 自动挥手一次；每 45~90s 偶尔自动跳跃一次。Agent 忙碌时不自动触发 |
| 主动点击 | 任何 Agent 状态下均响应（作为临时覆盖层动画，结束后恢复常驻动画） |
| reduce-motion | 桌宠静止：显示当前 Agent 状态的静态帧（随状态切换更新）；自动动画、点击动画与拖拽方向跑全部禁用（拖拽仅移动位置） |

## 6. 动画状态机改造（lib/client.js）

两层结构替换现有单层 `playState`：

- **常驻层** `agentAnim`：由 Agent 状态推导（第 3 节映射）。failed 为特殊
  one-shot：播放一次后定格最后帧，直到错误清除才切换。
- **覆盖层**：wave / jump / 拖拽方向跑，临时动画；结束时 `play(agentAnim)` 恢复
  常驻层。覆盖层播放期间 Agent 状态变化仅更新 `agentAnim` 变量，不打断覆盖层。

现有问题一并修复：

- reduce-motion 固定显示 idle 第 0 帧 → 改为显示当前状态静态帧。
- waveTimer 在跳跃/点击触发时未清理 → 触发覆盖层动画时取消定时器。
- 隐藏时 rAF 持续运行 → 隐藏时暂停 rAF，恢复显示时重启。
- failed 定格不引入额外计时器：rAF 每帧重设 failed 最后帧即可（与现有
  `setFrame` 幂等设计一致）。

**可测试性**：状态推导（`byId[current]` + 会话快照 → 动画行）提炼为纯函数，
便于 node 冒烟脚本直接断言；事件交互（单击/双击/拖拽/✕）依赖真实 DOM，由
jsdom 或浏览器手工验证覆盖。

## 7. 数据接入（dsh 服务）

- 插件返回对象形式 `{ inject: ["sessions"], apply(ctx) }`（现有
  `exports.inject = []` 扩展为 `["sessions"]`）。dsh 客户端运行器的 ctx 门卫只放行
  `inject` 中声明的服务；运行器会在 sessions 服务就绪后才 apply。
- `ctx.sessions.list`：快照存储，`subscribe(listener)` + `getSnapshot()`；
  快照形状 `{ ids, byId, current, phase, ... }`，
  `byId[id] = { running, pendingInteraction?, origin?, ... }`。
- `ctx.sessions.binding(id)`：返回 `{ sessionId, session, ctx } | undefined`；
  `session` 为快照存储，`getSnapshot().lastAgentError`。
- 订阅清理：会话切换与插件卸载（ctx.effect）时释放订阅。
- 不采用自建轮询 / 自建 WebSocket（重复 runtime 已实现的重连与去重）。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 主体改动：ANIMS 扩展为 9 行；两层动画状态机；sessions 订阅与状态推导；交互改造（单击挥手、双击跳跃、拖拽方向跑、✕ 按钮 + 恢复徽章） |
| `README.md` | 更新 Interactions 表、"How it works" 段（注入 sessions 服务；含第 79 行 "no host services, no inject edges" 的过时表述）、中文段 |
| `lib/index.js` / `package.json` / `pet.json` | 不改动 |

## 9. 验证方案

1. `node --check lib/client.js` 语法检查。
2. node 冒烟脚本：mock `window.__ModuleLoader__` 与假 `ctx.sessions`（可控快照
   存储），驱动状态切换断言动画行选择：idle → running → waiting → review →
   failed（定格）→ 错误清除恢复；会话切换（current 变更）跟随新会话状态；
   单击/双击/拖拽映射到对应动画行。
3. 真实浏览器验证：`dsh --profile web` 实测（需真实 Agent 运行产生各状态），
   由用户在开发环境执行。

## 10. 非目标（YAGNI）

- 不接入子代理目录（subagentsByParent）的聚合状态——只跟随 `current`。
- 不做状态切换过渡动画（淡入淡出）——直接切帧。
- 不为 waiting/review 增加差异化音效、气泡文字等。
- 不提供桌宠配置界面（大小、位置、动画开关）。
