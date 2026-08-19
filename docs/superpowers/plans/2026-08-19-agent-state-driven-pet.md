# Agent-State-Driven Pet 实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-pet-frieren 桌宠实时反映 Agent 状态（9 个素材行全部驱动），并改造交互为单击挥手、双击跳跃、拖拽方向跑、✕ 按钮隐藏 + 徽章恢复。

**Architecture:** 客户端 bundle（lib/client.js，单文件手写 bundle）通过对象形式插件 `{inject:["sessions"], apply(ctx)}` 注入 dsh 的 `sessions` 服务；订阅 `sessions.list`（当前会话的 running/pendingInteraction）与 `sessions.binding(id).session`（lastAgentError），用纯函数 `deriveAgentAnim` 推导常驻动画；两层动画状态机（常驻 Agent 状态层 + wave/jump/拖拽方向跑覆盖层）。测试为零依赖 node:test + DOM stub 冒烟测试（test/client.test.js）。

**Tech Stack:** 手写 ES5 风格浏览器 bundle（无构建步骤）、node:test（node v24 内置）、dsh sessions 快照存储（subscribe/getSnapshot）。

**规格文档（已获用户批准）：** `docs/superpowers/specs/2026-08-19-agent-state-driven-pet-design.md`

**执行注意：所有行号锚点基于各任务编辑前的文件；前序编辑会使行号整体后移（README 的 Interactions 表替换后其后续段落会下移 2 行），定位编辑点按"内容匹配"而非行号。**

---

## 关键外部 API 事实（执行者必读，已逐条核对 dsh 0.1.0-rc.7 源码）

这些事实来自对 dsh 全局安装的源码核对，执行时不要再猜测：

1. **插件形状**：`window.__ModuleLoader__.load({id, factory})` 注册不变；工厂返回对象
   `{inject: [...], apply(ctx)}`。ctx 是门卫代理：只有 `inject` 数组声明的服务才能通过
   `ctx.xxx` 访问，否则抛错。运行器会在声明的服务就绪后才调用 apply。
2. **ctx 可用框架方法**（无需声明）：`ctx.effect(fn)`（fn 可返回清理函数，纤维卸载时调用）、
   `ctx.on` / `ctx.once` / `ctx.provide`。
3. **`ctx.sessions.list`**：快照存储，`getSnapshot()` 返回
   `{ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress}`；
   `byId[id] = {id, displayTitle, running, blank, updatedAt, pendingInteraction?, origin?, ...}`；
   `pendingInteraction ∈ 'approval' | 'question' | 'plan-review'`。`subscribe(listener)` 返回退订函数。
4. **`ctx.sessions.binding(id)`**：返回 `{sessionId, session, ctx} | undefined`；
   `session` 是快照存储，`subscribe(listener)` + `getSnapshot()`；
   `getSnapshot().lastAgentError`（string|null）。
5. **素材 atlas**：8列×9行，帧 192×208px，显示 168×182px（SHEET_W=1344, SHEET_H=1638）。
   行号：0 idle(6f) 1 runningRight(8f) 2 runningLeft(8f) 3 waving(4f) 4 jumping(5f)
   5 failed(8f) 6 waiting(6f) 7 running(6f) 8 review(6f)。
6. **状态优先级**（规格 §3）：failed > waiting > review > running > idle；
   `current === undefined` 或 `byId[current]` 缺失 → idle。
7. **测试加载方式**：bundle 无 import/export，可在 node 中 `globalThis.window = {...}` 后
   `await import(pathToFileURL("../lib/client.js"))` 加载；`__ModuleLoader__.load` 捕获注册记录，
   `factory(() => ({}))` 得到插件对象。DOM 用测试内 stub 模拟（无 jsdom 依赖）。

---

## Chunk 1: Task 1 — 测试基座 + ANIMS 9 行 + deriveAgentAnim 纯函数

**Files:**
- Create: `test/client.test.js`
- Modify: `lib/client.js:44-48`（ANIMS 表）
- Modify: `lib/client.js:282-284`（导出 deriveAgentAnim）

- [ ] **Step 1: 编写测试基座与失败测试**

创建 `test/client.test.js`：

