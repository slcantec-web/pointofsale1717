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
  const PROBE_TIMEOUT_MS = 4000;
  const POLL_MIN_MS = 1000;
  const POLL_MAX_MS = 5000;
  const HEARTBEAT_MS = 30000;
  const listeners = { change: [], lost: [], restored: [] };
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let probePromise = null;
  let pollTimer = null;
  let pollDelay = POLL_MIN_MS;
  let lastFailAt = 0;
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

  // One probe at a time. Callers that arrive while one is running share its result,
  // so a slow-but-successful probe is never thrown away.
  function probe() {
    if (probePromise) return probePromise;
    probePromise = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch(`${API_BASE}/api/health?_=${Date.now()}`, { method: "GET", cache: "no-store", signal: ctrl.signal });
        set(true); // any HTTP response means the network path works
        return true;
      } catch (_) {
        lastFailAt = Date.now();
        set(false);
        startPolling(); // also covers "app opened while already offline" (no state change to trigger it)
        return false;
      } finally {
        clearTimeout(timer);
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
  function reportReachable() { set(true); }
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
    window.addEventListener("offline", () => set(false));
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
        const p = N.addListener("networkStatusChange", (s) => { if (s && s.connected) nudge(); else set(false); });
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

// Small toast that works on every page.
function showToast(msg) {
  if (!document.body) return;
  let t = document.getElementById("offline-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "offline-toast";
    t.setAttribute("role", "status");
    t.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;background:#1a2332;color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;text-align:center;display:none;pointer-events:none;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._hide);
  t._hide = setTimeout(() => { t.style.display = "none"; }, 3200);
}

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
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : (Connection.online ? 15000 : 6000);
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
  el.textContent = message;
  el.className = `status show ${kind}`;
  clearTimeout(el._hideT);
  // Auto-clear only inside the app screens (dashboard/admin). Signup/login messages stay.
  if (el.closest && el.closest(".app-main")) {
    el._hideT = setTimeout(() => { el.className = "status"; }, kind === "err" ? 7000 : 4000);
    el.onclick = () => { el.className = "status"; };
  }
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
