// Update this once the Worker is deployed (see README.md in the project root)
const API_BASE = "https://pos.slcantec.workers.dev";

// Session policy (client-side; token also expires on the worker)
const SESSION_MAX_MS = 24 * 60 * 60 * 1000; // 24h → full logout, login again
const IDLE_LOCK_MS = 20 * 60 * 1000;        // 20 min no activity → lock screen (password)

const Auth = {
  get token() { return localStorage.getItem("pos_token"); },
  get role() { return localStorage.getItem("pos_role"); },
  get shopId() { return localStorage.getItem("pos_shop_id"); },
  get email() { return localStorage.getItem("pos_email") || ""; },
  get sessionStarted() {
    const v = parseInt(localStorage.getItem("pos_session_started") || "0", 10);
    return v || 0;
  },
  get lastActivity() {
    const v = parseInt(localStorage.getItem("pos_last_activity") || "0", 10);
    return v || 0;
  },
  get isLocked() { return localStorage.getItem("pos_locked") === "1"; },

  set({ token, role, shopId, email }) {
    localStorage.setItem("pos_token", token);
    localStorage.setItem("pos_role", role);
    if (shopId != null && shopId !== "") localStorage.setItem("pos_shop_id", String(shopId));
    else localStorage.removeItem("pos_shop_id");
    if (email) localStorage.setItem("pos_email", String(email).trim().toLowerCase());
    const now = Date.now();
    localStorage.setItem("pos_session_started", String(now));
    localStorage.setItem("pos_last_activity", String(now));
    localStorage.removeItem("pos_locked");
  },

  /** Refresh token after unlock without resetting the 24h window */
  refreshToken({ token, role, shopId }) {
    if (token) localStorage.setItem("pos_token", token);
    if (role) localStorage.setItem("pos_role", role);
    if (shopId != null && shopId !== "") localStorage.setItem("pos_shop_id", String(shopId));
    localStorage.setItem("pos_last_activity", String(Date.now()));
    localStorage.removeItem("pos_locked");
  },

  touch() {
    if (!this.token) return;
    localStorage.setItem("pos_last_activity", String(Date.now()));
  },

  lock() {
    if (!this.token) return;
    localStorage.setItem("pos_locked", "1");
  },

  unlockLocal() {
    localStorage.removeItem("pos_locked");
    localStorage.setItem("pos_last_activity", String(Date.now()));
  },

  clear() {
    localStorage.removeItem("pos_token");
    localStorage.removeItem("pos_role");
    localStorage.removeItem("pos_shop_id");
    localStorage.removeItem("pos_email");
    localStorage.removeItem("pos_session_started");
    localStorage.removeItem("pos_last_activity");
    localStorage.removeItem("pos_locked");
  },

  isLoggedIn() { return !!this.token; },

  /** Past absolute 24h → need full login */
  isSessionExpired() {
    if (!this.token) return true;
    const started = this.sessionStarted;
    if (!started) return true; // legacy sessions without timestamp → force re-login once
    return Date.now() - started > SESSION_MAX_MS;
  },

  /** Idle long enough to show lock screen (token still valid) */
  shouldIdleLock() {
    if (!this.token || this.isSessionExpired()) return false;
    const last = this.lastActivity || this.sessionStarted;
    return Date.now() - last > IDLE_LOCK_MS;
  },
};

// ============================================================
// Connection manager — ONE source of truth for Online / Offline, used by every page.
//  - Any HTTP response from the Worker (even 401/400) proves we are online → instant.
//  - A network failure never flips the UI by itself: it triggers an immediate health probe,
//    and only a failed probe marks us Offline.
//  - While Offline, probes run back-to-back (never overlapping, never cancelled) with a short
//    backoff (1s → 5s), and any trigger (network event, app resume, tap) probes right now.
//  - navigator.onLine is only a hint (it is often stale in Android WebView); it never decides.
// Events: "change" (online:boolean), "lost", "restored".
// ============================================================
function makeNetworkError(msg) {
  const e = new TypeError(msg || "No connection — check your internet and try again.");
  e.status = 0;
  e.isNetwork = true;
  return e;
}

