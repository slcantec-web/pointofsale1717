// POS System Worker
// Bindings required (set in Cloudflare dashboard -> Worker -> Settings -> Variables):
//   DB          -> D1 database binding
//   AUTH_SECRET -> a long random string (used to sign session tokens)

// ---------- small utils ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bufToHex(sig)}`;
}

async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sigHex] = token.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSig = bufToHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  );
  if (expectedSig !== sigHex) return null;
  const payload = JSON.parse(b64urlDecode(body));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

// Password hashing via Web Crypto PBKDF2 (no external deps needed — worker.js stays
// a single file that pastes cleanly into the dashboard editor). Stored as "saltHex:hashHex".
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  return `${bufToHex(salt.buffer)}:${bufToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256);
  return bufToHex(bits) === hashHex;
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const payload = await verifyToken(token, env.AUTH_SECRET);
  if (!payload) return null;
  return payload; // { userId, shopId, role, exp }
}

// ---------- doc number + document posting core ----------

// Atomically claims the next doc_number for a shop. SQLite serializes writes
// per-database, so this single UPDATE...RETURNING is race-safe even under
// concurrent requests.
async function claimDocNumber(db, shopId) {
  const result = await db
    .prepare(`UPDATE shops SET next_doc_number = next_doc_number + 1 WHERE id = ? RETURNING next_doc_number`)
    .bind(shopId)
    .first();
  if (!result) throw new Error("shop not found");
  return result.next_doc_number - 1; // number assigned to this doc
}

// Same atomic-counter pattern as claimDocNumber, for products.item_code. item_code is
// system-assigned and never user-editable, so a shop's item numbers are always a clean
// cumulative sequence — useful later as a stable key to hang a barcode off of.
async function claimItemNumber(db, shopId) {
  const result = await db
    .prepare(`UPDATE shops SET next_item_number = next_item_number + 1 WHERE id = ? RETURNING next_item_number`)
    .bind(shopId)
    .first();
  if (!result) throw new Error("shop not found");
  return String(result.next_item_number - 1);
}

// Inserts a document + its items + applies stock/cost effects, as one atomic batch.
// taxRate: shop's tax_rate, applied to (subtotal - discount) to compute this document's
// tax_amount — used when posting an original SALE.
// taxAmountOverride: an exact tax_amount to store instead of computing one — used when
// voiding, so the REVERSAL reverses precisely what the original document recorded, even
// if the shop's tax_rate has since changed (rather than recomputing at the current rate).
async function postDocument(db, { shopId, docType, referenceDocId, items, createdBy, tracksInventory, note, taxRate, taxAmountOverride, receivedAmount }) {
  const docNumber = await claimDocNumber(db, shopId);

  let subtotal = 0,
    discountTotal = 0,
    preTaxTotal = 0,
    gpTotal = 0;

  // For inventory-mode weighted-average cost updates on STOCK_IN, we need
  // current qty/cost per product before applying this document's changes.
  const productCache = {};
  async function getProduct(productId) {
    if (!productCache[productId]) {
      productCache[productId] = await db.prepare(`SELECT * FROM products WHERE id = ?`).bind(productId).first();
    }
    return productCache[productId];
  }

  const preparedItems = [];
  for (const item of items) {
    const lineTotal = item.qty * item.unit_price - (item.discount_amount || 0);
    const gp = item.product_id ? (item.unit_price - item.cost_price) * item.qty - (item.discount_amount || 0) : 0;
    subtotal += item.qty * item.unit_price;
    discountTotal += item.discount_amount || 0;
    preTaxTotal += lineTotal;
    gpTotal += gp;

    preparedItems.push({
      product_id: item.product_id || null,
      name: item.name,
      qty: item.qty,
      unit_price: item.unit_price || 0,
      cost_price: item.cost_price || 0,
      discount_amount: item.discount_amount || 0,
      line_total: lineTotal,
      gp_amount: gp,
      stock_effect: item.stock_effect || 0,
    });
  }

  const taxAmount = typeof taxAmountOverride === "number" ? taxAmountOverride : taxRate ? preTaxTotal * taxRate : 0;
  const total = preTaxTotal + taxAmount;

  // Cash received against this document, and the resulting balance (negative = still
  // owed, positive = change given back). Only meaningful for SALE documents — a shop
  // taking money for a sale can't record having received less than the total due, so
  // that's enforced here (server-side, not just as a UI nicety) before anything is
  // written. Defaults to the exact total when not supplied, so older clients that don't
  // send it yet behave exactly as before (0 balance).
  let finalReceivedAmount = 0;
  let balanceDue = 0;
  if (docType === "SALE") {
    finalReceivedAmount = typeof receivedAmount === "number" ? receivedAmount : total;
    if (finalReceivedAmount - total < -0.005) {
      const e = new Error("received amount can't be less than the total due");
      e.status = 400;
      throw e;
    }
    balanceDue = finalReceivedAmount - total;
  }

  const stmts = [];

  stmts.push(
    db
      .prepare(
        `INSERT INTO documents (shop_id, doc_type, doc_number, reference_doc_id, subtotal, discount_amount, tax_amount, total, received_amount, balance_due, created_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(shopId, docType, docNumber, referenceDocId || null, subtotal, discountTotal, taxAmount, total, finalReceivedAmount, balanceDue, createdBy || null, note || null)
  );

  const docInsert = await db.batch(stmts);
  const documentId = docInsert[0].meta.last_row_id;

  const itemStmts = preparedItems.map((it) =>
    db
      .prepare(
        `INSERT INTO document_items (document_id, product_id, name, qty, unit_price, cost_price, discount_amount, line_total, gp_amount, stock_effect)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(documentId, it.product_id, it.name, it.qty, it.unit_price, it.cost_price, it.discount_amount, it.line_total, it.gp_amount, it.stock_effect)
  );
  if (itemStmts.length) await db.batch(itemStmts);

  // Apply stock + cost effects (inventory mode only)
  if (tracksInventory) {
    for (const it of preparedItems) {
      if (!it.product_id || it.stock_effect === 0) continue;

      if (docType === "STOCK_IN") {
        const product = await getProduct(it.product_id);
        const currentQty = product.stock_qty || 0;
        const currentCost = product.cost_price || 0;
        const incomingQty = it.stock_effect;
        const newQty = currentQty + incomingQty;
        const newCost = newQty > 0 ? (currentQty * currentCost + incomingQty * it.cost_price) / newQty : currentCost;
        await db
          .prepare(`UPDATE products SET stock_qty = ?, cost_price = ? WHERE id = ?`)
          .bind(newQty, newCost, it.product_id)
          .run();
      } else {
        // SALE, REVERSAL, STOCK_IN_REVERSAL: just add stock_effect (already signed correctly by caller)
        await db
          .prepare(`UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?`)
          .bind(it.stock_effect, it.product_id)
          .run();
      }
    }
  }

  return { documentId, docNumber, subtotal, discountTotal, taxAmount, total, gpTotal, receivedAmount: finalReceivedAmount, balanceDue };
}

// ---------- route handlers ----------

const SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — one device per shop, re-verifying by email every session is friction, not security

// Sends a password-reset link. The link only loads a page — the token is consumed
// on the user's actual form submit (handleResetPassword), not on page load. That
// matters because email security scanners auto-visit links in incoming mail; if the
// link itself performed the state change (like the old magic-link login did), a
// scanner would silently burn the one-time token before the real person ever clicked.
async function sendPasswordResetEmail(env, user) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO magic_links (user_id, token, expires_at) VALUES (?, ?, ?)`).bind(user.id, token, expiresAt).run();
  const link = `${env.FRONTEND_URL}/reset-password.html?token=${token}`;
  await sendEmail(
    env,
    user.email,
    "Reset your POS password",
    `<p>Tap the link below to set a new password. It expires in 30 minutes and can only be used once.</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, you can ignore this email — your password won't change.</p>`
  );
}

