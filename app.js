// Update this once the Worker is deployed (see README.md in the project root)
const API_BASE = "https://pos.slcantec.workers.dev";

const Auth = {
  get token() { return localStorage.getItem("pos_token"); },
  get role() { return localStorage.getItem("pos_role"); },
  get shopId() { return localStorage.getItem("pos_shop_id"); },
  set({ token, role, shopId }) {
    localStorage.setItem("pos_token", token);
    localStorage.setItem("pos_role", role);
    if (shopId) localStorage.setItem("pos_shop_id", shopId);
  },
  clear() {
    localStorage.removeItem("pos_token");
    localStorage.removeItem("pos_role");
    localStorage.removeItem("pos_shop_id");
  },
  isLoggedIn() { return !!this.token; },
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
