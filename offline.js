// Offline support for the shop dashboard.
//  - cachedGet(path): GET that falls back to the last good copy when the network is down
//  - queueSale / queueWrite / flushAll: sales + other writes wait in IndexedDB, then post
//    automatically when the connection returns. Sales use client_ref for idempotency.
//  - Badge + optional toast when sync completes.
// Voids/edits still prefer online (doc numbers / stock consistency); stock-in and product
// CRUD are queued offline with optimistic local cache updates.

const OfflineDB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open("pos-offline", 2);
      r.onupgradeneeded = (ev) => {
        const db = r.result;
        if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache");
        if (!db.objectStoreNames.contains("sales")) db.createObjectStore("sales", { keyPath: "client_ref" });
        if (!db.objectStoreNames.contains("writes")) {
          db.createObjectStore("writes", { keyPath: "id", autoIncrement: true });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
    getAll: (store) => tx(store, "readonly", (s) => s.getAll()),
    put: (store, val, key) => tx(store, "readwrite", (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
    clear: (store) => tx(store, "readwrite", (s) => s.clear()),
  };
})();

function isNetworkError(e) {
  if (!e) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (e instanceof TypeError) return true;
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  // fetch failures / worker timeouts often surface as TypeError; also treat 0/408/502/503/504
  if (e.status === 0 || e.status === 408 || e.status === 502 || e.status === 503 || e.status === 504) return true;
  return false;
}

// Cache key includes the shop so two shops on one device never see each other's data.
async function cachedGet(path) {
  const key = `${Auth.shopId || "x"}:${path}`;
  try {
    const data = await apiFetch(path);
    OfflineDB.put("cache", data, key).catch(() => {});
    if (typeof markOnline === "function") markOnline();
    return data;
  } catch (e) {
    if (isNetworkError(e)) {
      if (typeof markOffline === "function") markOffline();
      const hit = await OfflineDB.get("cache", key);
      if (hit !== undefined) return hit;
    }
    throw e;
  }
}

/** Write a value into the local GET cache (optimistic update after offline write). */
async function cachePut(path, data) {
  const key = `${Auth.shopId || "x"}:${path}`;
  await OfflineDB.put("cache", data, key);
}

/** Read cache only (no network). */
async function cacheGet(path) {
  const key = `${Auth.shopId || "x"}:${path}`;
  return OfflineDB.get("cache", key);
}

function newClientRef() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
}

async function queueSale(sale) {
  // sale: { client_ref, items, received_amount, created_at, total, receipt }
  await OfflineDB.put("sales", { ...sale, queued_at: Date.now(), error: null });
  updatePendingBadge();
  notifyOffline("Sale saved offline — will sync when online");
  scheduleFlush(0); // try right away if we are (or just became) online
  registerBackgroundSync();
}

/**
 * Queue a generic write (product create/update, stock-in, settings, item-group, etc.)
 * entry: { path, method, body, label?, invalidate?[] }
 */
async function queueWrite(entry) {
  await OfflineDB.put("writes", {
    ...entry,
    queued_at: Date.now(),
    error: null,
  });
  updatePendingBadge();
  notifyOffline((entry.label || "Change") + " saved offline — will sync when online");
  scheduleFlush(0);
  registerBackgroundSync();
}

// ---- flush orchestration ----
// Coalesce concurrent flush requests so we never skip work while a flush is running,
// and retry quickly when there is still pending work (instead of waiting 30s).
let flushing = false;
let flushAgain = false;
let flushTimer = null;

function scheduleFlush(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAll();
  }, Math.max(0, delayMs == null ? 0 : delayMs));
}