// Strict-ish email validator used to gate every address before it reaches the mail
// layer. Rejects whitespace/CR/LF (which is what would let a crafted "email" value
// inject extra SMTP commands/headers) and requires a plausible local@domain.tld shape.
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s<>()[\]\\,;:"]+@[^\s<>()[\]\\,;:"]+\.[^\s<>()[\]\\,;:"]{2,}$/.test(email);
}

async function sendEmail(env, to, subject, html) {
  // Defense in depth: even though every caller should already be passing a
  // validated address, strip any stray CR/LF before it ever reaches SMTP/HTTP
  // headers so a bad value can't inject extra commands or headers.
  const safeTo = String(to).replace(/[\r\n]/g, "");
  const safeSubject = String(subject).replace(/[\r\n]/g, "");
  if (env.EMAIL_PROVIDER === "gmail") {
    return sendViaGmailSmtp(env, safeTo, safeSubject, html);
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: safeTo, subject: safeSubject, html }),
  });
  if (!resp.ok) throw new Error("failed to send email");
}

// Minimal SMTP client over cloudflare:sockets, authenticating as a real Gmail
// account (App Password) rather than verifying a domain. Good enough for the
// low volume a small POS deployment sends (login links, approval notices) —
// not a general-purpose mailer (no retries, no attachments, one recipient at a time).
async function sendViaGmailSmtp(env, to, subject, html) {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect("smtp.gmail.com:465", { secureTransport: "on" });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const state = { leftover: "" };

  async function read() {
    while (true) {
      const lines = state.leftover.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        const code = parseInt(lines[0].slice(0, 3), 10);
        state.leftover = "";
        return { code, text: lines.join("\n") };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("gmail smtp connection closed unexpectedly");
      state.leftover += new TextDecoder().decode(value);
    }
  }

  async function write(line) {
    await writer.write(new TextEncoder().encode(line + "\r\n"));
  }

  try {
    await read(); // 220 greeting
    await write("EHLO pos-worker");
    await read();
    await write("AUTH LOGIN");
    await read(); // 334 "Username:"
    await write(btoa(env.GMAIL_USER));
    await read(); // 334 "Password:"
    await write(btoa(env.GMAIL_APP_PASSWORD));
    const auth = await read();
    if (auth.code !== 235) throw new Error("gmail smtp authentication failed");

    await write(`MAIL FROM:<${env.GMAIL_USER}>`);
    await read();
    await write(`RCPT TO:<${to}>`);
    await read();
    await write("DATA");
    await read(); // 354

    const message =
      `From: ${env.GMAIL_USER}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
      html.replace(/\r?\n\./g, "\r\n..") + // dot-stuff any line that starts with '.'
      "\r\n.";
    await write(message);
    const sent = await read();
    if (sent.code !== 250) throw new Error("gmail smtp send failed");

    await write("QUIT");
  } finally {
    try { await writer.close(); } catch {}
    try { await reader.cancel(); } catch {}
  }
}

async function handleForgotPassword(request, env) {
  const { email } = await request.json();
  if (!email) return err("email required");
  // Malformed addresses can't belong to a real account anyway (signup/admin-create
  // both validate on the way in) — short-circuit before ever touching sendEmail.
  // Still returns the same generic {ok:true}, so this doesn't leak anything an
  // invalid-format check wouldn't already reveal on its own.
  if (!isValidEmail(email)) return json({ ok: true });

  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ? AND active = 1`).bind(email).first();
  // Always return ok even if not found, so this endpoint can't be used to test which emails are registered
  if (user) await sendPasswordResetEmail(env, user);

  return json({ ok: true });
}

async function handleResetPassword(request, env) {
  const { token, password } = await request.json();
  if (!token || !password) return err("token and password required");
  if (password.length < 8) return err("password must be at least 8 characters");

  const link = await env.DB.prepare(`SELECT * FROM magic_links WHERE token = ?`).bind(token).first();
  if (!link || link.used || new Date(link.expires_at) < new Date()) return err("this reset link is invalid or has expired", 401);

  await env.DB.prepare(`UPDATE magic_links SET used = 1 WHERE id = ?`).bind(link.id).run();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, link.user_id).run();

  return json({ ok: true });
}

