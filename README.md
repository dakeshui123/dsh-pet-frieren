<div align="center">

<h1>Frieren桌宠</h1>

<p>A chibi <b>Frieren</b> desktop pet for the <b>DeepSeek Harness Web GUI</b>
(<code>dsh --profile web</code>).</p>

<p>Idles beside your workspace · follows the Agent's state · waves on its own ·
click to wave, double-click to jump · draggable · remembers where you left it.</p>

<p>
  <a href="#install">Install</a> · <a href="#interactions">Interactions</a> ·
  <a href="#how-it-works">How it works</a> · <a href="#development">Development</a>
</p>

</div>

---

## Install

One command. The plugin installs into the `web` profile as a standard
[dsh bundle](https://github.com/deepseek-ai/deepseek-harness) (the same
mechanism the bundled dsh web surfaces use):

```sh
dsh plugin --profile web add github:dakeshui123/dsh-pet-frieren
```

Then (re)start the GUI and Frieren is there:

```sh
dsh --profile web
```

- **Update:** `dsh plugin --profile web update dsh-pet-frieren`
- **Pin a release:** `dsh plugin --profile web add github:dakeshui123/dsh-pet-frieren#v0.1.0`
- **Remove:** `dsh plugin --profile web remove dsh-pet-frieren`
- **Install from git directly:**
  `dsh plugin --profile web add git+https://github.com/dakeshui123/dsh-pet-frieren.git`

> The plugin ships its client bundle prebuilt (no `prepare`/build step), so it
> installs cleanly with any pnpm version — no `allowBuilds` fiddling required.

## Interactions

| Action | Effect |
| --- | --- |
| (nothing) | Follows the Agent: idle loop while free; runs while working; waits on approvals/questions; reviews plan-mode plans; collapses on agent errors (holds the last failed frame until the error clears). Switching sessions switches the pet's state with it. |
| Wait (idle only) | Waves every 12–30 s, occasionally jumps every 45–90 s |
| Click | Wave once |
| Double-click | Jump once |
| Drag | Move the pet (position is remembered); running-left/right while dragged sideways |
| Hover | A small ✕ appears in the corner — click to hide the pet |
| Hidden | A small translucent badge stays where the pet was — click to bring it back |

`prefers-reduced-motion` is respected: the pet shows a static frame of the
current agent state (no auto or click animations, no drag run animation).

## How it works

A dsh plugin is an npm package that declares `dsh.bundle.patch` (a
`cordis.patch.yml` profile layer) plus a `dsh.client` browser half:

```text
dsh-pet-frieren/
├── package.json          dsh.bundle.patch → cordis.patch.yml;
│                         dsh.client { platform: "web" } → exports["./client"]
├── cordis.patch.yml      inserts the plugin's own row into the web profile
├── lib/index.js          node half: serves the runtime assets over HTTP
├── lib/client.js         browser half: the pet overlay (prebuilt bundle)
├── assets/spritesheet.webp   runtime atlas (cwebp-optimized; served by the node half)
├── pet.json              petdex-format pet manifest
└── spritesheet.webp      petdex v1 atlas, lossless canonical: 8×9 grid of 192×208 px frames
```

At boot, the dsh `client-modules` node half scans the profile's Loader
entries for `dsh.client` packages, serves `/plugins/dsh-pet-frieren/client.js`,
and injects the boot graph into the page. The browser Loader then materializes
the bundle and calls its `apply(ctx)`, which mounts the pet — a
self-contained DOM overlay animated with `requestAnimationFrame` (no React;
one inject edge: the `sessions` service).

The pet reflects the Agent's state through the client runtime's `sessions`
service: the plugin declares `inject: ["sessions"]`, subscribes to
`sessions.list` (the current session's `running` and `pendingInteraction`),
and to the current session's live snapshot (`lastAgentError`). The mapping:

| Agent state | Sprite row |
| --- | --- |
| Agent error (`lastAgentError`) | failed (plays once, holds last frame) |
| Waiting on approval / question | waiting |
| Plan-mode plan review | review |
| Running | running |
| Idle (default) | idle |

Assets follow the same host-serves / client-reads pattern the dsh bundles
use (the web-app bundle serves its frontend dist the same way): the node half
injects the host `webServer` service and registers the
`/dsh-plugin-assets/dsh-pet-frieren` prefix route, which serves
`assets/spritesheet.webp` (a fixed allowlist — no path traversal surface).
The browser half references the sprite as a plain URL in CSS, so the image is
a normal browser-cached HTTP asset instead of being embedded in the bundle.

## Development

`lib/client.js` is a hand-written bundle in the exact
`window.__ModuleLoader__.load` shape the dsh web module system consumes, so no
build step is needed to ship. The runtime atlas under `assets/` is generated
from the canonical lossless `spritesheet.webp`:

```sh
python scripts/build-assets.py   # requires cwebp on PATH
```

## Pet format

This repository root is also a valid [Petdex](https://petdex.dev)-format pet
folder (`pet.json` + `spritesheet.webp`), so the same art can be submitted to
the Petdex gallery (`npx petdex submit .`). Frame counts used by the
animations match the populated cells of the atlas:

| row | state | frames |
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

## License & IP

Code and this fan-art arrangement: [MIT](./LICENSE).
"Frieren" is a character from *Frieren: Beyond Journey's End*
(葬送のフリーレン) by Kanehito Yamada and Tsukasa Abe; the artwork here is
personal, non-commercial fan art. See [LICENSE](./LICENSE) for the full note.

---

<div align="center">

### 中文

在 **DeepSeek Harness 网页版**（`dsh --profile web`）里养一只 Q 版芙莉莲桌宠。
它会跟随 Agent 状态：空闲发呆、运行时小跑、等待审批/提问时等待、计划评审时审阅、
报错时扑倒（定格到错误清除）；切换会话时桌宠随之切换。空闲时会自己挥手、偶尔跳一下；
单击挥手、双击跳跃、拖拽移动（左右拖会朝对应方向跑）、悬停出现 ✕ 可隐藏、隐藏后
点原地小徽章恢复。

**安装（一条命令）：**

```sh
dsh plugin --profile web add github:dakeshui123/dsh-pet-frieren
```

然后启动 `dsh --profile web` 即可看到芙莉莲。卸载：
`dsh plugin --profile web remove dsh-pet-frieren`。

角色版权说明：芙莉莲出自山田钟人原作、阿部司作画的《葬送的芙莉莲》，
本仓库素材为个人非商用同人作品，详见 [LICENSE](./LICENSE)。

</div>