async function flushSales() {
  // Do not trust navigator.onLine alone — recovery may have marked us online via probe
  if (!Auth.token) return { posted: 0, failed: 0 };
  if (!_connState && typeof navigator !== "undefined" && !navigator.onLine) return { posted: 0, failed: 0 };
  let posted = 0, failed = 0;
  const queued = (await OfflineDB.getAll("sales")).sort((a, b) => a.queued_at - b.queued_at);
  for (const s of queued) {
    // Skip permanent errors only if we already marked them; transient network keeps retrying
    if (s.error && !isNetworkError({ message: s.error })) {
      // leave hard failures (validation etc.) until user clears / next session
      failed++;
      continue;
    }
    try {
      await apiFetch("/api/documents/sale", {
        method: "POST",
        body: JSON.stringify({
          items: s.items,
          received_amount: s.received_amount,
          client_ref: s.client_ref,
          created_at: s.created_at,
        }),
      });
      await OfflineDB.del("sales", s.client_ref);
      posted++;
    } catch (e) {
      if (isNetworkError(e) || e.status === 401) {
        // stop the batch; will retry on next schedule
        break;
      }
      s.error = e.message || "post failed";
      await OfflineDB.put("sales", s);
      failed++;
    }
  }
  return { posted, failed };
}

async function flushWrites() {
  if (!Auth.token) return { posted: 0, failed: 0 };
  if (!_connState && typeof navigator !== "undefined" && !navigator.onLine) return { posted: 0, failed: 0 };
  let posted = 0, failed = 0;
  const queued = (await OfflineDB.getAll("writes")).sort((a, b) => a.queued_at - b.queued_at);
  for (const w of queued) {
    if (w.error && !isNetworkError({ message: w.error })) {
      failed++;
      continue;
    }
    try {
      await apiFetch(w.path, {
        method: w.method || "POST",
        body: typeof w.body === "string" ? w.body : JSON.stringify(w.body),
      });
      await OfflineDB.del("writes", w.id);
      posted++;
    } catch (e) {
      if (isNetworkError(e) || e.status === 401) break;
      w.error = e.message || "post failed";
      await OfflineDB.put("writes", w);
      failed++;
    }
  }
  return { posted, failed };
}

async function flushAll() {
  if (flushing) {
    flushAgain = true;
    return { sales: { posted: 0, failed: 0 }, writes: { posted: 0, failed: 0 }, total: 0 };
  }
  if (!Auth.token) {
    updatePendingBadge();
    return { sales: { posted: 0, failed: 0 }, writes: { posted: 0, failed: 0 }, total: 0 };
  }
  // If UI says offline, probe once before giving up (Android often recovers before navigator)
  if (!_connState) {
    const ok = await probeConnection(true);
    if (!ok) {
      updatePendingBadge();
      return { sales: { posted: 0, failed: 0 }, writes: { posted: 0, failed: 0 }, total: 0 };
    }
  }

  flushing = true;
  flushAgain = false;
  let s = { posted: 0, failed: 0 };
  let w = { posted: 0, failed: 0 };
  try {
    s = await flushSales();
    w = await flushWrites();
    const total = s.posted + w.posted;
    if (total > 0) {
      notifySync(`${total} change(s) synced successfully`);
      if (typeof window.onSalesSynced === "function" && s.posted) window.onSalesSynced(s.posted);
      if (typeof window.onWritesSynced === "function" && w.posted) window.onWritesSynced(w.posted);
      if (typeof window.onOfflineSynced === "function") window.onOfflineSynced(total);
    }
  } finally {
    flushing = false;
    updatePendingBadge();
    // If another flush was requested while we ran, do it immediately
    if (flushAgain) {
      flushAgain = false;
      scheduleFlush(50);
    } else {
      // Keep retrying quickly while work remains; slow interval when empty
      pendingCount().then(({ total }) => {
        if (total > 0 && navigator.onLine) scheduleFlush(4000);
        else scheduleFlush(30000);
      }).catch(() => scheduleFlush(30000));
    }
  }
  return { sales: s, writes: w, total: s.posted + w.posted };
}