async function handleShopSignup(request, env) {
  const body = await request.json();
  const { name, email, password, tracks_inventory, address, contact_number } = body;
  if (!name || !email) return err("name and email required");
  if (!isValidEmail(email)) return err("a valid email address is required");
  if (!password || password.length < 8) return err("password must be at least 8 characters");

  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) return err("an account with this email already exists", 409);

  const shop = await env.DB.prepare(
    `INSERT INTO shops (name, legal_name, address, contact_number, tracks_inventory, status)
     VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id`
  )
    .bind(name, name, address || "", contact_number || "", tracks_inventory ? 1 : 0)
    .first();

  const passwordHash = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO users (shop_id, email, role, password_hash) VALUES (?, ?, 'shop', ?)`)
    .bind(shop.id, email, passwordHash)
    .run();

  await sendEmail(env, email, "POS signup received", `<p>Thanks for signing up ${name}. We'll review your account and email you once it's approved.</p>`);

  return json({ ok: true, shopId: shop.id });
}

// Password login: returns the session token directly in the JSON response, no email
// round-trip needed. Same shop status gating as the magic-link flow.
async function handleLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return err("email and password required");

  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ? AND active = 1`).bind(email).first();
  if (!user || !user.password_hash) return err("invalid email or password", 401);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return err("invalid email or password", 401);

  if (user.shop_id) {
    const shop = await env.DB.prepare(`SELECT status, active FROM shops WHERE id = ?`).bind(user.shop_id).first();
    if (!shop.active) return err("this shop account has been disabled", 403);
    if (shop.status === "pending") return err("your shop account is still awaiting approval", 403);
    if (shop.status === "rejected") return err("invalid email or password", 401);
  }

  const token = await signToken(
    { userId: user.id, shopId: user.shop_id, role: user.role, exp: Date.now() + SESSION_MS },
    env.AUTH_SECRET
  );

  return json({ token, role: user.role, shopId: user.shop_id || null });
}

// Lets a logged-in user (via either login method) set/change their password.
async function handleSetPassword(request, env, auth) {
  const { password } = await request.json();
  if (!password || password.length < 8) return err("password must be at least 8 characters");
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, auth.userId).run();
  return json({ ok: true });
}

// Shop's own settings — the subset of the shops row a shop owner is allowed to see/edit.
// tracks_inventory is intentionally excluded from the update path: flipping it mid-life
// would leave stock_qty in an inconsistent state (NULL vs numeric) for existing products.
async function handleGetShopSettings(request, env, auth) {
  const shop = await env.DB.prepare(
    `SELECT id, name, legal_name, address, contact_number, footer_note, tracks_inventory, paper_width, tax_rate FROM shops WHERE id = ?`
  )
    .bind(auth.shopId)
    .first();
  if (!shop) return err("shop not found", 404);
  return json(shop);
}

async function handleUpdateShopSettings(request, env, auth) {
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  if (!shop) return err("shop not found", 404);
  const body = await request.json();

  const legal_name = body.legal_name ?? shop.legal_name;
  const address = body.address ?? shop.address;
  const contact_number = body.contact_number ?? shop.contact_number;
  const footer_note = body.footer_note ?? shop.footer_note;
  const paper_width = body.paper_width ?? shop.paper_width;
  const tax_rate = body.tax_rate ?? shop.tax_rate;

  await env.DB.prepare(
    `UPDATE shops SET legal_name = ?, address = ?, contact_number = ?, footer_note = ?, paper_width = ?, tax_rate = ? WHERE id = ?`
  )
    .bind(legal_name, address, contact_number, footer_note, paper_width, tax_rate, auth.shopId)
    .run();

  return json({ ok: true });
}

async function handleListShops(request, env, auth, url) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const status = url.searchParams.get("status");
  const { results } = status
    ? await env.DB.prepare(`SELECT * FROM shops WHERE status = ? ORDER BY created_at DESC`).bind(status).all()
    : await env.DB.prepare(`SELECT * FROM shops ORDER BY created_at DESC`).all();
  return json(results);
}

async function handleApproveShop(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(shopId).first();
  if (!shop) return err("shop not found", 404);

  await env.DB.prepare(`UPDATE shops SET status = 'active' WHERE id = ?`).bind(shopId).run();

  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE shop_id = ?`).bind(shopId).first();
  if (user) {
    await sendEmail(
      env,
      user.email,
      "Your POS account is approved",
      `<p>Your shop account is now active. Log in with the email and password you signed up with:</p><p><a href="${env.FRONTEND_URL}/index.html">${env.FRONTEND_URL}/index.html</a></p>`
    );
  }

  return json({ ok: true });
}

async function handleRejectShop(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  await env.DB.prepare(`UPDATE shops SET status = 'rejected' WHERE id = ?`).bind(shopId).run();
  return json({ ok: true });
}

// Disable/enable: keeps all data, just blocks login. Reversible.
async function handleDisableShop(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  await env.DB.prepare(`UPDATE shops SET active = 0 WHERE id = ?`).bind(shopId).run();
  return json({ ok: true });
}

async function handleEnableShop(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  await env.DB.prepare(`UPDATE shops SET active = 1 WHERE id = ?`).bind(shopId).run();
  return json({ ok: true });
}

// Delete: permanently removes the shop and everything under it (users, products,
// documents, document items, any pending reset tokens). Not reversible — this is
// what frees up an email address to sign up again from scratch. Take a backup first.
async function handleDeleteShop(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const shop = await env.DB.prepare(`SELECT id FROM shops WHERE id = ?`).bind(shopId).first();
  if (!shop) return err("shop not found", 404);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM document_items WHERE document_id IN (SELECT id FROM documents WHERE shop_id = ?)`).bind(shopId),
    env.DB.prepare(`DELETE FROM documents WHERE shop_id = ?`).bind(shopId),
    env.DB.prepare(`DELETE FROM products WHERE shop_id = ?`).bind(shopId),
    env.DB.prepare(`DELETE FROM item_groups WHERE shop_id = ?`).bind(shopId),
    env.DB.prepare(`DELETE FROM magic_links WHERE user_id IN (SELECT id FROM users WHERE shop_id = ?)`).bind(shopId),
    env.DB.prepare(`DELETE FROM users WHERE shop_id = ?`).bind(shopId),
    env.DB.prepare(`DELETE FROM shops WHERE id = ?`).bind(shopId),
  ]);

  return json({ ok: true });
}

