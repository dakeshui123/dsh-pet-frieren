/**
 * dsh-pet-frieren browser half — the hand-written client bundle in the exact
 * `window.__ModuleLoader__.load` handoff shape the DSH web module system
 * consumes (the same artifact shape tsdown emits for repo client plugins).
 *
 * The pet is fully self-contained at the JS level: no inject edges, no React,
 * no host services. `apply()` mounts a draggable sprite overlay on
 * document.body and animates it against the petdex v1 atlas (8 cols x 9 rows
 * of 192x208 px frames, rendered at 168x182 CSS px — a 0.875 scale). The
 * atlas itself is served by this plugin's node half as a separate asset:
 * /dsh-plugin-assets/dsh-pet-frieren/spritesheet.webp (assets/ in the repo).
 *
 * Interactions:
 *   - idle loop plays forever
 *   - waves on its own every 12-30 s
 *   - click: jump once
 *   - drag: move (position persists in localStorage)
 *   - double-click: hide/show (persists in localStorage)
 *   - prefers-reduced-motion: static idle frame, no auto animations
 */
window.__ModuleLoader__.load({
	id: "dsh-pet-frieren",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/* ── runtime sprite atlas, served by the node half's asset route ────── */
		var SPRITE_DATA = "/dsh-plugin-assets/dsh-pet-frieren/spritesheet.webp";

		/* ── atlas constants (petdex v1 contract) ───────────────────────────── */
		var PKG = "dsh-pet-frieren";
		var CSS_ID = PKG + "/pet.css";
		var FRAME_W = 192, FRAME_H = 208;   // source frame size in the atlas
		var DISPLAY_W = 168, DISPLAY_H = 182; // rendered size (192x208 * 0.875)
		var SHEET_COLS = 8, SHEET_ROWS = 9;
		var SHEET_W = SHEET_COLS * DISPLAY_W; // 1344
		var SHEET_H = SHEET_ROWS * DISPLAY_H; // 1638
		var MARGIN = 24;                     // default distance from the viewport corner

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

		var POS_KEY = PKG + ":position";
		var HIDDEN_KEY = PKG + ":hidden";

		/* ── storage helpers that never throw (privacy modes can block it) ──── */
		function loadPosition() {
			try {
				var raw = window.localStorage.getItem(POS_KEY);
				if (!raw) return null;
				var value = JSON.parse(raw);
				if (value && typeof value.x === "number" && typeof value.y === "number") return value;
			} catch (_) { /* fall through */ }
			return null;
		}
		function savePosition(x, y) {
			try { window.localStorage.setItem(POS_KEY, JSON.stringify({ x: x, y: y })); } catch (_) { /* ignore */ }
		}
		function readHidden() {
			try { return window.localStorage.getItem(HIDDEN_KEY) === "1"; } catch (_) { return false; }
		}
		function writeHidden(hidden) {
			try { window.localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0"); } catch (_) { /* ignore */ }
		}

		/* ── css ─────────────────────────────────────────────────────────────── */
		var CSS = [
			"#" + PKG + "{position:fixed;z-index:10000;margin:0;padding:0;width:" + DISPLAY_W + "px;height:" + DISPLAY_H + "px;"
				+ "cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;"
				+ "filter:drop-shadow(0 6px 12px rgba(0,0,0,.22));}",
			"#" + PKG + ".dragging{cursor:grabbing;}",
			"#" + PKG + ".hidden{display:none;}",
			"#" + PKG + " .sprite{width:100%;height:100%;background-image:url(\"" + SPRITE_DATA + "\");"
				+ "background-size:" + SHEET_W + "px " + SHEET_H + "px;background-repeat:no-repeat;background-position:0 0;}",
		].join("\n");

		/* ── runtime state ───────────────────────────────────────────────────── */
		var el = null;        // root overlay element
		var sprite = null;    // animated frame element
		var badgeEl = null;   // restore badge shown while hidden
		var rafId = 0;        // requestAnimationFrame handle
		var drag = null;      // { startX, startY, left, top, moved, dir }
		var reduceMotion = false;

		/* ── frame animation (rAF-driven, auto-throttled in background tabs) ── */
		function setFrame(anim, index) {
			sprite.style.backgroundPosition = (-index * DISPLAY_W) + "px " + (-anim.row * DISPLAY_H) + "px";
		}

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

		function loop(now) {
			step(now);
			rafId = requestAnimationFrame(loop);
		}

		/* ── viewport-clamped position ───────────────────────────────────────── */
		function clampLeft(x) {
			var max = Math.max(0, window.innerWidth - DISPLAY_W);
			return Math.max(0, Math.min(x, max));
		}
		function clampTop(y) {
			var max = Math.max(0, window.innerHeight - DISPLAY_H);
			return Math.max(0, Math.min(y, max));
		}
		function defaultPosition() {
			return {
				x: clampLeft(window.innerWidth - DISPLAY_W - MARGIN),
				y: clampTop(window.innerHeight - DISPLAY_H - MARGIN),
			};
		}
		function currentPosition() {
			var saved = loadPosition();
			if (saved) return { x: clampLeft(saved.x), y: clampTop(saved.y) };
			return defaultPosition();
		}
		function applyPosition(x, y) {
			el.style.left = x + "px";
			el.style.top = y + "px";
		}
		function applyBadgePosition(x, y) {
			badgeEl.style.left = x + "px";
			badgeEl.style.top = y + "px";
		}

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

		/* ── reduced motion ──────────────────────────────────────────────────── */
		var mql = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
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
		if (mql) {
			if (mql.addEventListener) mql.addEventListener("change", updateReduceMotion);
			else if (mql.addListener) mql.addListener(updateReduceMotion);
		}

		/* ── pointer interactions: drag to move, click to jump, dblclick hide ── */
		function onPointerDown(event) {
			if (event.button !== undefined && event.button !== 0) return;
			var pos = currentPosition();
			drag = { startX: event.clientX, startY: event.clientY, left: pos.x, top: pos.y, moved: false };
			el.classList.add("dragging");
			try { el.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
			event.preventDefault();
		}
		function onPointerMove(event) {
			if (!drag) return;
			var dx = event.clientX - drag.startX;
			var dy = event.clientY - drag.startY;
			if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
			if (!drag.moved) return;
			applyPosition(clampLeft(drag.left + dx), clampTop(drag.top + dy));
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
			if (!moved) jump();
		}
		function onPointerCancel() {
			drag = null;
			el.classList.remove("dragging");
		}

		function jump() {
			if (reduceMotion || isHidden()) return;
			playOverlay("jumping", null);
		}

		/* ── mount ───────────────────────────────────────────────────────────── */
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

		/**
		 * Client plugin body. Idempotent: replaces any previous instance, so
		 * client-plugin HMR re-applies cleanly without stacking pets.
		 * @param ctx - client cordis context (unused: this plugin takes no services).
		 */
		function apply(ctx) {
			var previous = document.getElementById(PKG);
			if (previous) previous.remove();
			var previousBadge = document.getElementById(PKG + "-badge");
			if (previousBadge) previousBadge.remove();
			var previousStyle = document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]");
			if (previousStyle) previousStyle.remove();
			mount(ctx);
		}

		exports.apply = apply;
		exports.inject = ["sessions"];
		exports.deriveAgentAnim = deriveAgentAnim;
		return module.exports;
	}
});