async function pendingCount() {
  const sales = await OfflineDB.getAll("sales").catch(() => []);
  const writes = await OfflineDB.getAll("writes").catch(() => []);
  const firstErr = [...sales, ...writes].find((x) => x.error);
  return { sales: sales.length, writes: writes.length, total: sales.length + writes.length, hasError: !!firstErr, firstError: firstErr ? firstErr.error : "" };
}

// Give previously-failed items another go (used by the SYNC button).
async function retryFailedQueue() {
  for (const store of ["sales", "writes"]) {
    const rows = await OfflineDB.getAll(store).catch(() => []);
    for (const r of rows) if (r.error) { r.error = null; await OfflineDB.put(store, r); }
  }
}

// Drop queued changes (not sales) that keep failing, so the UNSYNCED badge can clear.
async function discardFailedWrites() {
  const rows = await OfflineDB.getAll("writes").catch(() => []);
  for (const r of rows) if (r.error) await OfflineDB.del("writes", r.id);
  updatePendingBadge();
}

// Real connectivity state. navigator.onLine alone is unreliable on Android WebView.
// Fast recovery: short timeouts, parallel probes, 2s offline retry, optimistic online event.
let _connState = true;
let _connProbeInFlight = false;
let _connProbeTimer = null;
let _lastConnNotify = null;
let _connWatchStarted = false;
let _connWatchMs = 0; // current interval so we don't reset needlessly

function updateConnectionUI(online) {
  const prev = _connState;
  const isOnline = online != null ? !!online : _connState;
  _connState = isOnline;
  const chip = document.getElementById("conn-status");
  const banner = document.getElementById("conn-banner");
  if (chip) {
    chip.classList.toggle("online", isOnline);
    chip.classList.toggle("offline", !isOnline);
    const label = chip.querySelector(".conn-label");
    if (label) label.textContent = isOnline ? "Online" : "Offline";
    chip.title = isOnline
      ? "Connected — tap to recheck"
      : "No internet — tap to recheck";
  }
  if (banner) {
    banner.style.display = isOnline ? "none" : "block";
  }
  document.body.classList.toggle("is-offline", !isOnline);
  document.body.classList.toggle("is-online", isOnline);
  // Only retune the timer when online/offline *changes* (avoid delaying recovery)
  if (prev !== isOnline) rescheduleConnWatch();
}

/** Mark offline immediately (e.g. after a failed API call). */
function markOffline() {
  const wasOnline = _connState;
  updateConnectionUI(false);
  if (wasOnline && _lastConnNotify !== "off") {
    _lastConnNotify = "off";
    notifyOffline("You are offline — sales will save on this device");
  }
}

/** Mark online after a successful network call. */
function markOnline() {
  const wasOffline = !_connState;
  updateConnectionUI(true);
  if (wasOffline && _lastConnNotify !== "on") {
    _lastConnNotify = "on";
    notifyOffline("Back online — syncing…");
    scheduleFlush(0);
  }
}

function _fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/**
 * Fast probe of the Worker.
 * Parallel short requests (1.8s max) so recovery is near-instant when net returns.
 */
async function probeConnection(force) {
  if (_connProbeInFlight && !force) return _connState;
  _connProbeInFlight = true;
  const base = typeof API_BASE !== "undefined" ? API_BASE : "";
  try {
    if (!base) {
      const guess = typeof navigator === "undefined" || navigator.onLine !== false;
      if (guess) markOnline();
      else markOffline();
      return guess;
    }

    const bust = Date.now();
    const timeoutMs = _connState ? 3000 : 1800; // fail faster while offline so we can retry

    // Run CORS + no-cors in parallel — first success wins
    const cors = _fetchWithTimeout(
      base + "/api/health?_=" + bust,
      {
        method: "GET",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      },
      timeoutMs
    ).then((resp) => {
      if (resp && (resp.ok || resp.status > 0)) return true;
      throw new Error("bad status");
    });

    const nocors = _fetchWithTimeout(
      base + "/api/health?_=" + bust + "&nc=1",
      { method: "GET", mode: "no-cors", cache: "no-store" },
      timeoutMs
    ).then(() => true); // opaque response still means reachable

    try {
      // Promise.any may be missing on older WebViews
      if (typeof Promise.any === "function") {
        await Promise.any([cors, nocors]);
      } else {
        await new Promise((resolve, reject) => {
          let left = 2;
          const fail = () => { if (--left === 0) reject(new Error("all failed")); };
          cors.then(resolve, fail);
          nocors.then(resolve, fail);
        });
      }
      markOnline();
      return true;
    } catch (_) {
      markOffline();
      return false;
    }
  } finally {
    _connProbeInFlight = false;
  }
}

