/**
 * dsh-pet-frieren browser half — the hand-written client bundle in the exact
 * `window.__ModuleLoader__.load` handoff shape the DSH web module system
 * consumes (the same artifact shape tsdown emits for repo client plugins).
 *
 * The pet follows the Agent's state through the injected `sessions` service
 * and is otherwise fully self-contained at the JS level: no React, no other
 * host services. `apply()` mounts a draggable sprite overlay on document.body
 * and animates it against the petdex v1 atlas (8 cols x 9 rows of 192x208 px
 * frames, rendered at 168x182 CSS px — a 0.875 scale). The atlas itself is
 * served by this plugin's node half as a separate asset:
 * /dsh-plugin-assets/dsh-pet-frieren/spritesheet.webp (assets/ in the repo).
 *
 * Interactions:
 *   - follows the Agent's state via ctx.sessions: failed > approval/question
 *     (waiting) > plan-review (review) > in-turn phases (tool calls → review,
 *     streaming output → running, thinking → waiting) > idle
 *   - speech bubble on state change (3.5 s) + occasional idle chatter (20-40 s)
 *   - auto wave (12-30 s) and occasional auto jump (45-90 s) while idle
 *   - click: wave once
 *   - double-click: jump once
 *   - drag: move + directional run (position persists in localStorage)
 *   - hover ✕: hide (persists in localStorage); badge: click restores,
 *     drag moves the pet's home position
 *   - prefers-reduced-motion: static frame of the current agent state
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
			idle:         { row: 0, frames: 6, fps: 7 },
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
		 * the zero-dependency smoke tests. Priority: failed > pending
		 * interactions > in-turn phases > idle. The in-turn phases are the
		 * three working stages of a turn: tool calls (review), streaming
		 * output (running), thinking (waiting).
		 * @param item - sessions.list byId[current] entry, or undefined.
		 * @param sessionSnap - sessions.binding(current).session snapshot, or null.
		 * @returns {{name: string, once: boolean, hold: boolean, key: string}}
		 */
		function deriveAgentAnim(item, sessionSnap) {
			if (sessionSnap && sessionSnap.lastAgentError) return { name: "failed", once: true, hold: true, key: "error" };
			if (item) {
				var pending = item.pendingInteraction;
				if (pending === "approval") return { name: "waiting", once: false, hold: false, key: "approval" };
				if (pending === "question") return { name: "waiting", once: false, hold: false, key: "question" };
				if (pending === "plan-review") return { name: "review", once: false, hold: false, key: "planReview" };
			}
			// Prefer the live session snapshot: the list entry's running flag is a
			// projection that can lag the session's own status by a frame or two.
			var running = sessionSnap ? sessionSnap.running === true : (item && item.running) === true;
			if (running) {
				var calls = sessionSnap ? sessionSnap.runningCalls : null;
				var partial = sessionSnap ? sessionSnap.partial : null;
				if (calls && calls.length > 0) return { name: "review", once: false, hold: false, key: "exec" };
				if (partial) return { name: "running", once: false, hold: false, key: "output" };
				return { name: "waiting", once: false, hold: false, key: "thinking" };
			}
			return { name: "idle", once: false, hold: false, key: "idle" };
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

		/* ── speech bubble lines per state key ─────────────────────────────────── */
		var LINES = {
			idle: ["好安静呢……", "想喝杯茶了。", "今天也要加油哦。", "唔，接下来做什么呢？"],
			thinking: ["让我想想……", "嗯……"],
			exec: ["我看看……", "稍等哦。"],
			output: ["马上就好！", "写好啦，你看！"],
			error: ["呜……搞砸了……", "对不起，出了点问题……"],
			approval: ["这里需要你确认一下~"],
			question: ["可以回答我一个问题吗？"],
			planReview: ["这个计划你觉得怎么样？"],
		};
		function pickLine(key) {
			var lines = LINES[key];
			if (!lines) return null;
			return lines[Math.floor(Math.random() * lines.length)];
		}
		function say(key) {
			var text = pickLine(key);
			if (text === null) return;
			bubbleEl.textContent = text;
			bubbleEl.classList.add("show");
			if (bubbleTimer) { window.clearTimeout(bubbleTimer); bubbleTimer = 0; }
			bubbleTimer = window.setTimeout(function () {
				bubbleTimer = 0;
				bubbleEl.classList.remove("show");
			}, 3500);
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
			"#" + PKG + " .close{position:absolute;top:2px;right:2px;width:20px;height:20px;line-height:18px;"
				+ "text-align:center;border:none;border-radius:50%;background:rgba(0,0,0,.35);color:#fff;"
				+ "font-size:12px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .15s;padding:0;}",
			"#" + PKG + ":hover .close{opacity:1;pointer-events:auto;}",
			"#" + PKG + "-badge{position:fixed;z-index:10000;width:36px;height:39px;margin:0;padding:0;cursor:pointer;"
				+ "opacity:.55;background-image:url(\"" + SPRITE_DATA + "\");"
				+ "background-size:288px 351px;background-position:0 0;background-repeat:no-repeat;"
				+ "filter:drop-shadow(0 2px 4px rgba(0,0,0,.25));}",
			"#" + PKG + "-badge:hover{opacity:.9;}",
			"#" + PKG + "-badge.dragging{cursor:grabbing;}",
			"#" + PKG + "-badge.hidden{display:none;}",
			"#" + PKG + " .bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);"
				+ "background:#fff;color:#3a3a3a;border-radius:10px;padding:4px 10px;font-size:12px;"
				+ "white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18);opacity:0;"
				+ "transition:opacity .25s;pointer-events:none;}",
			"#" + PKG + " .bubble::after{content:\"\";position:absolute;top:100%;left:50%;transform:translateX(-50%);"
				+ "border:5px solid transparent;border-top-color:#fff;}",
			"#" + PKG + " .bubble.show{opacity:1;}",
		].join("\n");

		/* ── runtime state ───────────────────────────────────────────────────── */
		var el = null;        // root overlay element
		var sprite = null;    // animated frame element
		var badgeEl = null;   // restore badge shown while hidden
		var bubbleEl = null;  // speech bubble above the pet
		var bubbleTimer = 0;  // auto-hide handle for the bubble
		var rafId = 0;        // requestAnimationFrame handle
		var drag = null;      // { startX, startY, left, top, moved, dir }
		var badgeDrag = null; // { startX, startY, left, top, moved }
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
		var agentAnim = { name: "idle", once: false, hold: false, key: "idle" };
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
		var waveTimer = 0, jumpTimer = 0, chatTimer = 0;
		function clearAuto() {
			if (waveTimer) { window.clearTimeout(waveTimer); waveTimer = 0; }
			if (jumpTimer) { window.clearTimeout(jumpTimer); jumpTimer = 0; }
			if (chatTimer) { window.clearTimeout(chatTimer); chatTimer = 0; }
		}
		function autoAllowed() {
			return !reduceMotion && !isHidden() && !drag && agentAnim.name === "idle"
				&& !(playState && playState.overlay && !playState.done);
		}
		// Each timer keeps its own cadence: scheduleAuto re-arms only the ones
		// that are not pending, so a frequent wave never starves the chatter
		// (wave 12-30 s < chat 20-40 s would otherwise reset it forever).
		function armWave() {
			waveTimer = window.setTimeout(function () {
				waveTimer = 0;
				if (!autoAllowed()) { clearAuto(); return; }
				playOverlay("waving", null);
			}, 12000 + Math.random() * 18000);
		}
		function armJump() {
			jumpTimer = window.setTimeout(function () {
				jumpTimer = 0;
				if (!autoAllowed()) { clearAuto(); return; }
				playOverlay("jumping", null);
			}, 45000 + Math.random() * 45000);
		}
		function armChat() {
			chatTimer = window.setTimeout(function () {
				chatTimer = 0;
				if (!autoAllowed()) { clearAuto(); return; }
				say("idle");
				armChat();
			}, 20000 + Math.random() * 20000);
		}
		function scheduleAuto() {
			if (!autoAllowed()) { clearAuto(); return; }
			if (!waveTimer) armWave();
			if (!jumpTimer) armJump();
			if (!chatTimer) armChat();
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
			var changed = agentAnim.name !== anim.name || agentAnim.hold !== anim.hold || agentAnim.key !== anim.key;
			agentAnim = anim;
			if (changed && !isHidden()) say(anim.key);
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
				// The badge is the pet's stand-in: restore where the badge sits
				// (badge drags update the shared saved position).
				var pos = currentPosition();
				applyPosition(pos.x, pos.y);
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

		/* ── pointer interactions: drag to move (directional run), click wave, ── */
		/*    double-click jump; the ✕ button and restore badge handle hide/show ─ */
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
			if (playState && playState.overlay) {
				playAgentAnim(agentAnim);
				scheduleAuto();
			}
		}

		/* ── badge interactions: drag moves the pet's home, click restores ────── */
		function onBadgePointerDown(event) {
			if (event.button !== undefined && event.button !== 0) return;
			var pos = currentPosition();
			badgeDrag = { startX: event.clientX, startY: event.clientY, left: pos.x, top: pos.y, moved: false };
			badgeEl.classList.add("dragging");
			try { badgeEl.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
			event.preventDefault();
		}
		function onBadgePointerMove(event) {
			if (!badgeDrag) return;
			var dx = event.clientX - badgeDrag.startX;
			var dy = event.clientY - badgeDrag.startY;
			if (!badgeDrag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) badgeDrag.moved = true;
			if (!badgeDrag.moved) return;
			applyBadgePosition(clampLeft(badgeDrag.left + dx), clampTop(badgeDrag.top + dy));
		}
		function onBadgePointerUp(event) {
			if (!badgeDrag) return;
			var moved = badgeDrag.moved;
			var x = clampLeft(badgeDrag.left + event.clientX - badgeDrag.startX);
			var y = clampTop(badgeDrag.top + event.clientY - badgeDrag.startY);
			badgeDrag = null;
			badgeEl.classList.remove("dragging");
			savePosition(x, y);
			applyBadgePosition(x, y);
			if (!moved) setHidden(false);
		}
		function onBadgePointerCancel() {
			badgeDrag = null;
			badgeEl.classList.remove("dragging");
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

		/* ── mount ───────────────────────────────────────────────────────────── */
		function buildElements() {
			var root = document.createElement("div");
			root.id = PKG;
			root.setAttribute("role", "presentation");
			root.setAttribute("aria-hidden", "true");
			var frame = document.createElement("div");
			frame.className = "sprite";
			root.appendChild(frame);
			var bubble = document.createElement("div");
			bubble.className = "bubble";
			root.appendChild(bubble);
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
			badge.title = "Show pet / drag to move / 显示桌宠 / 拖拽移动位置";
			badge.addEventListener("pointerdown", onBadgePointerDown);
			badge.addEventListener("pointermove", onBadgePointerMove);
			badge.addEventListener("pointerup", onBadgePointerUp);
			badge.addEventListener("pointercancel", onBadgePointerCancel);
			return { root: root, badge: badge, bubble: bubble };
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
			bubbleEl = built.bubble;
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
		 * @param ctx - client cordis context; takes the `sessions` service (declared in inject).
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
		exports.__lines = LINES;
		return module.exports;
	}
});