const Connection = (() => {
  const PROBE_TIMEOUT_MS = 8000;      // mobile data can be slow to answer; a short timeout caused false "offline"
  const CONFIRM_GAP_MS = 800;         // wait before the confirming re-check
  const POLL_MIN_MS = 1000;
  const POLL_MAX_MS = 5000;
  const HEARTBEAT_MS = 30000;
  const listeners = { change: [], lost: [], restored: [] };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let probePromise = null;
  let pollTimer = null;
  let pollDelay = POLL_MIN_MS;
  let lastFailAt = 0;
  let lastOkAt = 0;
  let started = false;

  function emit(name, arg) {
    (listeners[name] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.warn("connection listener failed", e); } });
  }

  function set(next) {
    next = !!next;
    if (next === online) return;
    online = next;
    if (online) {
      clearTimeout(pollTimer); pollTimer = null; pollDelay = POLL_MIN_MS;
    } else {
      lastFailAt = Date.now();
      startPolling();
    }
    emit("change", online);
    emit(online ? "restored" : "lost");
  }

  async function attempt() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(`${API_BASE}/api/health?_=${Date.now()}`, { method: "GET", cache: "no-store", signal: ctrl.signal });
      return true; // any HTTP response means the network path works
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function gotOk() { lastOkAt = Date.now(); set(true); }

  // One probe at a time. Callers that arrive while one is running share its result,
  // so a slow-but-successful probe is never thrown away.
  // Going Online needs ONE success (instant). Going Offline needs TWO failures in a row
  // (and no other request succeeding in between), so a single slow reply, a network
  // handoff or a radio wake-up can't flip a working connection to Offline.
  function probe() {
    if (probePromise) return probePromise;
    probePromise = (async () => {
      const began = Date.now();
      const okSince = () => lastOkAt > began; // some other request succeeded while we were checking → network is up
      try {
        if (await attempt()) { gotOk(); return true; }
        if (online) {
          if (okSince()) return true;
          await _sleep(CONFIRM_GAP_MS);
          if (okSince()) return true;
          if (await attempt()) { gotOk(); return true; }
          if (okSince()) return true;
        }
        lastFailAt = Date.now();
        set(false);
        startPolling(); // also covers "app opened while already offline" (no state change to trigger it)
        return false;
      } finally {
        probePromise = null;
      }
    })();
    return probePromise;
  }

  function startPolling() {
    if (pollTimer || online) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (online) return;
      if (document.visibilityState !== "hidden") await probe();
      if (!online) {
        pollDelay = Math.min(Math.round(pollDelay * 1.5), POLL_MAX_MS);
        startPolling();
      }
    }, pollDelay);
  }

  // Called by apiFetch
  function reportReachable() { lastOkAt = Date.now(); set(true); }
  function reportNetworkFailure() { if (online) probe(); }

  // Skip a doomed request for a few seconds after we just confirmed we're offline,
  // so the till queues a sale instantly instead of waiting on a timeout.
  function assertReachable() {
    if (!online && Date.now() - lastFailAt < 3000) throw makeNetworkError("offline");
  }

  function on(name, fn) { if (listeners[name]) listeners[name].push(fn); }

  function start() {
    if (started) return;
    started = true;
    const nudge = () => { probe(); };
    window.addEventListener("online", nudge);
    window.addEventListener("offline", nudge); // a hint only: verified with the two-step check (handoffs fire this spuriously)
    window.addEventListener("pageshow", nudge);
    window.addEventListener("focus", () => { if (!online) nudge(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudge(); });
    try { if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener("change", nudge); } catch (_) {}
    // While offline, a tap is a strong hint the user is trying something: probe now (throttled).
    let lastTap = 0;
    document.addEventListener("pointerdown", () => {
      if (online || Date.now() - lastTap < 2000) return;
      lastTap = Date.now();
      nudge();
    }, { passive: true, capture: true });
    // Native Android network events (needs @capacitor/network; harmless if absent)
    try {
      const N = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network;
      if (N && N.addListener) {
        // status events flap during Wi-Fi/mobile handoffs, so just verify with the two-step check
        const p = N.addListener("networkStatusChange", () => { nudge(); });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (_) {}
    // Quiet heartbeat so a silent drop shows up even when the user is idle
    setInterval(() => { if (online && document.visibilityState === "visible") probe(); }, HEARTBEAT_MS);
    // Chip tap = manual recheck
    const chip = document.getElementById("conn-status");
    if (chip && !chip._connBound) {
      chip._connBound = true;
      chip.style.cursor = "pointer";
      chip.addEventListener("click", () => {
        const label = chip.querySelector(".conn-label");
        if (label) label.textContent = "…";
        probe().then(() => updateConnectionUI(online));
      });
    }
    updateConnectionUI(online);
    probe();
  }

  return {
    get online() { return online; },
    on, probe, start, assertReachable, reportReachable, reportNetworkFailure,
  };
})();

// Chip / banner / body classes. Safe on pages that don't have these elements.
function updateConnectionUI(isOnline) {
  const on = isOnline != null ? !!isOnline : Connection.online;
  const chip = document.getElementById("conn-status");
  const banner = document.getElementById("conn-banner");
  if (chip) {
    chip.classList.toggle("online", on);
    chip.classList.toggle("offline", !on);
    const label = chip.querySelector(".conn-label");
    if (label) label.textContent = on ? "Online" : "Offline";
    chip.title = on ? "Connected — tap to recheck" : "No internet — tap to recheck";
  }
  if (banner) banner.style.display = on ? "none" : "block";
  if (document.body) {
    document.body.classList.toggle("is-offline", !on);
    document.body.classList.toggle("is-online", on);
  }
}

// ============================================================
// Native-style UI layer — replaces browser alert()/confirm()/prompt() and the old
// toast/banner messages, on every page.
//   UI.confirm({title, message, confirmText, cancelText, danger}) -> Promise<boolean>
//   UI.prompt({title, message, label, value, placeholder, required, confirmText}) -> Promise<string|null>
//   UI.alert({title, message, rows:[{title, sub, tag}], okText, kind}) -> Promise<void>
//   UI.snack(message, kind = "info"|"ok"|"err"|"warn", {duration})   (snackbar)
// Phones: bottom sheets that slide up (Android back button / swipe-back closes them).
// Desktop: centered dialog. Dialogs queue, so two never stack on top of each other.
// ============================================================
const UI = (() => {
  let queue = Promise.resolve();
  let openCount = 0;
  let uid = 0;
  let ignorePop = 0;
  const stack = []; // open sheets, topmost last: { onBack }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function normalize(opts, defaults) {
    if (typeof opts === "string") opts = { message: opts };
    return Object.assign({}, defaults, opts || {});
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }

  // One shared popstate listener: the hardware/gesture Back button closes the top sheet.
  window.addEventListener("popstate", () => {
    if (ignorePop > 0) { ignorePop--; return; }
    const top = stack[stack.length - 1];
    if (top) top.onBack();
  });

  // Core: builds the overlay + sheet, calls build(ctx), resolves with whatever finish(value) is given.
  // ctx = { sheet, finish, setCancel(value), titleId }  — build() returns the element to focus first.
  function openSheet(build) {
    const run = () => new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const overlay = el("div", "ui-overlay");
      const sheet = el("div", "ui-sheet");
      const titleId = "ui-title-" + (++uid);
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.setAttribute("aria-labelledby", titleId);
      sheet.appendChild(el("div", "ui-grabber"));
      overlay.appendChild(sheet);

      let closed = false;
      let pushed = false;
      let cancelValue;
      const entry = { onBack: () => { pushed = false; finish(cancelValue); } };

      function finish(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey, true);
        const i = stack.indexOf(entry);
        if (i >= 0) stack.splice(i, 1);
        overlay.classList.remove("show");
        openCount--;
        if (!openCount) document.body.classList.remove("ui-sheet-open");
        if (pushed) { ignorePop++; try { history.back(); } catch (_) { ignorePop--; } }
        setTimeout(() => overlay.remove(), 220);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (_) {}
        resolve(value);
      }

      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(cancelValue); return; }
        if (e.key !== "Tab") return;
        const f = [...sheet.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }

      const focusEl = build({ sheet, finish, titleId, setCancel: (v) => { cancelValue = v; } });

      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(cancelValue); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      document.body.classList.add("ui-sheet-open");
      openCount++;
      stack.push(entry);
      try { history.pushState({ posUi: true }, ""); pushed = true; } catch (_) {}
      requestAnimationFrame(() => {
        overlay.classList.add("show");
        try { if (focusEl) focusEl.focus({ preventScroll: true }); } catch (_) {}
      });
    });
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  function iconFor(kind) {
    const map = { danger: "!", warn: "!", ok: "✓", info: "i" };
    const n = el("div", "ui-icon ui-icon-" + (kind || "info"), map[kind] || "i");
    n.setAttribute("aria-hidden", "true");
    return n;
  }

  function head(ctx, kind, title, message) {
    ctx.sheet.appendChild(iconFor(kind));
    ctx.sheet.appendChild(Object.assign(el("h3", "ui-title", title), { id: ctx.titleId }));
    if (message) ctx.sheet.appendChild(el("p", "ui-msg", message));
  }

  function confirmDialog(opts) {
    const o = normalize(opts, { title: "Are you sure?", message: "", confirmText: "OK", cancelText: "Cancel", danger: false });
    return openSheet((ctx) => {
      ctx.setCancel(false);
      head(ctx, o.danger ? "danger" : "warn", o.title, o.message);
      const actions = el("div", "ui-actions");
      const cancel = el("button", "ui-btn ui-btn-ghost", o.cancelText);
      const ok = el("button", "ui-btn " + (o.danger ? "ui-btn-danger" : "ui-btn-primary"), o.confirmText);
      cancel.type = ok.type = "button";
      cancel.addEventListener("click", () => ctx.finish(false));
      ok.addEventListener("click", () => ctx.finish(true));
      actions.append(cancel, ok);
      ctx.sheet.appendChild(actions);
      if (o.danger) buzz(12);
      return o.danger ? cancel : ok; // destructive actions start on the safe button
    });
  }

  function alertDialog(opts) {
    const o = normalize(opts, { title: "", message: "", rows: null, okText: "OK", kind: "info" });
    return openSheet((ctx) => {
      ctx.setCancel(undefined);
      head(ctx, o.kind, o.title || "Notice", o.message);
      if (o.rows && o.rows.length) {
        const list = el("ul", "ui-rows");
        o.rows.forEach((r) => {
          const li = el("li", "ui-row");
          const left = el("div", "ui-row-main");
          left.appendChild(el("span", "ui-row-title", r.title || ""));
          if (r.sub) left.appendChild(el("span", "ui-row-sub", r.sub));
          li.appendChild(left);
          if (r.tag) li.appendChild(el("span", "ui-row-tag", r.tag));
          list.appendChild(li);
        });
        ctx.sheet.appendChild(list);
      }
      const actions = el("div", "ui-actions");
      const ok = el("button", "ui-btn ui-btn-primary", o.okText);
      ok.type = "button";
      ok.addEventListener("click", () => ctx.finish(undefined));
      actions.appendChild(ok);
      ctx.sheet.appendChild(actions);
      return ok;
    });
  }

  function promptDialog(opts) {
    const o = normalize(opts, { title: "", message: "", label: "", value: "", placeholder: "", required: false, confirmText: "OK", cancelText: "Cancel", inputType: "text", maxLength: 500, requiredMessage: "This field is required." });
    return openSheet((ctx) => {
      ctx.setCancel(null);
      head(ctx, "info", o.title || "Enter a value", o.message);
      const form = el("form", "ui-form");
      form.noValidate = true;
      const inputId = "ui-input-" + (++uid);
      if (o.label) { const l = el("label", "ui-label", o.label); l.htmlFor = inputId; form.appendChild(l); }
      const input = el("input", "ui-input");
      input.id = inputId;
      input.type = o.inputType;
      input.value = o.value || "";
      input.placeholder = o.placeholder || "";
      input.maxLength = o.maxLength;
      input.autocomplete = "off";
      input.enterKeyHint = "done";
      const err = el("p", "ui-error");
      err.style.display = "none";
      err.setAttribute("role", "alert");
      form.append(input, err);
      const actions = el("div", "ui-actions");
      const cancel = el("button", "ui-btn ui-btn-ghost", o.cancelText);
      const ok = el("button", "ui-btn ui-btn-primary", o.confirmText);
      cancel.type = "button"; ok.type = "submit";
      cancel.addEventListener("click", () => ctx.finish(null));
      actions.append(cancel, ok);
      form.appendChild(actions);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (o.required && !v) {
          err.textContent = o.requiredMessage;
          err.style.display = "block";
          input.classList.remove("ui-shake"); void input.offsetWidth; input.classList.add("ui-shake");
          buzz(20);
          input.focus();
          return;
        }
        ctx.finish(v);
      });
      input.addEventListener("input", () => { err.style.display = "none"; });
      ctx.sheet.appendChild(form);
      setTimeout(() => { try { input.select(); } catch (_) {} }, 60);
      return input;
    });
  }

  // ---- snackbar (replaces toasts and the sticky status banner inside the app) ----
  let snackEl = null, snackText = null, snackTimer = null;
  function hideSnack() {
    clearTimeout(snackTimer);
    if (snackEl) snackEl.classList.remove("show");
  }
  function snack(message, kind, opts) {
    if (!document.body || !message) return;
    kind = kind || "info";
    opts = opts || {};
    if (!snackEl) {
      snackEl = el("div", "ui-snack");
      snackEl.setAttribute("aria-live", "polite");
      snackEl.appendChild(el("span", "ui-snack-dot"));
      snackText = el("span", "ui-snack-text");
      snackEl.appendChild(snackText);
      const x = el("button", "ui-snack-x", "✕");
      x.type = "button";
      x.setAttribute("aria-label", "Dismiss");
      snackEl.appendChild(x);
      snackEl.addEventListener("click", hideSnack);
      document.body.appendChild(snackEl);
    }
    snackEl.className = "ui-snack ui-snack-" + kind;
    snackEl.setAttribute("role", kind === "err" ? "alert" : "status");
    snackText.textContent = message;
    void snackEl.offsetWidth; // restart the slide-in when a new message replaces an old one
    snackEl.classList.add("show");
    if (kind === "err") buzz(25);
    clearTimeout(snackTimer);
    const ms = opts.duration != null ? opts.duration : (kind === "err" ? 6500 : kind === "warn" ? 5000 : 3200);
    snackTimer = setTimeout(hideSnack, ms);
  }

  return { confirm: confirmDialog, alert: alertDialog, prompt: promptDialog, snack, hideSnack };
})();