```js
/**
 * Zero-dependency smoke tests for the dsh-pet-frieren client bundle.
 * Run: node --test test/
 *
 * Loads the hand-written bundle into a stubbed DOM/window, then drives the
 * pet through a fake `sessions` service and synthetic pointer events,
 * asserting sprite row selection per the design spec:
 * docs/superpowers/specs/2026-08-19-agent-state-driven-pet-design.md
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/* ── bundle constants (must stay in sync with lib/client.js) ─────────────── */
const DISPLAY_W = 168, DISPLAY_H = 182;
const ROW = {
	idle: 0, runningRight: 1, runningLeft: 2, waving: 3, jumping: 4,
	failed: 5, waiting: 6, running: 7, review: 8,
};

/* ── DOM stubs ───────────────────────────────────────────────────────────── */
function makeClassList() {
	const set = new Set();
	return {
		add: (c) => set.add(c),
		remove: (c) => set.delete(c),
		toggle: (c, force) => {
			if (force === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
			else if (force) set.add(c); else set.delete(c);
		},
		contains: (c) => set.has(c),
	};
}
function makeEl(tag) {
	const el = {
		tagName: String(tag || "div").toUpperCase(),
		style: {},
		children: [],
		attributes: {},
		listeners: {},
		parentNode: null,
		firstChild: null,
		dataset: {},
		classList: makeClassList(),
		setAttribute(k, v) { this.attributes[k] = String(v); },
		appendChild(c) {
			c.parentNode = this;
			this.children.push(c);
			if (!this.firstChild) this.firstChild = c;
			return c;
		},
		remove() {
			if (!this.parentNode) return;
			const i = this.parentNode.children.indexOf(this);
			if (i >= 0) this.parentNode.children.splice(i, 1);
		},
		addEventListener(t, f) { this.listeners[t] = f; },
		dispatch(t, e) { const f = this.listeners[t]; if (f) f(e || {}); },
		setPointerCapture() {},
	};
	return el;
}
function makeStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
	};
}
function makeMql() {
	const listeners = new Set();
	return {
		matches: false,
		// Replace semantics: every loadPlugin() re-runs the bundle factory and
		// registers a fresh updateReduceMotion closure; only the latest factory's
		// closure may fire (stale closures would crash on el === null).
		addEventListener(t, f) { if (t === "change") { listeners.clear(); listeners.add(f); } },
		removeEventListener() {},
		// No-op on unchanged value so resetEnv's setMatches(false) never fires
		// pre-mount closures.
		setMatches(v) { if (this.matches === v) return; this.matches = v; for (const f of [...listeners]) f(); },
	};
}

/* ── global window/document for the bundle ───────────────────────────────── */
const rafStub = {
	callback: null,
	requestAnimationFrame(cb) { this.callback = cb; return 1; },
	cancelAnimationFrame() { this.callback = null; },
	step(time) { const cb = this.callback; this.callback = null; if (cb) cb(time); },
	reset() { this.callback = null; },
};
const mql = makeMql();
const storage = makeStorage();
let registered = null;
globalThis.window = {
	__ModuleLoader__: { load: (rec) => { registered = rec; } },
	localStorage: storage,
	matchMedia: () => mql,
	innerWidth: 1280,
	innerHeight: 800,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	requestAnimationFrame: (cb) => rafStub.requestAnimationFrame(cb),
	cancelAnimationFrame: () => rafStub.cancelAnimationFrame(),
};
// Real lookups so apply() can remove the previous instance between tests
// (the bundle module state persists across tests in one process; the DOM
// must not accumulate stale pets).
globalThis.document = {
	head: makeEl("head"),
	body: makeEl("body"),
	createElement: (tag) => makeEl(tag),
	getElementById(id) {
		for (const c of this.body.children) if (c.id === id) return c;
		return null;
	},
	querySelector(sel) {
		if (sel.startsWith("style[data-plugin-css=")) {
			const id = JSON.parse(sel.slice("style[data-plugin-css=".length));
			for (const c of this.head.children) if (c.dataset.pluginCss === id) return c;
		}
		return null;
	},
};
// The bundle's loop() calls the bare `requestAnimationFrame` identifier,
// which resolves to window in browsers but is undefined in node.
globalThis.requestAnimationFrame = (cb) => rafStub.requestAnimationFrame(cb);
globalThis.cancelAnimationFrame = () => rafStub.cancelAnimationFrame();

const BUNDLE_URL = pathToFileURL(new URL("../lib/client.js", import.meta.url)).href;
await import(BUNDLE_URL);

function loadPlugin() {
	assert.ok(registered, "bundle did not register with __ModuleLoader__");
	return registered.factory(() => ({}));
}

/* ── fake sessions service ───────────────────────────────────────────────── */
function makeStore(initial) {
	let snap = initial;
	const listeners = new Set();
	return {
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		getSnapshot() { return snap; },
		set(next) { snap = next; for (const fn of [...listeners]) fn(); },
	};
}
function makeSessions() {
	const list = makeStore({ ids: [], byId: {}, current: undefined, phase: "ready" });
	const bindings = new Map();
	return {
		list,
		binding(id) { return bindings.get(id); },
		bind(id, session) { bindings.set(id, { sessionId: id, session, ctx: null }); },
	};
}
function makeFakeCtx(sessions) {
	return {
		sessions,
		effect(fn) { this._disposer = fn(); },
		on() {},
	};
}

/* ── sprite row helpers ──────────────────────────────────────────────────── */
function spriteRow(sprite) {
	const [x, y] = sprite.style.backgroundPosition.split(" ").map((v) => parseInt(v, 10));
	return { row: -y / DISPLAY_H, col: -x / DISPLAY_W };
}

/* ── test env reset (bundle module state persists across tests) ──────────── */
// All tests run under mocked timers: the bundle arms 12s/45s auto-animation
// timers on every mount, and real timers would keep the node event loop
// alive. mock.timers replaces globalThis.setTimeout, so re-sync window's
// references (captured at stub creation) after enabling.
function resetEnv() {
	mql.setMatches(false);
	storage.setItem("dsh-pet-frieren:hidden", "0");
	rafStub.reset();
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout"] });
	window.setTimeout = globalThis.setTimeout;
	window.clearTimeout = globalThis.clearTimeout;
}

/* ══ Task 1 tests: deriveAgentAnim ══════════════════════════════════════════ */
test("deriveAgentAnim: no item, no snapshot → idle", () => {
	const plugin = loadPlugin();
	assert.equal(plugin.deriveAgentAnim(undefined, undefined).name, "idle");
});
test("deriveAgentAnim: running item → running", () => {
	const plugin = loadPlugin();
	assert.equal(plugin.deriveAgentAnim({ running: true }, undefined).name, "running");
});
test("deriveAgentAnim: pendingInteraction approval → waiting", () => {
	const plugin = loadPlugin();
	assert.equal(plugin.deriveAgentAnim({ running: true, pendingInteraction: "approval" }, undefined).name, "waiting");
	assert.equal(plugin.deriveAgentAnim({ running: true, pendingInteraction: "question" }, undefined).name, "waiting");
});
test("deriveAgentAnim: pendingInteraction plan-review → review", () => {
	const plugin = loadPlugin();
	assert.equal(plugin.deriveAgentAnim({ running: true, pendingInteraction: "plan-review" }, undefined).name, "review");
});
test("deriveAgentAnim: lastAgentError beats everything → failed, hold", () => {
	const plugin = loadPlugin();
	const anim = plugin.deriveAgentAnim({ running: true, pendingInteraction: "approval" }, { lastAgentError: "boom" });
	assert.equal(anim.name, "failed");
	assert.equal(anim.once, true);
	assert.equal(anim.hold, true);
});
test("deriveAgentAnim: idle item → idle", () => {
	const plugin = loadPlugin();
	assert.equal(plugin.deriveAgentAnim({ running: false }, undefined).name, "idle");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/`
