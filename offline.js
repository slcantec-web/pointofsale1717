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
  return e instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
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
}

let flushing = false;
async function flushSales() {
  if (flushing || !navigator.onLine || !Auth.token) return { posted: 0, failed: 0 };
  flushing = true;
  let posted = 0, failed = 0;
  try {
    const queued = (await OfflineDB.getAll("sales")).sort((a, b) => a.queued_at - b.queued_at);
    for (const s of queued) {
      if (s.error) { failed++; continue; }
      try {
        await apiFetch("/api/documents/sale", {
          method: "POST",
          body: JSON.stringify({ items: s.items, received_amount: s.received_amount, client_ref: s.client_ref, created_at: s.created_at }),
        });
        await OfflineDB.del("sales", s.client_ref);
        posted++;
      } catch (e) {
        if (isNetworkError(e)) break;
        if (e.status === 401) break;
        s.error = e.message;
        await OfflineDB.put("sales", s);
        failed++;
      }
    }
  } finally {
    flushing = false;
    updatePendingBadge();
  }
  if (posted && typeof window.onSalesSynced === "function") window.onSalesSynced(posted);
  return { posted, failed };
}

let flushingWrites = false;
async function flushWrites() {
  if (flushingWrites || !navigator.onLine || !Auth.token) return { posted: 0, failed: 0 };
  flushingWrites = true;
  let posted = 0, failed = 0;
  try {
    const queued = (await OfflineDB.getAll("writes")).sort((a, b) => a.queued_at - b.queued_at);
    for (const w of queued) {
      if (w.error) { failed++; continue; }
      try {
        await apiFetch(w.path, {
          method: w.method || "POST",
          body: typeof w.body === "string" ? w.body : JSON.stringify(w.body),
        });
        await OfflineDB.del("writes", w.id);
        posted++;
      } catch (e) {
        if (isNetworkError(e)) break;
        if (e.status === 401) break;
        w.error = e.message;
        await OfflineDB.put("writes", w);
        failed++;
      }
    }
  } finally {
    flushingWrites = false;
    updatePendingBadge();
  }
  if (posted && typeof window.onWritesSynced === "function") window.onWritesSynced(posted);
  return { posted, failed };
}

async function flushAll() {
  const s = await flushSales();
  const w = await flushWrites();
  const total = s.posted + w.posted;
  if (total > 0) {
    notifySync(`${total} change(s) synced successfully`);
    if (typeof window.onOfflineSynced === "function") window.onOfflineSynced(total);
  }
  return { sales: s, writes: w, total };
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

async function updatePendingBadge() {
  const el = document.getElementById("offline-badge");
  if (!el) return;
  const { total, hasError } = await pendingCount();
  const parts = [];
  if (!navigator.onLine) parts.push("OFFLINE");
  if (total) parts.push(`${total} UNSYNCED`);
  el.textContent = parts.join(" · ");
  el.style.display = parts.length ? "inline-block" : "none";
  el.classList.toggle("zero", !hasError && navigator.onLine);
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

window.addEventListener("online", () => { flushAll(); updatePendingBadge(); });
window.addEventListener("offline", updatePendingBadge);
setInterval(flushAll, 30000);
window.addEventListener("load", () => { updatePendingBadge(); flushAll(); });

// Service worker can ask us to flush
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "FLUSH_BILL_QUEUE") flushAll();
  });
}