// Anything that still calls the browser's alert() gets the in-app sheet instead.
window.alert = (m) => { UI.alert({ message: String(m == null ? "" : m) }); };

// Kept for older callers (offline.js, connection events).
function showToast(msg) { UI.snack(msg, "info"); }

Connection.on("change", updateConnectionUI);
Connection.on("lost", () => showToast("You are offline — sales will save on this device"));
Connection.on("restored", () => showToast("Back online — syncing…"));
if (document.readyState === "complete") Connection.start();
else window.addEventListener("load", () => Connection.start());

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _apiFetchOnce(path, options, timeoutMs) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (Auth.token) headers["Authorization"] = `Bearer ${Auth.token}`;
  const ctrl = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: ctrl.signal });
  } catch (e) {
    // fetch only rejects when no HTTP response came back: offline, DNS, timeout, dead socket
    Connection.reportNetworkFailure();
    throw makeNetworkError(e && (e.name === "AbortError" || e.name === "TimeoutError")
      ? "Connection timed out — will retry when the connection is stable"
      : undefined);
  } finally {
    clearTimeout(timer);
  }
  Connection.reportReachable(); // got a real HTTP reply → we are online, instantly
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = new Error(data.error || "Something went wrong");
    e.status = resp.status;
    throw e;
  }
  return data;
}