Expected: FAIL — `plugin.deriveAgentAnim` is not a function（导出尚不存在）。

- [ ] **Step 3: 实现 ANIMS 9 行与 deriveAgentAnim**

修改 `lib/client.js:44-48`，将现有 ANIMS 替换为：

```js
		// petdex v1 rows: idle, running-right, running-left, waving, jumping,
		// failed, waiting, running, review. Frame counts measured from the atlas.
		var ANIMS = {
			idle:         { row: 0, frames: 6, fps: 10 },
			runningRight: { row: 1, frames: 8, fps: 12 },
			runningLeft:  { row: 2, frames: 8, fps: 12 },
			waving:       { row: 3, frames: 4, fps: 12 },
			jumping:      { row: 4, frames: 5, fps: 14 },
			failed:       { row: 5, frames: 8, fps: 8 },
			waiting:      { row: 6, frames: 6, fps: 8 },
			running:      { row: 7, frames: 6, fps: 12 },
			review:       { row: 8, frames: 6, fps: 8 },
		};
```

在 ANIMS 之后、POS_KEY 之前插入纯函数：

```js
		/**
		 * Derive the pet's persistent agent-state animation from the current
		 * session's list entry and live session snapshot. Pure: exported for
		 * the zero-dependency smoke tests. Priority per design spec:
		 * failed > waiting > review > running > idle.
		 * @param item - sessions.list byId[current] entry, or undefined.
		 * @param sessionSnap - sessions.binding(current).session snapshot, or null.
		 * @returns {{name: string, once: boolean, hold: boolean}}
		 */
		function deriveAgentAnim(item, sessionSnap) {
			if (sessionSnap && sessionSnap.lastAgentError) return { name: "failed", once: true, hold: true };
			if (item) {
				var pending = item.pendingInteraction;
				if (pending === "approval" || pending === "question") return { name: "waiting", once: false, hold: false };
				if (pending === "plan-review") return { name: "review", once: false, hold: false };
				if (item.running) return { name: "running", once: false, hold: false };
			}
			return { name: "idle", once: false, hold: false };
		}
```

修改 `lib/client.js:282-284`，导出增加：

```js
		exports.apply = apply;
		exports.inject = [];
		exports.deriveAgentAnim = deriveAgentAnim;
		return module.exports;
```

（`inject: []` 在 Task 2 再改为 `["sessions"]`；此时运行时仍走旧 3 动画逻辑，本任务纯增量，行为不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/`
Expected: PASS（6 个 deriveAgentAnim 测试通过）。

- [ ] **Step 5: 提交**

```bash
git add test/client.test.js lib/client.js
git commit -m "test: add zero-dep smoke harness; expand ANIMS to all 9 atlas rows with deriveAgentAnim"
```

**Chunk 1 完成后：派发 plan-document-reviewer 审查本 Chunk。**

---

## Chunk 2: Task 2 — sessions 接入 + 两层动画状态机

**Files:**
- Modify: `lib/client.js`（play/step 重写、sessions 接线、mount/apply、exports.inject）
- Modify: `test/client.test.js`（追加 Task 2 测试）

- [ ] **Step 1: 编写失败测试（追加到 test/client.test.js 末尾）**

```js
/* ══ Task 2 tests: sessions-driven state machine ════════════════════════════ */
function mountPet(sessions) {
	const plugin = loadPlugin();
	const ctx = makeFakeCtx(sessions);
	plugin.apply(ctx);
	const root = document.body.children.find((c) => c.id === "dsh-pet-frieren");
	assert.ok(root, "pet root not mounted");
	return { root, sprite: root.firstChild, ctx };
}
function setCurrent(sessions, id, item) {
	sessions.list.set({ ids: [id], byId: { [id]: item }, current: id, phase: "ready" });
}
function elapse(ms) {
	const t0 = performance.now();
	let t = t0;
	while (t < t0 + ms) { t += 34; rafStub.step(t); }
}