// Admin-triggered "forgot password" on a shop's behalf — same reset-link flow, just
// initiated from the admin panel instead of the shop typing their own email in.
async function handleAdminResetPassword(request, env, auth, shopId) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE shop_id = ?`).bind(shopId).first();
  if (!user) return err("shop user not found", 404);
  await sendPasswordResetEmail(env, user);
  return json({ ok: true });
}

// Full data export as JSON — download, keep somewhere safe, feed back into /restore later.
async function handleBackup(request, env, auth) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const [shops, users, products, documents, documentItems, itemGroups] = await Promise.all([
    env.DB.prepare(`SELECT * FROM shops`).all(),
    env.DB.prepare(`SELECT * FROM users`).all(),
    env.DB.prepare(`SELECT * FROM products`).all(),
    env.DB.prepare(`SELECT * FROM documents`).all(),
    env.DB.prepare(`SELECT * FROM document_items`).all(),
    env.DB.prepare(`SELECT * FROM item_groups`).all(),
  ]);
  return json({
    version: 1,
    exported_at: new Date().toISOString(),
    shops: shops.results,
    users: users.results,
    products: products.results,
    documents: documents.results,
    document_items: documentItems.results,
    item_groups: itemGroups.results,
  });
}

// Wipes shops/users/products/documents/document_items and reinserts everything from
// a backup file, id-for-id. Runs as one D1 batch, which commits atomically — either
// the whole restore lands or none of it does. Does NOT touch magic_links (irrelevant
// after restore) — any in-flight reset links from before the restore are simply gone.
async function handleRestore(request, env, auth) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const body = await request.json();
  const { shops, users, products, documents, document_items, item_groups } = body;
  if (!Array.isArray(shops) || !Array.isArray(users)) return err("invalid backup file — missing shops/users arrays");

  const stmts = [
    env.DB.prepare(`DELETE FROM document_items`),
    env.DB.prepare(`DELETE FROM documents`),
    env.DB.prepare(`DELETE FROM products`),
    env.DB.prepare(`DELETE FROM item_groups`),
    env.DB.prepare(`DELETE FROM magic_links`),
    env.DB.prepare(`DELETE FROM users`),
    env.DB.prepare(`DELETE FROM shops`),
  ];

  for (const s of shops) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO shops (id, name, legal_name, address, contact_number, footer_note, tracks_inventory, paper_width, tax_rate, low_stock_threshold, next_doc_number, next_item_number, status, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(s.id, s.name, s.legal_name, s.address, s.contact_number, s.footer_note, s.tracks_inventory, s.paper_width, s.tax_rate, s.low_stock_threshold, s.next_doc_number, s.next_item_number ?? 1, s.status, s.active, s.created_at)
    );
  }
  for (const u of users) {
    stmts.push(
      env.DB.prepare(`INSERT INTO users (id, shop_id, email, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(u.id, u.shop_id, u.email, u.role, u.password_hash, u.active, u.created_at)
    );
  }
  for (const g of item_groups || []) {
    stmts.push(
      env.DB.prepare(`INSERT INTO item_groups (id, shop_id, name, created_at) VALUES (?, ?, ?, ?)`)
        .bind(g.id, g.shop_id, g.name, g.created_at)
    );
  }
  for (const p of products || []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO products (id, shop_id, item_code, name, unit_price, cost_price, stock_qty, low_stock_threshold, discount_pct, item_group, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(p.id, p.shop_id, p.item_code ?? String(p.id), p.name, p.unit_price, p.cost_price, p.stock_qty, p.low_stock_threshold ?? null, p.discount_pct ?? 0, p.item_group ?? null, p.active, p.created_at)
    );
  }
  for (const d of documents || []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO documents (id, shop_id, doc_type, doc_number, reference_doc_id, subtotal, discount_amount, tax_amount, total, received_amount, balance_due, print_count, created_at, created_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(d.id, d.shop_id, d.doc_type, d.doc_number, d.reference_doc_id, d.subtotal, d.discount_amount, d.tax_amount, d.total, d.received_amount ?? 0, d.balance_due ?? 0, d.print_count, d.created_at, d.created_by, d.note)
    );
  }
  for (const di of document_items || []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO document_items (id, document_id, product_id, name, qty, unit_price, cost_price, discount_amount, line_total, gp_amount, stock_effect)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(di.id, di.document_id, di.product_id, di.name, di.qty, di.unit_price, di.cost_price, di.discount_amount, di.line_total, di.gp_amount, di.stock_effect)
    );
  }

  await env.DB.batch(stmts);
  return json({
    ok: true,
    restored: { shops: shops.length, users: users.length, products: (products || []).length, documents: (documents || []).length, document_items: (document_items || []).length, item_groups: (item_groups || []).length },
  });
}

async function handleCreateShop(request, env, auth) {
  if (auth.role !== "super_admin") return err("forbidden", 403);
  const body = await request.json();
  const { name, legal_name, address, contact_number, footer_note, tracks_inventory, paper_width, tax_rate, low_stock_threshold, email, password } = body;
  if (!name || !email) return err("name and email required");
  if (!isValidEmail(email)) return err("a valid email address is required");
  if (!password || password.length < 8) return err("password must be at least 8 characters");

  const shop = await env.DB.prepare(
    `INSERT INTO shops (name, legal_name, address, contact_number, footer_note, tracks_inventory, paper_width, tax_rate, low_stock_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(
      name,
      legal_name || name,
      address || "",
      contact_number || "",
      footer_note || "",
      tracks_inventory ? 1 : 0,
      paper_width || 80,
      tax_rate || 0,
      low_stock_threshold ?? 5
    )
    .first();

  const passwordHash = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO users (shop_id, email, role, password_hash) VALUES (?, ?, 'shop', ?)`)
    .bind(shop.id, email, passwordHash)
    .run();

  return json({ shopId: shop.id });
}