async function apiFetch(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  // Shorter timeout while we believe we're offline so nothing hangs the till.
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : (Connection.online ? 15000 : 8000);
  try {
    return await _apiFetchOnce(path, options, timeoutMs);
  } catch (e) {
    // Reads are safe to repeat: one quick retry covers a dead keep-alive socket right after reconnect.
    if (e && e.isNetwork && method === "GET" && !options.noRetry) {
      await _sleep(250);
      return await _apiFetchOnce(path, options, timeoutMs);
    }
    throw e;
  }
}

function showStatus(el, message, kind) {
  // Inside the app screens (dashboard/admin) messages appear as a native-style snackbar
  // instead of a banner pushed into the page. Login/signup forms keep their inline message,
  // which is the normal place for form feedback.
  if (el.closest && el.closest(".app-main")) {
    el.className = "status";
    el.textContent = "";
    UI.snack(message, kind === "err" ? "err" : kind === "ok" ? "ok" : "info");
    return;
  }
  el.textContent = message;
  el.className = `status show ${kind}`;
}

/** Navigate within the app — relative paths work on web and Capacitor WebView. */
function goTo(page) {
  const name = String(page || "index.html").replace(/^\//, "");
  window.location.href = name;
}

/**
 * Guard for dashboard / admin pages.
 * - No token or past 24h → index.html (full login)
 * - Idle / locked → show lock overlay (caller installs UI)
 * Returns { ok, locked }
 */
function guardSession() {
  if (!Auth.isLoggedIn() || Auth.isSessionExpired()) {
    Auth.clear();
    goTo("index.html");
    return { ok: false, locked: false };
  }
  if (Auth.isLocked || Auth.shouldIdleLock()) {
    Auth.lock();
    return { ok: true, locked: true };
  }
  Auth.touch();
  return { ok: true, locked: false };
}

/**
 * Start idle + 24h watchers. Call once on dashboard/admin after guardSession.
 * onLock() is called when the screen should lock.
 */
function startSessionWatch(onLock) {
  const bump = () => {
    if (Auth.isLocked) return;
    Auth.touch();
  };
  ["pointerdown", "keydown", "touchstart", "click", "scroll"].forEach((ev) => {
    document.addEventListener(ev, bump, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (Auth.isSessionExpired()) {
        Auth.clear();
        goTo("index.html");
        return;
      }
      if (Auth.shouldIdleLock() || Auth.isLocked) {
        Auth.lock();
        if (typeof onLock === "function") onLock();
      } else {
        Auth.touch();
      }
    }
  });
  // Poll every 30s for idle / absolute expiry
  setInterval(() => {
    if (Auth.isSessionExpired()) {
      Auth.clear();
      goTo("index.html");
      return;
    }
    if (!Auth.isLocked && Auth.shouldIdleLock()) {
      Auth.lock();
      if (typeof onLock === "function") onLock();
    }
  }, 30000);
}

// Inside the Android app the files are bundled locally, so a service worker would
// only cache stale copies of them after an app update. Browser/PWA use keeps it.
const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if ("serviceWorker" in navigator && !IS_NATIVE_APP) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

// ============================================================
// App updates — the APK is released via GitHub Releases (tag vX.Y.Z -> pos.apk).
//  - Login page: shows a "download the app" link to the newest release.
//  - Installed Android app: checks the newest release on launch / when reopened and offers to install it.
// ============================================================
const APP_RELEASE_REPO = "slcantec-web/pointofsale1717";
const APP_APK_URL = `https://github.com/${APP_RELEASE_REPO}/releases/latest/download/pos.apk`;

const AppUpdate = (() => {
  const CHECK_EVERY_MS = 10 * 60 * 1000; // at most one check per 10 min (GitHub allows 60/h per IP)
  const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // after "Later", ask again for the same version after a day

  function cmp(a, b) { // semantic version compare, "1.2.3" style
    const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  }

  async function latest() {
    const r = await fetch(`https://api.github.com/repos/${APP_RELEASE_REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!r.ok) throw new Error("release lookup failed");
    const j = await r.json();
    const apk = (j.assets || []).find((a) => /\.apk$/i.test(a.name));
    return { version: String(j.tag_name || "").replace(/^v/, ""), url: apk ? apk.browser_download_url : APP_APK_URL, notes: (j.body || "").trim() };
  }

  async function installedVersion() {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!App || !App.getInfo) return null;
    try { return (await App.getInfo()).version; } catch (_) { return null; }
  }

  function openUrl(url) {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (B && B.open) B.open({ url }).catch(() => { window.location.href = url; });
    else window.open(url, "_system");
  }

  async function check(force) {
    if (!IS_NATIVE_APP) return;
    try {
      if (!force && Date.now() - parseInt(localStorage.getItem("pos_upd_checked") || "0", 10) < CHECK_EVERY_MS) return;
      const [cur, rel] = await Promise.all([installedVersion(), latest()]);
      localStorage.setItem("pos_upd_checked", String(Date.now())); // only after a successful lookup, so a failed check retries soon
      if (!cur || !rel.version || cmp(rel.version, cur) <= 0) return;
      const snoozed = localStorage.getItem("pos_upd_snooze"); // "version|time"
      if (!force && snoozed) {
        const [v, t] = snoozed.split("|");
        if (v === rel.version && Date.now() - parseInt(t, 10) < REMIND_AFTER_MS) return;
      }
      const yes = await UI.confirm({
        title: `Update available — v${rel.version}`,
        message: `You have v${cur}. Download the new version and tap the file to install it — your data stays on the device and in your account.` + (rel.notes ? `\n\n${rel.notes.slice(0, 300)}` : ""),
        confirmText: "Download update",
        cancelText: "Later",
      });
      if (yes) openUrl(rel.url);
      else localStorage.setItem("pos_upd_snooze", `${rel.version}|${Date.now()}`);
    } catch (_) { /* offline or GitHub unreachable: try again next time */ }
  }

  // Login page: fill in the download link with the newest version number.
  async function fillDownloadLink(linkEl, labelEl) {
    linkEl.href = APP_APK_URL;
    try {
      const rel = await latest();
      if (rel.version) { labelEl.textContent = `Download Android app (v${rel.version})`; linkEl.href = rel.url; }
    } catch (_) { /* keep the generic link */ }
  }

  function start() {
    if (!IS_NATIVE_APP) return;
    setTimeout(() => check(false), 4000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(false); });
  }

  // Text for "version" labels: the installed APK version, or "web" in a browser.
  async function versionLabel() {
    if (!IS_NATIVE_APP) return "web version";
    const v = await installedVersion();
    return v ? "v" + v : "";
  }

  // Manual check (Settings button): always reports back, and ignores the "Later" snooze.
  async function checkNow() {
    if (!IS_NATIVE_APP) { UI.snack("Updates apply to the Android app. The web version is always current.", "info"); return; }
    try {
      const [cur, rel] = await Promise.all([installedVersion(), latest()]);
      if (!cur || !rel.version) throw new Error("no version");
      if (cmp(rel.version, cur) <= 0) { UI.snack(`You're on the latest version (v${cur}).`, "ok"); return; }
      localStorage.removeItem("pos_upd_snooze");
      await check(true);
    } catch (_) { UI.snack("Couldn't check for updates — check your connection.", "err"); }
  }

  return { check, checkNow, start, fillDownloadLink, cmp, versionLabel };
})();
AppUpdate.start();
