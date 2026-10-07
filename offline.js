// Offline support for the shop dashboard.
//  - cachedGet(path): GET that falls back to the last good copy when the network is down
//  - queueSale / flushSales: sales rung up offline wait in IndexedDB, then post automatically
//    when the connection returns. Each carries a client_ref so a retry can never double-post.
// Voids, edits and stock-in need the server (doc numbers / stock must stay consistent) and stay online-only.

const OfflineDB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open("pos-offline", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("cache");
        r.result.createObjectStore("sales", { keyPath: "client_ref" });
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
  };
})();

function isNetworkError(e) {
  return e instanceof TypeError || !navigator.onLine;
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

function newClientRef() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
}

async function queueSale(sale) {
  // sale: { client_ref, items, received_amount, created_at, total, receipt }
  await OfflineDB.put("sales", { ...sale, queued_at: Date.now(), error: null });
  updatePendingBadge();
}

let flushing = false;
async function flushSales() {
  if (flushing || !navigator.onLine || !Auth.token) return { posted: 0, failed: 0 };
  flushing = true;
  let posted = 0, failed = 0;
  try {
    const queued = (await OfflineDB.getAll("sales")).sort((a, b) => a.queued_at - b.queued_at);
    for (const s of queued) {
      if (s.error) { failed++; continue; } // rejected by the server earlier — needs a human look
      try {
        await apiFetch("/api/documents/sale", {
          method: "POST",
          body: JSON.stringify({ items: s.items, received_amount: s.received_amount, client_ref: s.client_ref, created_at: s.created_at }),
        });
        await OfflineDB.del("sales", s.client_ref);
        posted++;
      } catch (e) {
        if (isNetworkError(e)) break; // still offline — try again later
        if (e.status === 401) break;   // session expired — log in again, queue is kept
        s.error = e.message;           // e.g. product deleted — park it, don't block the rest
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

async function updatePendingBadge() {
  const el = document.getElementById("offline-badge");
  if (!el) return;
  const all = await OfflineDB.getAll("sales").catch(() => []);
  const parts = [];
  if (!navigator.onLine) parts.push("OFFLINE");
  if (all.length) parts.push(`${all.length} UNSYNCED`);
  el.textContent = parts.join(" · ");
  el.style.display = parts.length ? "inline-block" : "none";
  el.classList.toggle("zero", !all.some((s) => s.error) && navigator.onLine);
}

window.addEventListener("online", () => { flushSales(); updatePendingBadge(); });
window.addEventListener("offline", updatePendingBadge);
setInterval(flushSales, 30000);
window.addEventListener("load", () => { updatePendingBadge(); flushSales(); });