// ---------- item groups (categories) ----------
// Categories are managed rows (add/rename/delete), not free text. products.item_group
// stores the group's *name* rather than its id, so nothing else in the schema needs to
// change — resolveItemGroup is the single place that enforces "a product's group must
// be a category that actually exists" (or null/none).
async function resolveItemGroup(db, shopId, item_group) {
  if (!item_group || !String(item_group).trim()) return null;
  const trimmed = String(item_group).trim();
  const group = await db.prepare(`SELECT name FROM item_groups WHERE shop_id = ? AND name = ?`).bind(shopId, trimmed).first();
  if (!group) {
    const e = new Error("unknown category — add it under Categories first");
    e.status = 400;
    throw e;
  }
  return group.name;
}

async function handleListItemGroups(request, env, auth) {
  const { results } = await env.DB.prepare(`SELECT id, name FROM item_groups WHERE shop_id = ? ORDER BY name COLLATE NOCASE`)
    .bind(auth.shopId)
    .all();
  return json(results);
}

async function handleCreateItemGroup(request, env, auth) {
  const { name } = await request.json();
  const trimmed = (name || "").trim();
  if (!trimmed) return err("name required");
  const existing = await env.DB.prepare(`SELECT id FROM item_groups WHERE shop_id = ? AND name = ?`).bind(auth.shopId, trimmed).first();
  if (existing) return err("a category with this name already exists", 409);
  const result = await env.DB.prepare(`INSERT INTO item_groups (shop_id, name) VALUES (?, ?) RETURNING id`).bind(auth.shopId, trimmed).first();
  return json({ id: result.id, name: trimmed });
}