function rescheduleConnWatch() {
  if (!_connWatchStarted) return;
  // Offline: every 2s. Online: every 20s.
  const ms = _connState ? 20000 : 2000;
  if (_connProbeTimer && _connWatchMs === ms) return; // already on the right cadence
  if (_connProbeTimer) {
    clearInterval(_connProbeTimer);
    _connProbeTimer = null;
  }
  _connWatchMs = ms;
  _connProbeTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    probeConnection(true);
  }, ms);
}

function startConnectionWatch() {
  if (_connWatchStarted) return;
  _connWatchStarted = true;
  probeConnection(true);
  rescheduleConnWatch();
  // Tap the status chip to force a recheck
  const chip = document.getElementById("conn-status");
  if (chip && !chip._connBound) {
    chip._connBound = true;
    chip.style.cursor = "pointer";
    chip.addEventListener("click", () => {
      const label = chip.querySelector(".conn-label");
      if (label) label.textContent = "…";
      probeConnection(true).then(() => updatePendingBadge());
    });
  }
}

async function updatePendingBadge() {
  updateConnectionUI(_connState);
  const el = document.getElementById("offline-badge");
  if (!el) return;
  const { total, hasError } = await pendingCount();
  const parts = [];
  if (total) parts.push(total + " unsynced");
  if (hasError) parts.push("sync error");
  el.textContent = parts.join(" · ");
  el.style.display = parts.length ? "inline-block" : "none";
  el.classList.toggle("zero", !hasError);
}

function notifyOffline(msg) {
  if (typeof window.showStatus === "function" && document.getElementById("status")) {
    // prefer app's status bar when available
  }
  // lightweight toast that works even without status element
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

function notifySync(msg) {
  notifyOffline(msg);
  // Capacitor / Android: try system notification if plugin present
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
      window.Capacitor.Plugins.LocalNotifications.schedule({
        notifications: [{ title: "POS synced", body: msg, id: Date.now() % 100000 }],
      }).catch(() => {});
    }
  } catch (_) {}
}

function registerBackgroundSync() {
  try {
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.sync) reg.sync.register("sync-bills").catch(() => {});
      }).catch(() => {});
    }
  } catch (_) {}
}

window.addEventListener("online", () => {
  // Instant optimistic Online, then confirm with probe
  markOnline();
  updatePendingBadge();
  scheduleFlush(0);
  probeConnection(true).then((ok) => {
    updatePendingBadge();
    if (ok) scheduleFlush(0);
  });
});
window.addEventListener("offline", () => {
  markOffline();
  updatePendingBadge();
});
window.addEventListener("load", () => {
  startConnectionWatch();
  updatePendingBadge();
  scheduleFlush(500);
});
// visibility: when user returns to the tab/app, force re-probe + flush
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    probeConnection(true).then(() => updatePendingBadge());
    scheduleFlush(0);
  }
});
// Network interface change (mobile data / Wi‑Fi toggle)
try {
  if (navigator.connection && navigator.connection.addEventListener) {
    navigator.connection.addEventListener("change", () => {
      if (typeof navigator !== "undefined" && navigator.onLine) {
        markOnline();
        scheduleFlush(0);
      }
      probeConnection(true).then(() => updatePendingBadge());
    });
  }
} catch (_) {}

// Service worker can ask us to flush
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "FLUSH_BILL_QUEUE") scheduleFlush(0);
  });
}
