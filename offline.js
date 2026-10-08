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

// Only errors that mean "no HTTP response came back" count. Real server replies (400/401/409…)
// and ordinary code errors never do, and navigator.onLine is ignored (stale on Android WebView).
function isNetworkError(e) {
  if (!e) return false;
  if (e.isNetwork) return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  return e.status === 0 || e.status === 408 || e.status === 502 || e.status === 503 || e.status === 504;
}

// Cache key includes the shop so two shops on one device never see each other's data.
async function cachedGet(path) {
  const key = `${Auth.shopId || "x"}:${path}`;
  try {
    const data = await apiFetch(path);
    OfflineDB.put("cache", data, key).catch(() => {});
    return data;
  } catch (e) {
    if (isNetworkError(e)) {
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
  if (!Auth.token) return { posted: 0, failed: 0 };
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
  // If we think we're offline, probe once (shared, never cancelled) before giving up
  if (!Connection.online) {
    const ok = await Connection.probe();
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
        if (total > 0 && Connection.online) scheduleFlush(4000);
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

// ============================================================
// Connection glue — the manager itself lives in app.js (Connection).
// When we come back online: push the queue FIRST, then refresh screens, so the
// refreshed data already includes what was just synced.
// ============================================================
Connection.on("restored", async () => {
  try { await flushAll(); } catch (e) { console.warn("flush after reconnect failed", e); }
  updatePendingBadge();
  if (typeof window.onConnectionRestored === "function") {
    try { await window.onConnectionRestored(); } catch (e) { console.warn("onConnectionRestored failed", e); }
  }
});
Connection.on("change", () => updatePendingBadge());

// Kept for older callers
function probeConnection() { return Connection.probe(); }

async function updatePendingBadge() {
  updateConnectionUI(Connection.online);
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

function notifyOffline(msg) { showToast(msg); }

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

window.addEventListener("load", () => {
  updatePendingBadge();
  scheduleFlush(500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleFlush(300);
});

// Service worker can ask us to flush
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "FLUSH_BILL_QUEUE") scheduleFlush(0);
  });
}
