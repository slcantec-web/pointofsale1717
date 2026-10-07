/* Shared helpers for Point of Sale PWA */

const API_BASE = (() => {
  // Capacitor Android WebView is file:// or capacitor:// — always hit the live API host.
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (isNative) return "https://pos-api.slcantec.com";
  // Local static preview / file open
  if (location.protocol === "file:" || location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "https://pos-api.slcantec.com";
  }
  // Production Pages + custom domain
  return "";
})();

function getToken() {
  return localStorage.getItem("pos_token") || "";
}

function setToken(t) {
  if (t) localStorage.setItem("pos_token", t);
  else localStorage.removeItem("pos_token");
}

function getRole() {
  return localStorage.getItem("pos_role") || "";
}

function setRole(r) {
  if (r) localStorage.setItem("pos_role", r);
  else localStorage.removeItem("pos_role");
}

function clearSession() {
  setToken("");
  setRole("");
}

async function apiFetch(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers,
      signal: opts.signal || controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText || "request failed";
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Request timed out");
      err.status = 0;
      throw err;
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

// Inside the Android app the files are bundled locally, so a service worker would
// only cache stale copies of them after an app update. Browser/PWA use keeps it.
const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if ("serviceWorker" in navigator && !IS_NATIVE_APP) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