test("mount with no session → idle row 0", () => {
	resetEnv();
	const sessions = makeSessions();
	const { sprite } = mountPet(sessions);
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
});
test("agent running → row 7 loop; back to idle when stopped", () => {
	resetEnv();
	const sessions = makeSessions();
	const { sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.running);
	setCurrent(sessions, "s1", { id: "s1", running: false, blank: false, updatedAt: 2 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
});
test("pendingInteraction approval → waiting; plan-review → review", () => {
	resetEnv();
	const sessions = makeSessions();
	const { sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, pendingInteraction: "approval", blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.waiting);
	setCurrent(sessions, "s1", { id: "s1", running: true, pendingInteraction: "plan-review", blank: false, updatedAt: 2 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.review);
});
test("lastAgentError → failed: plays once then holds last frame; clears on error reset", () => {
	resetEnv();
	const sessions = makeSessions();
	const session = makeStore({ sessionId: "s1", lastAgentError: null, running: false });
	sessions.bind("s1", session);
	const { sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: false, blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
	session.set({ sessionId: "s1", lastAgentError: "boom", running: false });
	elapse(2000); // failed: 8 frames @ 8fps = 1s total; well past it
	assert.equal(spriteRow(sprite).row, ROW.failed);
	assert.equal(spriteRow(sprite).col, 7); // held on last frame
	elapse(1000);
	assert.equal(spriteRow(sprite).col, 7); // still held
	session.set({ sessionId: "s1", lastAgentError: null, running: false });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
});
test("session switch rebinds: pet follows the new current session", () => {
	resetEnv();
	const sessions = makeSessions();
	const { sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.running);
	const session2 = makeStore({ sessionId: "s2", lastAgentError: null, running: false });
	sessions.bind("s2", session2); // bind BEFORE switching so followCurrent can subscribe
	setCurrent(sessions, "s2", { id: "s2", running: false, blank: false, updatedAt: 2 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
	session2.set({ sessionId: "s2", lastAgentError: "oops", running: false });
	elapse(2000);
	assert.equal(spriteRow(sprite).row, ROW.failed);
});
test("click jump is an overlay: resumes agent animation (double-click shape stays valid after the click rework in Task 3)", () => {
	resetEnv();
	const sessions = makeSessions();
	const { root, sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.running);
	// Task 2 intermediate code: each click jumps. Task 3: first click arms the
	// wave window, the second consumes it as a jump. Either way → jumping.
	root.dispatch("pointerdown", { clientX: 10, clientY: 10, button: 0, pointerId: 1, preventDefault() {} });
	root.dispatch("pointerup", { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
	root.dispatch("pointerdown", { clientX: 10, clientY: 10, button: 0, pointerId: 1, preventDefault() {} });
	root.dispatch("pointerup", { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
	elapse(120); // jumping: 5 frames @ 14fps ≈ 357ms; mid-animation
	assert.equal(spriteRow(sprite).row, ROW.jumping);
	elapse(600); // past total → resumes running
	assert.equal(spriteRow(sprite).row, ROW.running);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/`
Expected: Task 1 测试仍 PASS；Task 2 测试中除"mount with no session → idle"（旧代码亦过）外全部 FAIL（sessions 未接线，无状态切换）。

- [ ] **Step 3: 实现两层状态机（替换 play/step）**

替换 `lib/client.js:98-117`（原 `play` 与 `step`）：

```js
		/**
		 * Two-layer animation state machine. The persistent layer is
		 * `agentAnim` (derived from agent state); overlays (wave/jump/drag
		 * run) play once (or until the drag ends) and resume `agentAnim`.
		 */
		var agentAnim = { name: "idle", once: false, hold: false };
		var playState = null; // { anim, started, once, hold, overlay, done, onDone }

		function play(name, opts) {
			opts = opts || {};
			playState = {
				anim: ANIMS[name],
				started: performance.now(),
				once: !!opts.once,
				hold: !!opts.hold,
				overlay: !!opts.overlay,
				done: false,
				onDone: opts.onDone || null,
			};
		}
		function playAgentAnim(anim) {
			play(anim.name, { once: anim.once, hold: anim.hold, overlay: false });
		}
		function playOverlay(name, onDone) {
			play(name, { once: true, overlay: true, onDone: onDone || null });
		}

		function step(now) {
			var state = playState;
			if (!state || state.done) return;
			var interval = 1000 / state.anim.fps;
			var total = state.anim.frames * interval;
			var elapsed = now - state.started;
			var finished = state.once && elapsed >= total;
			var index = finished ? state.anim.frames - 1 : Math.floor(elapsed / interval) % state.anim.frames;
			setFrame(state.anim, index);
			if (finished) {
				var done = state.onDone;
				if (state.hold) {
					state.done = true; // keep the last frame; no extra timer
				} else {
					playAgentAnim(agentAnim);
					scheduleAuto();
				}
				if (done) done();
			}
		}
```

（`scheduleAuto` 是 Step 4 中的函数声明，工厂作用域内声明提升，step 中调用无 ReferenceError 风险。）

- [ ] **Step 4: 实现 sessions 接线（替换调度段与 mount/apply/exports）**

替换 `lib/client.js:150-174`（`isHidden/setHidden/scheduleWave/jump`）为：

```js
		/* ── visibility / scheduling ─────────────────────────────────────────── */
		function isHidden() {
			return el.classList.contains("hidden");
		}
		var waveTimer = 0, jumpTimer = 0;
		function clearAuto() {
			if (waveTimer) { window.clearTimeout(waveTimer); waveTimer = 0; }
			if (jumpTimer) { window.clearTimeout(jumpTimer); jumpTimer = 0; }
		}
		function autoAllowed() {
			return !reduceMotion && !isHidden() && !drag && agentAnim.name === "idle"
				&& !(playState && playState.overlay && !playState.done);
		}
		function scheduleAuto() {
			clearAuto();
			if (!autoAllowed()) return;
			waveTimer = window.setTimeout(function () {
				waveTimer = 0;
				if (!autoAllowed()) { scheduleAuto(); return; }
				playOverlay("waving", scheduleAuto);
			}, 12000 + Math.random() * 18000);
			jumpTimer = window.setTimeout(function () {
				jumpTimer = 0;
				if (!autoAllowed()) { scheduleAuto(); return; }
				playOverlay("jumping", scheduleAuto);
			}, 45000 + Math.random() * 45000);
		}
		function setHidden(hidden) {
			el.classList.toggle("hidden", hidden);
			badgeEl.classList.toggle("hidden", !hidden);
			writeHidden(hidden);
			if (hidden) {
				clearAuto();
				// Spec §5: the badge stays where the pet was left — always
				// re-apply the current (saved) position when hiding.
				var pos = currentPosition();
				applyBadgePosition(pos.x, pos.y);
				if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
			} else {
				playAgentAnim(agentAnim);
				if (!reduceMotion && !rafId) rafId = window.requestAnimationFrame(loop);
				scheduleAuto();
			}
		}
```

在 `setHidden` 之前插入 sessions 接线块：

```js
		/* ── sessions wiring: follow the GUI's current session ───────────────── */
		var sessionsService = null;
		var listUnsubscribe = null;
		var sessionUnsubscribe = null;
		var sessionSnapshot = null; // latest live session snapshot (or null)
		var watchedId = undefined;
		var cleanup = null;

		function releaseSession() {
			if (sessionUnsubscribe) { sessionUnsubscribe(); sessionUnsubscribe = null; }
			sessionSnapshot = null;
		}
		function currentItem() {
			var snap = sessionsService.list.getSnapshot();
			return snap.current === undefined ? undefined : snap.byId[snap.current];
		}
		function deriveState() {
			var anim = deriveAgentAnim(currentItem(), sessionSnapshot);
			var changed = agentAnim.name !== anim.name || agentAnim.hold !== anim.hold;
			agentAnim = anim;
			if (reduceMotion) {
				if (changed) setFrame(ANIMS[anim.name], 0);
				scheduleAuto();
				return;
			}
			if (playState && playState.overlay && !playState.done) { scheduleAuto(); return; }
			if (!changed) { scheduleAuto(); return; } // held failed keeps its last frame
			playAgentAnim(anim);
			scheduleAuto();
		}
		function attachSession(id) {
			var binding = sessionsService.binding(id);
			var session = binding && binding.session;
			if (session && typeof session.subscribe === "function") {
				sessionSnapshot = session.getSnapshot();
				sessionUnsubscribe = session.subscribe(function () {
					sessionSnapshot = session.getSnapshot();
					deriveState();
				});
			}
		}
		function followCurrent() {
			var snap = sessionsService.list.getSnapshot();
			var id = snap.current;
			if (id !== watchedId) {
				watchedId = id;
				releaseSession();
			}
			// Spec §4: retry binding on later list ticks if the binding was
			// not minted yet at switch time.
			if (id !== undefined && sessionUnsubscribe === null) attachSession(id);
			deriveState();
		}
		function wireSessions(ctx) {
			releaseAll();
			sessionsService = ctx.sessions;
			listUnsubscribe = sessionsService.list.subscribe(followCurrent);
			followCurrent();
			cleanup = function () {
				if (listUnsubscribe) { listUnsubscribe(); listUnsubscribe = null; }
				releaseSession();
			};
			ctx.effect(function () { return cleanup; });
		}
		function releaseAll() {
			if (cleanup) { cleanup(); cleanup = null; }
		}
```

（`badgeEl` 引用见 Task 3 的 buildElements；本任务先在 mount 中创建占位 badge 元素，Task 3 替换为完整实现。）

替换 `lib/client.js:196-227` 指针交互段：`onPointerUp` 保持不变（仍调用 `jump()`），
在 `onPointerCancel` 之后新增 `jump` 函数：

```js
		function jump() {
			if (reduceMotion || isHidden()) return;
			playOverlay("jumping", null);
		}
```

替换 `lib/client.js:230-267`（`buildElement`/`mount`）为（含占位 badge）：

```js
		function buildElements() {
			var root = document.createElement("div");
			root.id = PKG;
			root.setAttribute("role", "presentation");
			root.setAttribute("aria-hidden", "true");
			var frame = document.createElement("div");
			frame.className = "sprite";
			root.appendChild(frame);
			var badge = document.createElement("div");
			badge.id = PKG + "-badge";
			badge.className = "badge";
			return { root: root, badge: badge };
		}

		function mount(ctx) {
			var style = document.createElement("style");
			style.dataset.plugin = PKG;
			style.dataset.pluginCss = CSS_ID;
			style.textContent = CSS;
			document.head.appendChild(style);

			var built = buildElements();
			el = built.root;
			badgeEl = built.badge;
			document.body.appendChild(el);
			document.body.appendChild(badgeEl);
			sprite = el.firstChild;

			var pos = currentPosition();
			applyPosition(pos.x, pos.y);
			applyBadgePosition(pos.x, pos.y);

			el.addEventListener("pointerdown", onPointerDown);
			el.addEventListener("pointermove", onPointerMove);
			el.addEventListener("pointerup", onPointerUp);
			el.addEventListener("pointercancel", onPointerCancel);

			setHidden(readHidden());
			wireSessions(ctx);
			updateReduceMotion();
			// Unconditional, idempotent seed: the sprite must never show blank
			// between mount and the first rAF tick.
			setFrame(ANIMS[agentAnim.name], 0);
		}
```

`applyBadgePosition` 定义（放在 `applyPosition` 之后）：

```js
		function applyBadgePosition(x, y) {
			badgeEl.style.left = x + "px";
			badgeEl.style.top = y + "px";
		}
```

状态变量段（`lib/client.js:85-91`，原内容为 el/sprite/rafId/playState/waveTimer/drag/reduceMotion）整体替换为
（`playState` 移至 Step 3 的状态机块、`waveTimer`/`jumpTimer` 移至本步调度块声明，避免重复声明）：

```js
		/* ── runtime state ───────────────────────────────────────────────────── */
		var el = null;        // root overlay element
		var sprite = null;    // animated frame element
		var badgeEl = null;   // restore badge shown while hidden
		var rafId = 0;        // requestAnimationFrame handle
		var drag = null;      // { startX, startY, left, top, moved, dir }
		var reduceMotion = false;
```

替换 `lib/client.js:274-280` 的 `apply`：

```js
		function apply(ctx) {
			var previous = document.getElementById(PKG);
			if (previous) previous.remove();
			var previousBadge = document.getElementById(PKG + "-badge");
			if (previousBadge) previousBadge.remove();
			var previousStyle = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]");
			if (previousStyle) previousStyle.remove();
			mount(ctx);
		}
```

替换 `lib/client.js:282-284` 导出：

```js
		exports.apply = apply;
		exports.inject = ["sessions"];
		exports.deriveAgentAnim = deriveAgentAnim;
		return module.exports;
```

`updateReduceMotion`（`lib/client.js:178-190`，只替换函数体，保留 177 行的 `var mql = ...` 声明）改为使用当前 agentAnim 的静态帧：

```js
		function updateReduceMotion() {
			reduceMotion = !!(mql && mql.matches);
			if (reduceMotion) {
				clearAuto();
				if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
				playState = null;
				setFrame(ANIMS[agentAnim.name], 0);
			} else {
				playAgentAnim(agentAnim);
				if (!isHidden() && !rafId) rafId = window.requestAnimationFrame(loop);
				scheduleAuto();
			}
		}
```

删除原 `scheduleWave`（已被 `scheduleAuto` 取代）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/`
Expected: 全部 PASS（Task 1 6 个 + Task 2 6 个 = 12）。

- [ ] **Step 6: 提交**

```bash
git add lib/client.js test/client.test.js
git commit -m "feat: drive pet animations from agent state via ctx.sessions (two-layer state machine)"
```

**Chunk 2 完成后：派发 plan-document-reviewer 审查本 Chunk。**

---

## Chunk 3: Task 3 — 交互改造（单击挥手/双击跳跃/拖拽方向跑/✕ 按钮/徽章）

**Files:**
- Modify: `lib/client.js`（CSS 扩展、buildElements 完整版、指针交互、reduce-motion 下的拖拽）
- Modify: `test/client.test.js`（追加 Task 3 测试）

- [ ] **Step 1: 编写失败测试（追加到 test/client.test.js 末尾）**

```js
/* ══ Task 3 tests: interactions ═════════════════════════════════════════════ */
const P = { clientX: 10, clientY: 10, button: 0, pointerId: 1, preventDefault() {} };

test("single click → wave after 260ms window; double click → jump instead", () => {
	resetEnv(); // enables mocked setTimeout and syncs window refs
	const sessions = makeSessions();
	const { root, sprite } = mountPet(sessions);
	root.dispatch("pointerdown", P);
	root.dispatch("pointerup", P);
	mock.timers.tick(100); // inside window: not yet decided
	assert.notEqual(spriteRow(sprite).row, ROW.waving);
	mock.timers.tick(200); // window elapsed → wave fires
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.waving);
	root.dispatch("pointerdown", P);
	root.dispatch("pointerup", P);
	mock.timers.tick(100);
	root.dispatch("pointerdown", P);
	root.dispatch("pointerup", P); // second click inside window → jump
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.jumping);
	elapse(600); // resumes idle
	assert.equal(spriteRow(sprite).row, ROW.idle);
});
test("drag left → running-left; drag right → running-right; release resumes agent anim", () => {
	resetEnv();
	const sessions = makeSessions();
	const { root, sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, blank: false, updatedAt: 1 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.running);
	root.dispatch("pointerdown", { ...P, clientX: 100, clientY: 100 });
	root.dispatch("pointermove", { ...P, clientX: 60, clientY: 100 }); // dx < -4
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.runningLeft);
	root.dispatch("pointermove", { ...P, clientX: 180, clientY: 100 }); // dx > 4
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.runningRight);
	root.dispatch("pointerup", { ...P, clientX: 180, clientY: 100 });
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.running); // back to agent state
});
test("close button hides pet and shows badge; badge click restores", () => {
	resetEnv();
	const sessions = makeSessions();
	const { root, sprite } = mountPet(sessions);
	elapse(120);
	assert.equal(spriteRow(sprite).row, ROW.idle);
	const close = root.children.find((c) => c.className === "close");
	assert.ok(close, "close button missing");
	close.dispatch("click", {});
	assert.ok(root.classList.contains("hidden"), "pet not hidden");
	const badge = document.body.children.find((c) => c.id === "dsh-pet-frieren-badge");
	assert.ok(badge, "badge not mounted");
	assert.ok(!badge.classList.contains("hidden"), "badge hidden while pet hidden");
	badge.dispatch("click", {});
	assert.ok(!root.classList.contains("hidden"), "pet not restored");
});
test("reduce-motion shows a static frame of the current agent state", () => {
	resetEnv();
	const sessions = makeSessions();
	const { sprite } = mountPet(sessions);
	setCurrent(sessions, "s1", { id: "s1", running: true, blank: false, updatedAt: 1 });
	elapse(120);
	mql.setMatches(true);
	assert.equal(spriteRow(sprite).row, ROW.running);
	setCurrent(sessions, "s1", { id: "s1", running: false, blank: false, updatedAt: 2 });
	assert.equal(spriteRow(sprite).row, ROW.idle); // static frame follows state
	mql.setMatches(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/`
Expected: 既有 12 测试 PASS；新增测试中 3 个 FAIL（单击/双击窗口、拖拽方向跑、close/badge 未实现）；
"reduce-motion 静态帧"测试在 Task 2 已实现，预计直接 PASS（属于回归保护）。

- [ ] **Step 3: 实现交互（CSS、buildElements 完整版、指针交互）**

替换 `lib/client.js:74-82` CSS 段为（在原 3 条规则后追加）：

```js
		var CSS = [
			"#" + PKG + "{position:fixed;z-index:10000;margin:0;padding:0;width:" + DISPLAY_W + "px;height:" + DISPLAY_H + "px;"
				+ "cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;"
				+ "filter:drop-shadow(0 6px 12px rgba(0,0,0,.22));}",
			"#" + PKG + ".dragging{cursor:grabbing;}",
			"#" + PKG + ".hidden{display:none;}",
			"#" + PKG + " .sprite{width:100%;height:100%;background-image:url(\"" + SPRITE_DATA + "\");"
				+ "background-size:" + SHEET_W + "px " + SHEET_H + "px;background-repeat:no-repeat;background-position:0 0;}",
			"#" + PKG + " .close{position:absolute;top:2px;right:2px;width:20px;height:20px;line-height:18px;"
				+ "text-align:center;border:none;border-radius:50%;background:rgba(0,0,0,.35);color:#fff;"
				+ "font-size:12px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .15s;padding:0;}",
			"#" + PKG + ":hover .close{opacity:1;pointer-events:auto;}",
			"#" + PKG + "-badge{position:fixed;z-index:10000;width:36px;height:39px;margin:0;padding:0;cursor:pointer;"
				+ "opacity:.55;background-image:url(\"" + SPRITE_DATA + "\");"
				+ "background-size:288px 351px;background-position:0 0;background-repeat:no-repeat;"
				+ "filter:drop-shadow(0 2px 4px rgba(0,0,0,.25));}",
			"#" + PKG + "-badge:hover{opacity:.9;}",
			"#" + PKG + "-badge.hidden{display:none;}",
		].join("\n");
```

（徽章背景尺寸 = SHEET 比例缩放到 36px 宽：1344×36/168=288，1638×36/168=351。）

替换 `buildElements`（Task 2 占位版）为完整版：

```js
		function buildElements() {
			var root = document.createElement("div");
			root.id = PKG;
			root.setAttribute("role", "presentation");
			root.setAttribute("aria-hidden", "true");
			var frame = document.createElement("div");
			frame.className = "sprite";
			root.appendChild(frame);
			var close = document.createElement("button");
			close.className = "close";
			close.setAttribute("aria-hidden", "true");
			close.textContent = "✕";
			close.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
			close.addEventListener("click", function () { setHidden(true); });
			root.appendChild(close);
			var badge = document.createElement("div");
			badge.id = PKG + "-badge";
			badge.className = "badge";
			badge.title = "Show pet / 显示桌宠";
			badge.addEventListener("click", function () { setHidden(false); });
			return { root: root, badge: badge };
		}
```

（注：close 的 pointerdown 事件在测试 stub 中 event.stopPropagation 不存在——测试事件对象含 `stopPropagation(){}` 时兼容；测试中 close 只 dispatch "click"，不经过 pointerdown。）

替换 `lib/client.js:197-227` 指针交互段整体为：

```js
		var CLICK_WINDOW = 260;
		var clickTimer = 0;

		function onPointerDown(event) {
			if (event.button !== undefined && event.button !== 0) return;
			// NOTE: the pending single-click wave timer is NOT cleared here —
			// the second click of a double-click must see it on pointerup.
			// It is cancelled when an actual drag starts (see onPointerMove).
			var pos = currentPosition();
			drag = { startX: event.clientX, startY: event.clientY, left: pos.x, top: pos.y, moved: false, dir: 0 };
			el.classList.add("dragging");
			try { el.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
			event.preventDefault();
		}
		function onPointerMove(event) {
			if (!drag) return;
			var dx = event.clientX - drag.startX;
			var dy = event.clientY - drag.startY;
			if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
				drag.moved = true;
				if (clickTimer) { window.clearTimeout(clickTimer); clickTimer = 0; } // drag cancels the pending wave
			}
			if (!drag.moved) return;
			applyPosition(clampLeft(drag.left + dx), clampTop(drag.top + dy));
			if (reduceMotion) return; // drag moves the pet but plays no run animation
			var dir = dx < -4 ? -1 : dx > 4 ? 1 : 0;
			if (dir !== 0 && dir !== drag.dir) {
				drag.dir = dir;
				play(dir < 0 ? "runningLeft" : "runningRight", { once: false, overlay: true });
			}
		}
		function onPointerUp(event) {
			if (!drag) return;
			var moved = drag.moved;
			var x = clampLeft(drag.left + event.clientX - drag.startX);
			var y = clampTop(drag.top + event.clientY - drag.startY);
			drag = null;
			el.classList.remove("dragging");
			savePosition(x, y);
			applyPosition(x, y);
			if (moved) {
				playAgentAnim(agentAnim);
				scheduleAuto();
				return;
			}
			onClick();
		}
		function onPointerCancel() {
			drag = null;
			el.classList.remove("dragging");
			if (clickTimer) { window.clearTimeout(clickTimer); clickTimer = 0; }
		}
		function onClick() {
			if (reduceMotion || isHidden()) return;
			if (clickTimer) {
				window.clearTimeout(clickTimer);
				clickTimer = 0;
				playOverlay("jumping", null);
			} else {
				clickTimer = window.setTimeout(function () {
					clickTimer = 0;
					if (isHidden()) return;
					playOverlay("waving", null);
				}, CLICK_WINDOW);
			}
		}
```

（删除原 `jump` 函数；原 `dblclick` 隐藏监听器已在 Task 2 的 mount 重写中移除。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/`
Expected: 全部 PASS（Task 1 6 + Task 2 6 + Task 3 4 = 16）。

- [ ] **Step 5: 提交**

```bash
git add lib/client.js test/client.test.js
git commit -m "feat: click=wave dblclick=jump drag-directional-run, hover close button + restore badge"
```

**Chunk 3 完成后：派发 plan-document-reviewer 审查本 Chunk。**

---

## Chunk 4: Task 4 — README 更新 + 收尾验证 + 手工浏览器清单

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README 简介行与 Interactions 表**

先更新第 8-9 行的简介（原 "jumps when clicked" 已过时）：

```markdown
<p>Idles beside your workspace · follows the Agent's state · waves on its own ·
click to wave, double-click to jump · draggable · remembers where you left it.</p>
```

再替换 Interactions 表（第 45-56 行）为：

```markdown
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
```

- [ ] **Step 2: 更新 "How it works" 段（第 58-88 行）**

第 79 行 "no React, no host services, no inject edges" 改为：

```text
self-contained DOM overlay animated with `requestAnimationFrame` (no React;
one inject edge: the `sessions` service).
```

并在 "Assets follow the same host-serves..." 段之前插入：

```markdown
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
```

- [ ] **Step 3: 更新中文段开头的描述段（第 133-134 行两行，不触碰其后的"安装（一条命令）"代码块）**

原两行：

```markdown
在 **DeepSeek Harness 网页版**（`dsh --profile web`）里养一只 Q 版芙莉莲桌宠：
发呆循环、偶尔朝你挥手、点击会跳、可拖拽、位置会被记住。
```

替换为：

```markdown
在 **DeepSeek Harness 网页版**（`dsh --profile web`）里养一只 Q 版芙莉莲桌宠。
它会跟随 Agent 状态：空闲发呆、运行时小跑、等待审批/提问时等待、计划评审时审阅、
报错时扑倒（定格到错误清除）；切换会话时桌宠随之切换。空闲时会自己挥手、偶尔跳一下；
单击挥手、双击跳跃、拖拽移动（左右拖会朝对应方向跑）、悬停出现 ✕ 可隐藏、隐藏后
点原地小徽章恢复。
```

- [ ] **Step 4: 收尾验证**

Run: `node --check lib/client.js`
Expected: 无输出（语法通过）。

Run: `node --test test/`
Expected: 16 个测试全部 PASS。

Run: `git diff --stat`
Expected: 本计划涉及的 `lib/client.js`、`test/client.test.js`、`README.md`；
注意工作区另有与此无关的在途改动（`lib/index.js`、未跟踪的 `assets/`），不要触碰。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: document agent-state-driven animations and new interactions"
```

- [ ] **Step 6: 手工浏览器验证清单（交给用户在真实 GUI 中执行）**

启动：`dsh --profile web`，然后逐项核对：

1. 无会话 / 回合之间 → idle 循环，12~30s 内自动挥手、偶尔自动跳。
2. 发送消息让 Agent 运行 → 桌宠切到 running（row 7）小跑。
3. 触发工具审批或 Agent 提问 → waiting；plan mode 计划评审 → review。
4. 制造一次 Agent 报错 → failed 播一次后定格；错误清除/新回合 → 恢复。
5. 切换会话 → 桌宠跟随新会话的状态（空闲会话切过去变 idle）。
6. 单击 → 挥手一次后恢复；快速双击 → 跳跃；拖拽左/右 → 对应方向跑，松手恢复。
7. 悬停出现 ✕ → 点击隐藏，原地出现半透明小徽章 → 点击恢复；刷新页面位置与隐藏状态保持。
8. 系统开启"减少动态效果"（prefers-reduced-motion）→ 桌宠静止显示当前状态帧。

**Chunk 4 完成后：派发 plan-document-reviewer 审查本 Chunk，然后执行交接（subagent-driven-development）。**
