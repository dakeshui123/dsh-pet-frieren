<div align="center">

<h1>Frieren桌宠</h1>

<p>一只 Q 版<b>芙莉莲</b>桌宠，陪伴 <b>DeepSeek Harness 网页版</b>
（<code>dsh --profile web</code>）。</p>

<p>在屏幕角落发呆 · 跟随 Agent 状态变化 · 会自己挥手 ·
单击挥手、双击跳跃 · 可拖拽 · 记住你放的位置。</p>

<p>
  <a href="#安装">安装</a> · <a href="#交互">交互</a> ·
  <a href="#工作原理">工作原理</a> · <a href="#开发">开发</a>
</p>

</div>

---

## 安装

一条命令，作为标准 dsh bundle 安装到 `web` profile：

```sh
dsh plugin --profile web add github:dakeshui123/dsh-pet-frieren
```

然后（重新）启动网页版，芙莉莲就出现了：

```sh
dsh --profile web
```

- **更新：** `dsh plugin --profile web update dsh-pet-frieren`
- **固定版本：** `dsh plugin --profile web add github:dakeshui123/dsh-pet-frieren#v0.1.0`
- **卸载：** `dsh plugin --profile web remove dsh-pet-frieren`

> 插件自带预构建的客户端 bundle（无 prepare/构建步骤），任何 pnpm 版本
> 都能干净安装。

## 交互

| 操作 | 效果 |
| --- | --- |
| （无操作） | 跟随 Agent 状态：空闲时发呆循环；模型思考时等待；流式输出时小跑；调用工具时执行；等待审批/提问时等待；计划评审时审阅；Agent 报错时扑倒（定格最后一帧直到错误清除）。切换会话时桌宠随之切换。 |
| 状态切换 | 头顶冒出对应台词气泡（约 3.5 秒后淡出） |
| 等待（仅空闲时） | 每 12–30 秒自动挥手一次，每 45–90 秒偶尔跳一下，每 20–40 秒闲聊一句 |
| 单击 | 挥手一次 |
| 双击 | 跳跃一次 |
| 拖拽 | 移动桌宠（位置会被记住）；左右拖拽时朝对应方向跑 |
| 悬停 | 角落浮现小 ✕，点击隐藏桌宠 |
| 隐藏小徽章 | 点击恢复显示；拖拽移动桌宠的位置 |

系统开启"减少动态效果"（`prefers-reduced-motion`）时，桌宠只显示当前
Agent 状态的静态帧（无自动/点击动画，拖拽只移动不播动画）。

## 工作原理

dsh 插件是一个声明了 `dsh.bundle.patch`（cordis 配置层）和 `dsh.client`
浏览器半身的 npm 包：

```text
dsh-pet-frieren/
├── package.json          dsh.bundle.patch → cordis.patch.yml；
│                         dsh.client { platform: "web" } → exports["./client"]
├── cordis.patch.yml      把插件自己的行插入 web profile
├── lib/index.js          node 半身：通过 HTTP 提供运行时素材
├── lib/client.js         浏览器半身：桌宠 overlay（预构建 bundle）
├── assets/spritesheet.webp   petdex v1 图集：8×9 网格、每帧 192×208 px
├── assets/pet.json       petdex 格式宠物清单（assets/ 即宠物文件夹）
├── test/client.test.js   零依赖冒烟测试（`node --test`）
├── README.zh.md          中文说明
└── 使用说明.md            中文使用说明
```

启动时，dsh 的 `client-modules` node 半身扫描 profile Loader 中的
`dsh.client` 包，提供 `/plugins/dsh-pet-frieren/client.js` 并把启动图注入
页面。浏览器 Loader 物化 bundle 后调用其 `apply(ctx)`，挂载桌宠——一个
用 `requestAnimationFrame` 驱动的自包含 DOM overlay（无 React；仅一条
inject 边：`sessions` 服务）。

桌宠通过客户端运行时的 `sessions` 服务反映 Agent 状态：插件声明
`inject: ["sessions"]`，订阅 `sessions.list`（当前会话的 `running` 与
`pendingInteraction`）以及当前会话的实时快照（`lastAgentError`、
`runningCalls`、`partial`）。映射：

| Agent 状态 | 图集行 |
| --- | --- |
| Agent 报错（`lastAgentError`） | failed（播放一次，定格最后一帧） |
| 等待审批 / 提问 | waiting |
| 计划评审（plan mode） | review |
| 思考中（运行中，尚无工具调用） | waiting |
| 工具调用执行中（`runningCalls`） | review |
| 流式输出中（`partial`） | running |
| 空闲（默认） | idle |

素材与 dsh bundle 采用相同的"宿主提供 / 客户端读取"模式（web-app bundle
同样方式提供其前端 dist）：node 半身注入宿主 `webServer` 服务，注册
`/dsh-plugin-assets/dsh-pet-frieren` 前缀路由，提供 `assets/spritesheet.webp`
（固定白名单，无路径穿越面）。浏览器半身在 CSS 中以普通 URL 引用图片，
因此素材是普通的浏览器缓存 HTTP 资源，而不是内嵌在 bundle 里。

## 开发

`lib/client.js` 是精确匹配 dsh web 模块系统所消费的
`window.__ModuleLoader__.load` 形态的手写 bundle，因此发布无需构建步骤。
唯一的图集存放在 `assets/`，由 node 半身原样提供。测试零依赖：

```sh
node --test
```

## 宠物格式

`assets/` 文件夹同时是一个合法的 [Petdex](https://petdex.dev) 格式宠物
文件夹（`pet.json` + `spritesheet.webp`），同一套素材可以提交到 Petdex
画廊（`npx petdex submit assets`）。动画使用的帧数与图集已填充单元格一致：

| 行 | 状态 | 帧数 |
| --- | --- | --- |
| 0 | idle | 6 |
| 1 | running-right | 8 |
| 2 | running-left | 8 |
| 3 | waving | 4 |
| 4 | jumping | 5 |
| 5 | failed | 8 |
| 6 | waiting | 6 |
| 7 | running | 6 |
| 8 | review | 6 |

## 许可与版权

代码与同人素材编排：[MIT](./LICENSE)。
芙莉莲出自山田钟人原作、阿部司作画的《葬送的芙莉莲》，本仓库素材为个人
非商用同人作品，详见 [LICENSE](./LICENSE)。
