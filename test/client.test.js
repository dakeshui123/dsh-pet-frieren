/**
 * Zero-dependency smoke tests for the dsh-pet-frieren client bundle.
 * Run: node --test
 *
 * Loads the hand-written bundle into a stubbed DOM/window, then drives the
 * pet through a fake `sessions` service and synthetic pointer events,
 * asserting sprite row selection per the design spec:
 * docs/superpowers/specs/2026-08-19-agent-state-driven-pet-design.md
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

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
			const id = JSON.parse(sel.slice("style[data-plugin-css=".length, -1));
			for (const c of this.head.children) if (c.dataset.pluginCss === id) return c;
		}
		return null;
	},
};
// The bundle's loop() calls the bare `requestAnimationFrame` identifier,
// which resolves to window in browsers but is undefined in node.
globalThis.requestAnimationFrame = (cb) => rafStub.requestAnimationFrame(cb);
globalThis.cancelAnimationFrame = () => rafStub.cancelAnimationFrame();

const BUNDLE_URL = new URL("../lib/client.js", import.meta.url).href;
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
	// (0 - v) instead of -v so the idle origin yields +0, not -0:
	// assert/strict uses Object.is, and Object.is(-0, 0) is false.
	return { row: (0 - y) / DISPLAY_H, col: (0 - x) / DISPLAY_W };
}

/* ── test env reset (bundle module state persists across tests) ──────────── */
// All tests run under mocked timers: the bundle arms 12s/45s auto-animation
// timers on every mount, and real timers would keep the node event loop
// alive. mock.timers replaces globalThis.setTimeout, so re-sync window's
// references (captured at stub creation) after enabling.
function resetEnv() {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout"] });
	window.setTimeout = globalThis.setTimeout;
	window.clearTimeout = globalThis.clearTimeout;
	mql.setMatches(false);
	storage.setItem("dsh-pet-frieren:hidden", "0");
	rafStub.reset();
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
	assert.equal(plugin.deriveAgentAnim({ running: false, pendingInteraction: "approval" }, undefined).name, "waiting");
	assert.equal(plugin.deriveAgentAnim({ running: true, pendingInteraction: "mystery" }, undefined).name, "running");
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
