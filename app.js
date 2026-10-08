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

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (Auth.token) headers["Authorization"] = `Bearer ${Auth.token}`;
  // Hard timeout so a hung request does not leave the till on "POSTING..." forever.
  // Callers that want offline fallback treat AbortError / TypeError as network errors.
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 15000;
  const ctrl = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: ctrl.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const e = new Error(data.error || "Something went wrong");
      e.status = resp.status;
      throw e;
    }
    return data;
  } catch (e) {
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
      const te = new TypeError("Network timeout — will retry when connection is stable");
      te.status = 0;
      throw te;
    }
    throw e;
  } finally {
    clearTimeout(timer);
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
