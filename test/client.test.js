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