// Renaming cascades: every product currently carrying the old name is updated to the
// new one in the same batch, so nothing silently falls back to "ungrouped".
async function handleUpdateItemGroup(request, env, auth, groupId) {
  const { name } = await request.json();
  const trimmed = (name || "").trim();
  if (!trimmed) return err("name required");

  const group = await env.DB.prepare(`SELECT * FROM item_groups WHERE id = ? AND shop_id = ?`).bind(groupId, auth.shopId).first();
  if (!group) return err("category not found", 404);

  if (trimmed !== group.name) {
    const clash = await env.DB.prepare(`SELECT id FROM item_groups WHERE shop_id = ? AND name = ? AND id != ?`).bind(auth.shopId, trimmed, groupId).first();
    if (clash) return err("a category with this name already exists", 409);
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE item_groups SET name = ? WHERE id = ?`).bind(trimmed, groupId),
    env.DB.prepare(`UPDATE products SET item_group = ? WHERE shop_id = ? AND item_group = ?`).bind(trimmed, auth.shopId, group.name),
  ]);

  return json({ ok: true });
}

// Deleting a category unassigns it from any product that had it (item_group -> NULL)
// rather than touching the product otherwise — same "additive, no data loss" spirit
// as the rest of this app's deletes.
async function handleDeleteItemGroup(request, env, auth, groupId) {
  const group = await env.DB.prepare(`SELECT * FROM item_groups WHERE id = ? AND shop_id = ?`).bind(groupId, auth.shopId).first();
  if (!group) return err("category not found", 404);

  await env.DB.batch([
    env.DB.prepare(`UPDATE products SET item_group = NULL WHERE shop_id = ? AND item_group = ?`).bind(auth.shopId, group.name),
    env.DB.prepare(`DELETE FROM item_groups WHERE id = ?`).bind(groupId),
  ]);

  return json({ ok: true });
}

async function handleCreateProduct(request, env, auth) {
  const shopId = auth.shopId;
  const body = await request.json();
  const { name, unit_price, cost_price, stock_qty, low_stock_threshold, discount_pct, item_group } = body;
  if (!name) return err("name required");

  const shop = await env.DB.prepare(`SELECT tracks_inventory FROM shops WHERE id = ?`).bind(shopId).first();
  const itemCode = await claimItemNumber(env.DB, shopId);
  const groupVal = await resolveItemGroup(env.DB, shopId, item_group);

  const result = await env.DB.prepare(
    `INSERT INTO products (shop_id, item_code, name, unit_price, cost_price, stock_qty, low_stock_threshold, discount_pct, item_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(shopId, itemCode, name, unit_price || 0, cost_price || 0, shop.tracks_inventory ? stock_qty || 0 : null, low_stock_threshold ?? null, discount_pct || 0, groupVal)
    .first();

  return json({ productId: result.id, itemCode });
}

async function handleUpdateProduct(request, env, auth, productId) {
  const shopId = auth.shopId;
  const body = await request.json();
  const { name, unit_price, cost_price, active, low_stock_threshold, discount_pct, item_group } = body;

  const product = await env.DB.prepare(`SELECT * FROM products WHERE id = ? AND shop_id = ?`).bind(productId, shopId).first();
  if (!product) return err("product not found", 404);

  const groupVal = item_group === undefined ? product.item_group : await resolveItemGroup(env.DB, shopId, item_group);

  await env.DB.prepare(
    `UPDATE products SET name = ?, unit_price = ?, cost_price = ?, active = ?, low_stock_threshold = ?, discount_pct = ?, item_group = ? WHERE id = ?`
  )
    .bind(
      name ?? product.name,
      unit_price ?? product.unit_price,
      cost_price ?? product.cost_price,
      active ?? product.active,
      low_stock_threshold === undefined ? product.low_stock_threshold : low_stock_threshold,
      discount_pct === undefined ? product.discount_pct : discount_pct,
      groupVal,
      productId
    )
    .run();

  return json({ ok: true });
}

async function handleListProducts(request, env, auth) {
  const { results } = await env.DB.prepare(`SELECT * FROM products WHERE shop_id = ? AND active = 1 ORDER BY name`)
    .bind(auth.shopId)
    .all();
  return json(results);
}

// Client requests reference products by id (e.g. sale/stock-in line items). Those ids
// must never be trusted blindly — without this check, one shop's logged-in user could
// pass another shop's product_id and silently corrupt that shop's stock_qty/cost_price
// (an IDOR). Every route that accepts a product_id from the request body calls this
// first and rejects the whole request if any id doesn't belong to the caller's shop.
async function loadOwnedProducts(db, shopId, productIds) {
  const ids = [...new Set(productIds.filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE shop_id = ? AND id IN (${placeholders})`)
    .bind(shopId, ...ids)
    .all();
  const map = new Map(results.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) {
    const e = new Error(`product not found: ${missing.join(", ")}`);
    e.status = 404;
    throw e;
  }
  return map;
}

async function handleStockIn(request, env, auth) {
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  if (!shop.tracks_inventory) return err("this shop is not in inventory mode");

  const body = await request.json();
  const items = body.items; // [{ product_id, qty, unit_cost }]
  if (!Array.isArray(items) || !items.length) return err("items required");
  if (items.some((it) => !it.product_id)) return err("product_id required for every stock-in line");

  const owned = await loadOwnedProducts(env.DB, auth.shopId, items.map((it) => it.product_id));

  const preparedItems = items.map((it) => ({
    product_id: it.product_id,
    name: it.name || owned.get(it.product_id).name,
    qty: it.qty,
    unit_price: 0,
    cost_price: it.unit_cost,
    discount_amount: 0,
    stock_effect: it.qty,
  }));

  const result = await postDocument(env.DB, {
    shopId: auth.shopId,
    docType: "STOCK_IN",
    items: preparedItems,
    createdBy: auth.userId,
    tracksInventory: true,
  });

  return json(result);
}

async function handleSale(request, env, auth) {
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  const body = await request.json();
  const items = body.items; // [{ product_id?, name, qty, unit_price, discount_amount }]
  if (!Array.isArray(items) || !items.length) return err("items required");

  const owned = await loadOwnedProducts(env.DB, auth.shopId, items.map((it) => it.product_id).filter(Boolean));

  const preparedItems = items.map((it) => {
    const product = it.product_id ? owned.get(it.product_id) : null;
    return {
      product_id: it.product_id || null,
      name: it.name,
      qty: it.qty,
      unit_price: it.unit_price,
      cost_price: product ? product.cost_price : 0,
      discount_amount: it.discount_amount || 0,
      stock_effect: shop.tracks_inventory && it.product_id ? -it.qty : 0,
    };
  });

  const result = await postDocument(env.DB, {
    shopId: auth.shopId,
    docType: "SALE",
    items: preparedItems,
    createdBy: auth.userId,
    tracksInventory: !!shop.tracks_inventory,
    taxRate: shop.tax_rate,
    receivedAmount: typeof body.received_amount === "number" ? body.received_amount : undefined,
  });

  return json(result);
}

// Void: post a REVERSAL with all amounts/stock effects negated from the original.
async function handleVoid(request, env, auth, docId) {
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  const original = await env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND shop_id = ?`).bind(docId, auth.shopId).first();
  if (!original) return err("document not found", 404);
  if (original.doc_type !== "SALE") return err("only SALE documents can be voided");

  const existingReversal = await env.DB.prepare(
    `SELECT id FROM documents WHERE reference_doc_id = ? AND doc_type = 'REVERSAL'`
  )
    .bind(docId)
    .first();
  if (existingReversal) return err("already voided", 409);

  const { results: origItems } = await env.DB.prepare(`SELECT * FROM document_items WHERE document_id = ?`).bind(docId).all();

  const reversedItems = origItems.map((it) => ({
    product_id: it.product_id,
    name: it.name,
    qty: -it.qty,
    unit_price: it.unit_price,
    cost_price: it.cost_price,
    discount_amount: -it.discount_amount,
    stock_effect: -it.stock_effect,
  }));

  const result = await postDocument(env.DB, {
    shopId: auth.shopId,
    docType: "REVERSAL",
    referenceDocId: docId,
    items: reversedItems,
    createdBy: auth.userId,
    tracksInventory: !!shop.tracks_inventory,
    // Reverse exactly what the original document recorded for tax, rather than
    // recomputing at the shop's *current* tax_rate — those could differ if the
    // rate was changed in Settings sometime between the sale and this void.
    taxAmountOverride: -(original.tax_amount || 0),
  });

  return json(result);
}

// Edit: void the original, then post a fresh SALE referencing it.
async function handleEditSale(request, env, auth, docId) {
  const voidResp = await handleVoid(request, env, auth, docId);
  if (voidResp.status !== 200) return voidResp;

  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  const body = await request.json();
  const items = body.items;
  if (!Array.isArray(items) || !items.length) return err("items required");

  const owned = await loadOwnedProducts(env.DB, auth.shopId, items.map((it) => it.product_id).filter(Boolean));

  const preparedItems = items.map((it) => {
    const product = it.product_id ? owned.get(it.product_id) : null;
    return {
      product_id: it.product_id || null,
      name: it.name,
      qty: it.qty,
      unit_price: it.unit_price,
      cost_price: product ? product.cost_price : 0,
      discount_amount: it.discount_amount || 0,
      stock_effect: shop.tracks_inventory && it.product_id ? -it.qty : 0,
    };
  });

  const result = await postDocument(env.DB, {
    shopId: auth.shopId,
    docType: "SALE",
    referenceDocId: docId,
    items: preparedItems,
    createdBy: auth.userId,
    tracksInventory: !!shop.tracks_inventory,
    taxRate: shop.tax_rate,
    note: "replaces document " + docId,
    receivedAmount: typeof body.received_amount === "number" ? body.received_amount : undefined,
  });

  return json(result);
}

async function handlePrint(request, env, auth, docId) {
  const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(auth.shopId).first();
  const doc = await env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND shop_id = ?`).bind(docId, auth.shopId).first();
  if (!doc) return err("document not found", 404);

  const { results: items } = await env.DB.prepare(
    `SELECT di.*, p.item_code AS item_code
     FROM document_items di LEFT JOIN products p ON p.id = di.product_id
     WHERE di.document_id = ?`
  )
    .bind(docId)
    .all();

  const reversal = await env.DB.prepare(
    `SELECT id FROM documents WHERE reference_doc_id = ? AND doc_type = 'REVERSAL'`
  )
    .bind(docId)
    .first();
  const rebill = await env.DB.prepare(
    `SELECT id FROM documents WHERE reference_doc_id = ? AND doc_type = 'SALE'`
  )
    .bind(docId)
    .first();

  let status = "ORIGINAL";
  if (reversal && rebill) status = "EDITED";
  else if (reversal) status = "CANCELLED";

  await env.DB.prepare(`UPDATE documents SET print_count = print_count + 1 WHERE id = ?`).bind(docId).run();

  return json({
    shop: { legal_name: shop.legal_name, address: shop.address, contact_number: shop.contact_number, footer_note: shop.footer_note, paper_width: shop.paper_width },
    doc,
    items,
    status,
    print_count: doc.print_count + 1,
    is_reprint: doc.print_count + 1 > 1,
  });
}

// Sales history list. Scoped to SALE/REVERSAL only (STOCK_IN doesn't belong on a
// sales screen). Status per doc mirrors the logic in handlePrint, computed in bulk
// here with two lookup sets instead of one query per row.
async function handleListDocuments(request, env, auth, url) {
  const from = url.searchParams.get("from") || "1970-01-01";
  const to = url.searchParams.get("to") || "2999-12-31";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const { results: docs } = await env.DB.prepare(
    `SELECT * FROM documents WHERE shop_id = ? AND doc_type IN ('SALE','REVERSAL') AND date(created_at) BETWEEN ? AND ?
     ORDER BY id DESC LIMIT ? OFFSET ?`
  )
    .bind(auth.shopId, from, to, limit, offset)
    .all();

  if (!docs.length) return json([]);

  const ids = docs.map((d) => d.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: related } = await env.DB.prepare(
    `SELECT doc_type, reference_doc_id FROM documents WHERE reference_doc_id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const reversedIds = new Set(related.filter((r) => r.doc_type === "REVERSAL").map((r) => r.reference_doc_id));
  const rebilledIds = new Set(related.filter((r) => r.doc_type === "SALE").map((r) => r.reference_doc_id));

  const withStatus = docs.map((d) => {
    let status = "ORIGINAL";
    if (reversedIds.has(d.id) && rebilledIds.has(d.id)) status = "EDITED";
    else if (reversedIds.has(d.id)) status = "CANCELLED";
    if (d.doc_type === "REVERSAL") status = "REVERSAL";
    return { ...d, status };
  });

  return json(withStatus);
}

// Single document + its items + status — used to prefill the edit screen and to
// render the print/receipt view outside of the print-and-increment-count flow.
async function handleGetDocument(request, env, auth, docId) {
  const doc = await env.DB.prepare(`SELECT * FROM documents WHERE id = ? AND shop_id = ?`).bind(docId, auth.shopId).first();
  if (!doc) return err("document not found", 404);
  const { results: items } = await env.DB.prepare(`SELECT * FROM document_items WHERE document_id = ?`).bind(docId).all();

  const reversal = await env.DB.prepare(`SELECT id FROM documents WHERE reference_doc_id = ? AND doc_type = 'REVERSAL'`).bind(docId).first();
  const rebill = await env.DB.prepare(`SELECT id FROM documents WHERE reference_doc_id = ? AND doc_type = 'SALE'`).bind(docId).first();

  let status = "ORIGINAL";
  if (reversal && rebill) status = "EDITED";
  else if (reversal) status = "CANCELLED";
  if (doc.doc_type === "REVERSAL") status = "REVERSAL";

  return json({ doc, items, status, reversal_id: reversal ? reversal.id : null, rebill_id: rebill ? rebill.id : null });
}

async function handleReports(request, env, auth, url) {
  const from = url.searchParams.get("from") || "1970-01-01";
  const to = url.searchParams.get("to") || "2999-12-31";

  const sales = await env.DB.prepare(
    `SELECT COALESCE(SUM(total),0) as revenue, COALESCE(SUM(discount_amount),0) as discounts, COUNT(*) as doc_count
     FROM documents WHERE shop_id = ? AND doc_type IN ('SALE','REVERSAL') AND date(created_at) BETWEEN ? AND ?`
  )
    .bind(auth.shopId, from, to)
    .first();

  const gp = await env.DB.prepare(
    `SELECT COALESCE(SUM(di.gp_amount),0) as gross_profit
     FROM document_items di JOIN documents d ON d.id = di.document_id
     WHERE d.shop_id = ? AND d.doc_type IN ('SALE','REVERSAL') AND date(d.created_at) BETWEEN ? AND ?`
  )
    .bind(auth.shopId, from, to)
    .first();

  const { results: topItems } = await env.DB.prepare(
    `SELECT di.name, SUM(di.qty) as qty_sold, SUM(di.line_total) as revenue, SUM(di.gp_amount) as gross_profit
     FROM document_items di JOIN documents d ON d.id = di.document_id
     WHERE d.shop_id = ? AND d.doc_type IN ('SALE','REVERSAL') AND date(d.created_at) BETWEEN ? AND ?
     GROUP BY di.name ORDER BY revenue DESC LIMIT 20`
  )
    .bind(auth.shopId, from, to)
    .all();

  const { results: stock } = await env.DB.prepare(
    `SELECT id, item_code, name, stock_qty, cost_price, unit_price, low_stock_threshold FROM products WHERE shop_id = ? AND active = 1 ORDER BY CAST(item_code AS INTEGER)`
  )
    .bind(auth.shopId)
    .all();

  return json({
    revenue: sales.revenue,
    discounts: sales.discounts,
    doc_count: sales.doc_count,
    gross_profit: gp.gross_profit,
    gp_margin_pct: sales.revenue ? (gp.gross_profit / sales.revenue) * 100 : 0,
    top_items: topItems,
    stock,
  });
}

// Item-wise (line-item) transaction report: every SALE/REVERSAL document_items row in
// range, each carrying its own sale amount (line_total), cost, and GP — as opposed to
// /api/reports which only returns items grouped/summed by name. Filterable by product
// and/or item_group, on top of the date range. REVERSAL rows carry negative qty/amounts
// (that's how voids are stored) so summing this list nets out correctly either way.
async function handleTransactionReport(request, env, auth, url) {
  const from = url.searchParams.get("from") || "1970-01-01";
  const to = url.searchParams.get("to") || "2999-12-31";
  const productId = url.searchParams.get("product_id");
  const group = url.searchParams.get("group");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1000);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const conditions = [`d.shop_id = ?`, `d.doc_type IN ('SALE','REVERSAL')`, `date(d.created_at) BETWEEN ? AND ?`];
  const params = [auth.shopId, from, to];

  if (productId) {
    conditions.push(`di.product_id = ?`);
    params.push(productId);
  }
  if (group) {
    conditions.push(`p.item_group = ?`);
    params.push(group);
  }

  params.push(limit, offset);

  const { results } = await env.DB.prepare(
    `SELECT di.id, d.id AS document_id, d.doc_number, d.created_at, d.doc_type,
            di.product_id, di.name, p.item_code, p.item_group,
            di.qty, di.unit_price, di.discount_amount, di.line_total, di.cost_price, di.gp_amount
     FROM document_items di
     JOIN documents d ON d.id = di.document_id
     LEFT JOIN products p ON p.id = di.product_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY d.id DESC, di.id ASC
     LIMIT ? OFFSET ?`
  )
    .bind(...params)
    .all();

  return json(results);
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    try {
      if (path === "/api/auth/login" && method === "POST") return await handleLogin(request, env);
      if (path === "/api/auth/forgot-password" && method === "POST") return await handleForgotPassword(request, env);
      if (path === "/api/auth/reset-password" && method === "POST") return await handleResetPassword(request, env);
      if (path === "/api/shops/signup" && method === "POST") return await handleShopSignup(request, env);

      // everything below requires auth
      const auth = await requireAuth(request, env);
      if (!auth) return err("unauthorized", 401);

      if (path === "/api/auth/set-password" && method === "POST") return await handleSetPassword(request, env, auth);

      if (path === "/api/shop/settings" && method === "GET") return await handleGetShopSettings(request, env, auth);
      if (path === "/api/shop/settings" && method === "PUT") return await handleUpdateShopSettings(request, env, auth);

      if (path === "/api/admin/shops" && method === "POST") return await handleCreateShop(request, env, auth);
      if (path === "/api/admin/shops" && method === "GET") return await handleListShops(request, env, auth, url);
      const approveMatch = path.match(/^\/api\/admin\/shops\/(\d+)\/approve$/);
      if (approveMatch && method === "POST") return await handleApproveShop(request, env, auth, approveMatch[1]);
      const rejectMatch = path.match(/^\/api\/admin\/shops\/(\d+)\/reject$/);
      if (rejectMatch && method === "POST") return await handleRejectShop(request, env, auth, rejectMatch[1]);
      const disableMatch = path.match(/^\/api\/admin\/shops\/(\d+)\/disable$/);
      if (disableMatch && method === "POST") return await handleDisableShop(request, env, auth, disableMatch[1]);
      const enableMatch = path.match(/^\/api\/admin\/shops\/(\d+)\/enable$/);
      if (enableMatch && method === "POST") return await handleEnableShop(request, env, auth, enableMatch[1]);
      const adminResetMatch = path.match(/^\/api\/admin\/shops\/(\d+)\/reset-password$/);
      if (adminResetMatch && method === "POST") return await handleAdminResetPassword(request, env, auth, adminResetMatch[1]);
      const deleteMatch = path.match(/^\/api\/admin\/shops\/(\d+)$/);
      if (deleteMatch && method === "DELETE") return await handleDeleteShop(request, env, auth, deleteMatch[1]);
      if (path === "/api/admin/backup" && method === "GET") return await handleBackup(request, env, auth);
      if (path === "/api/admin/restore" && method === "POST") return await handleRestore(request, env, auth);

      if (path === "/api/item-groups" && method === "GET") return await handleListItemGroups(request, env, auth);
      if (path === "/api/item-groups" && method === "POST") return await handleCreateItemGroup(request, env, auth);
      const groupMatch = path.match(/^\/api\/item-groups\/(\d+)$/);
      if (groupMatch && method === "PUT") return await handleUpdateItemGroup(request, env, auth, groupMatch[1]);
      if (groupMatch && method === "DELETE") return await handleDeleteItemGroup(request, env, auth, groupMatch[1]);

      if (path === "/api/products" && method === "POST") return await handleCreateProduct(request, env, auth);
      if (path === "/api/products" && method === "GET") return await handleListProducts(request, env, auth);
      const productMatch = path.match(/^\/api\/products\/(\d+)$/);
      if (productMatch && method === "PUT") return await handleUpdateProduct(request, env, auth, productMatch[1]);

      if (path === "/api/documents/stock-in" && method === "POST") return await handleStockIn(request, env, auth);
      if (path === "/api/documents/sale" && method === "POST") return await handleSale(request, env, auth);
      if (path === "/api/documents" && method === "GET") return await handleListDocuments(request, env, auth, url);

      const docGetMatch = path.match(/^\/api\/documents\/(\d+)$/);
      if (docGetMatch && method === "GET") return await handleGetDocument(request, env, auth, docGetMatch[1]);

      const voidMatch = path.match(/^\/api\/documents\/(\d+)\/void$/);
      if (voidMatch && method === "POST") return await handleVoid(request, env, auth, voidMatch[1]);

      const editMatch = path.match(/^\/api\/documents\/(\d+)\/edit$/);
      if (editMatch && method === "POST") return await handleEditSale(request, env, auth, editMatch[1]);

      const printMatch = path.match(/^\/api\/documents\/(\d+)\/print$/);
      if (printMatch && method === "GET") return await handlePrint(request, env, auth, printMatch[1]);

      if (path === "/api/reports" && method === "GET") return await handleReports(request, env, auth, url);
      if (path === "/api/reports/transactions" && method === "GET") return await handleTransactionReport(request, env, auth, url);

      return err("not found", 404);
    } catch (e) {
      return err(e.message || "server error", e.status || 500);
    }
  },
};
