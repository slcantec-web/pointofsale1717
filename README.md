# POS System — v1 backend

## What's here
- `schema.sql` — D1 schema (shops, users, products, documents, document_items)
- `worker.js` — single-file Worker: auth + shop admin + products + document posting (sale/void/edit/stock-in) + reports + print

## Deploy via dashboard (no CLI needed)

1. **Create the D1 database**
   Dashboard → Storage & Databases → D1 → Create database → name it e.g. `pos-db`.
   Open its Console tab, paste the contents of `schema-d1-console.sql` (comment-free — safer to paste than `schema.sql`, which can break if line breaks get flattened during copy), run it.

2. **Create the Worker**
   Dashboard → Workers & Pages → Create → Worker → paste the contents of `worker.js` into the editor → Deploy.

3. **Bind D1 to the Worker**
   Worker → Settings → Bindings → Add → D1 Database → variable name `DB` → select `pos-db`.

4. **Add environment variables**
   Worker → Settings → Variables → Add each of these (mark secrets as **Encrypt**):
   - `AUTH_SECRET` — long random string, used to sign session tokens
   - `WORKER_URL` — this Worker's own URL (e.g. `https://pos-api.slcantec.workers.dev`), used to build the link inside the login email
   - `FRONTEND_URL` — the Pages app URL (e.g. `https://pos.pages.dev`), used to redirect back into the app after the link is clicked
   - `EMAIL_PROVIDER` — `resend` (default if unset) or `gmail`

   **If `EMAIL_PROVIDER` is `resend` or unset:**
   - `RESEND_API_KEY` (encrypt) — your Resend API key
   - `FROM_EMAIL` — until a domain is verified in Resend, use `onboarding@resend.dev` (only delivers to your own Resend account email — fine for testing the flow yourself). Swap to `login@yourdomain` once a domain is available and verified.

   **If `EMAIL_PROVIDER` is `gmail`:**
   - `GMAIL_USER` (encrypt) — your full Gmail address, this is also the "from" address
   - `GMAIL_APP_PASSWORD` (encrypt) — a Gmail App Password, *not* your normal password. Requires 2-Step Verification enabled on the account first: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → generate one for "Mail"
   - No domain, no DNS records — this authenticates as your actual Gmail mailbox over SMTP (via `cloudflare:sockets`) rather than verifying a sending domain. Good for getting real emails to real people right now; keep in mind Gmail's own daily sending caps apply (fine at small-shop volume), and it's simpler than Resend but less battle-tested for deliverability at scale — worth revisiting once a domain is available.

5. **Create the first super admin**
   No signup route on purpose — super admin isn't self-serve. Run once in the D1 Console:
   ```sql
   INSERT INTO users (shop_id, email, role) VALUES (NULL, 'you@yourdomain.com', 'super_admin');
   ```
   Then use `/api/auth/request-link` with that email to log in — same flow every shop uses.

## Login flow

Password only — there is no login-by-email-link anymore (it was removed after running into a real-world failure mode: some email providers/security scanners auto-visit links in incoming mail, which silently burned the one-time login token before the actual person clicked it, making the link "expired" on arrival).

- New self-serve signups set a password at signup (`POST /api/shops/signup`).
- `POST /api/auth/login` with `{email, password}` returns `{token, role, shopId}` directly.
- Logged-in users can change their password any time via `POST /api/auth/set-password`.
- **Forgot password:** `POST /api/auth/forgot-password {email}` emails a reset link (valid 30 min, single use) to `{FRONTEND_URL}/reset-password.html?token=...`. Loading that page does *nothing* to the token — it's only consumed when the person actually submits the new-password form (`POST /api/auth/reset-password {token, password}`). That's the fix for the auto-visit problem above: a GET to load a static page is harmless even if a scanner does it; only a real form submission can burn the token.
- Admins can trigger the same reset-link flow on a shop's behalf from the admin panel ("RESET PW" per shop), for when a shop can't get into their own email-forgot-password loop.

The 30-day session (rather than re-typing every login) matters for a POS specifically — a shop clerk shouldn't need to fuss with credentials mid-shift to open the till.

**Migrating an already-deployed database:** the `users` table needs a `password_hash` column. Run `migration-add-password.sql` once in the D1 Console if you haven't already — a single additive `ALTER TABLE`, safe on a table that already has rows.

**Per-product default discount % + per-line bill discounts (this pass):** `products.discount_pct` is a per-item default discount percentage (0–100). When a shop adds that product to a bill, the cart line auto-fills its discount amount from this %; the clerk can still override it manually per line, which stops the auto-fill from recalculating that line if qty/price changes afterward. The backend already supported a per-line `discount_amount` on sale documents — this just exposes it in the UI (product settings for the default, plus an editable discount field on every cart row). If you already have a deployed database, run `migration-add-discount-pct.sql` once in the D1 Console (a single additive `ALTER TABLE`, defaults existing products to 0% — no behavior change until you set one).

**Managed categories + item-wise transaction report (this pass):** categories are now a real, managed list — add/rename/delete them from a "Categories" panel at the top of the PRODUCTS tab (`item_groups` table, one row per shop). Renaming a category cascades to every product that had it; deleting one clears those products back to uncategorized rather than touching anything else about them. Products pick a category from a dropdown (populated from that list) instead of free-typing one, so there's no risk of near-duplicate names. Categories show up in three places: (1) the PRODUCTS add/edit form's CATEGORY dropdown, (2) quick-filter chips above the BILL pick list (tap one to narrow the list; the search box also matches category names), (3) a filter on the REPORTS transaction table. Also new: `GET /api/reports/transactions`, which returns every SALE/REVERSAL line item individually (not summed like `/api/reports`'s "top items") — each row has its own qty, unit price, discount, sale amount, cost and GP, filterable by `from`/`to`, `product_id`, and `group`. Shown in REPORTS under "Item-wise transactions". New endpoints: `GET/POST /api/item-groups`, `PUT/DELETE /api/item-groups/:id`.

If you already have a deployed database: run `migration-add-item-group.sql` first if you haven't (adds `products.item_group`), then `migration-add-item-groups-table.sql` (adds the `item_groups` table itself and backfills one category per distinct name already in use, so nothing you'd previously typed disappears).

**Item codes + per-item minimum stock (this pass):** `products.item_code` is a system-assigned, sequential-per-shop number (same atomic-counter pattern as `documents.doc_number`, via a new `shops.next_item_number` column) — not user-editable, so it stays a clean cumulative sequence you can later hang a barcode off of. The minimum-stock-qty setting moved from the shop header (`shops.low_stock_threshold`) down to each product (`products.low_stock_threshold`), since "low stock" is inherently a per-item thing. If you already have a deployed database, run `migration-add-item-code-and-min-qty.sql` once in the D1 Console — it adds the new columns, backfills `item_code` for existing products (numbered in creation order, per shop), and advances each shop's counter past whatever it just backfilled. `shops.low_stock_threshold` is left in the table unused rather than dropped (additive migrations are safer on a live table than column drops).

**Tax was never actually applied to posted sales (bug fix, this pass):** `postDocument` previously hardcoded every document's `tax_amount` to `0` and never added tax into `total`, regardless of the shop's `tax_rate` — the BILL screen's tax preview was cosmetic only and never reached the database. Sales now compute `tax_amount = (subtotal - discount) * shop.tax_rate` at posting time and fold it into `total`, so it's stored correctly and shows up on the receipt, in HISTORY, and in REPORTS revenue. Voiding a sale reverses the *exact* `tax_amount` the original document recorded (not a fresh calculation at the shop's current rate), so a later tax-rate change in Settings can't throw off an old void. No migration needed — this only changes how new documents are posted going forward; past documents keep whatever they were stored with.

**Received amount + balance due (this pass):** the BILL screen now has a RECEIVED field (auto-filled with the total, editable) and shows the resulting BALANCE DUE / CHANGE live as the clerk types. Posting a sale is rejected — both client-side and server-side in `postDocument` — if the received amount is less than the total due, so a shortfall can't be recorded by mistake. `received_amount` and `balance_due` are now columns on `documents` (SALE only; 0 for other doc types) and are stored, returned from every document endpoint, and printed on the receipt as "Received" and "Balance due"/"Change". Editing a sale prefills RECEIVED from the original document. If you already have a deployed database, run `migration-add-received-amount.sql` once in the D1 Console (adds both columns, backfills existing SALE rows to `received_amount = total` / `balance_due = 0`).

## API quick reference

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/login` | POST | — | `{email, password}` → `{token, role, shopId}` directly (401 if no password set or wrong password) |
| `/api/auth/forgot-password` | POST | — | `{email}` → emails a reset link if the account exists, always returns `{ok:true}` |
| `/api/auth/reset-password` | POST | — | `{token, password}` → sets a new password (token from the emailed reset link) |
| `/api/auth/set-password` | POST | any logged-in user | `{password}` (min 8 chars) → sets/changes the caller's own password |
| `/api/shop/settings` | GET | shop | returns the caller's own shop row (name, legal_name, address, contact_number, footer_note, tracks_inventory, paper_width, tax_rate, low_stock_threshold) |
| `/api/shop/settings` | PUT | shop | updates the editable subset of the above (not `tracks_inventory`, not `name`) |
| `/api/shops/signup` | POST | — | public self-serve signup: `{name, email, password, ...}` → shop created with `status='pending'` |
| `/api/admin/shops` | POST | super_admin | create a shop directly, immediately `active` (`{..., email, password}` — password required) |
| `/api/admin/shops?status=pending` | GET | super_admin | list shops, optionally filtered by status |
| `/api/admin/shops/:id/approve` | POST | super_admin | activates a pending shop, emails the owner to log in |
| `/api/admin/shops/:id/reject` | POST | super_admin | marks a shop rejected — login blocked |
| `/api/admin/shops/:id/disable` | POST | super_admin | blocks login, keeps all data — reversible |
| `/api/admin/shops/:id/enable` | POST | super_admin | reverses `disable` |
| `/api/admin/shops/:id/reset-password` | POST | super_admin | emails that shop's user a password reset link |
| `/api/admin/shops/:id` | DELETE | super_admin | **permanently** deletes the shop and everything under it (users, products, sales history) — frees the email to sign up again. Not reversible. |
| `/api/admin/backup` | GET | super_admin | full JSON export of shops/users/products/documents/document_items |
| `/api/admin/restore` | POST | super_admin | wipes and reloads all data from a backup JSON body, atomically |
| `/api/products` | GET/POST | shop | list / create products — `item_code` is assigned automatically on create, not accepted in the body; POST accepts `{name, unit_price, cost_price, stock_qty, low_stock_threshold, discount_pct, item_group}` — `item_group` must be an existing category's name (or omitted/null) |
| `/api/products/:id` | PUT | shop | edit product (name, prices, `low_stock_threshold`, `discount_pct`, `item_group`) — `item_code` can't be changed |
| `/api/item-groups` | GET/POST | shop | list categories `{id, name}` / create one `{name}` (409 if that name already exists for the shop) |
| `/api/item-groups/:id` | PUT | shop | rename a category — cascades to every product currently carrying the old name |
| `/api/item-groups/:id` | DELETE | shop | delete a category — any product using it becomes uncategorized, nothing else about it changes |
| `/api/documents` | GET | shop | sales history: `?from=&to=&limit=&offset=`, SALE/REVERSAL only, each row includes a computed `status` (ORIGINAL / CANCELLED / EDITED / REVERSAL) |
| `/api/documents/:id` | GET | shop | single document + items + computed `status`, plus `reversal_id`/`rebill_id` — used to prefill the edit screen |
| `/api/documents/stock-in` | POST | shop | goods receipt, updates weighted-avg cost |
| `/api/documents/sale` | POST | shop | post a sale — `{items, received_amount}`; rejected (400) if `received_amount` is less than the computed total |
| `/api/documents/:id/void` | POST | shop | reverse a sale |
| `/api/documents/:id/edit` | POST | shop | void + repost corrected sale — same `{items, received_amount}` body as posting a sale |
| `/api/documents/:id/print` | GET | shop | receipt data + status (Original/Cancelled/Edited) + increments print_count |
| `/api/reports?from=&to=` | GET | shop | revenue, GP, GP margin, top items (summed by name), stock levels |
| `/api/reports/transactions?from=&to=&product_id=&group=` | GET | shop | line-item-wise transaction list — every sale/void line individually, each with its own qty, unit price, discount, sale amount, cost and GP |

All requests except login need `Authorization: Bearer <token>`.

## Frontend (frontend/)
- `frontend/index.html` — login (email + password)
- `frontend/signup.html` — self-serve shop signup, sets a password, lands as pending
- `frontend/forgot-password.html` — request a password reset link
- `frontend/reset-password.html` — set a new password from the emailed reset link
- `frontend/admin.html` — super admin: pending approvals, per-shop disable/enable/reset-password/delete, backup/restore
- `frontend/dashboard.html` — shop dashboard: BILL (cart + per-line discount, auto-filled from each product's default discount % but editable + checkout + print, with a quick VOID LAST SALE right after posting; product pick list has category filter chips and search-by-category), PRODUCTS (a "Categories" panel to add/rename/delete categories, plus add/edit/deactivate/stock-in for products — item codes are system-assigned and shown but not editable; minimum stock qty, default discount % and category are set per product), HISTORY (sales list, searchable by doc # and date range, with void/edit/print), REPORTS (revenue/GP/top items/stock with per-item low-stock highlighting, plus an item-wise transaction table filterable by item/category showing every sale line's own cost and GP), SETTINGS (shop details + set password). Editing a sale prefills the BILL cart from the original document (including its original discounts) and posts to `/api/documents/:id/edit` instead of `/api/documents/sale`.
- `frontend/style.css` — shared "receipt" design system (see design notes below)
- `frontend/app.js` — API base URL, fetch helper, token storage, service worker registration
- `frontend/manifest.json`, `frontend/service-worker.js` — PWA install + offline app-shell caching

`frontend/auth-callback.html` is no longer used (it existed for the old magic-link redirect flow) — safe to delete, or leave in place, it's just dead weight.

**Before deploying**: open `frontend/app.js` and set `API_BASE` to your actual deployed Worker URL.

Still needed: the icon PNGs referenced in the manifest (192/512/512-maskable). Also worth revisiting later: an offline queue/sync for bills taken while offline (the service worker already exposes a `sync-bills` hook for this, unused for now).

### Mobile layout fix (this pass)
`admin.html`'s header button cluster (`.dash-top-right`: pending count, backup, restore, set password, log out) was a single-line flex row with no wrap, so on phone-width screens it overflowed the viewport and forced horizontal scrolling. Fixed in `style.css`:
- `.dash-top-right` now wraps and right-aligns.
- `html, body { overflow-x: hidden; }` added as a safety net.
- A `max-width: 560px` rule shrinks the header buttons and stacks them full-width; a `max-width: 400px` rule tightens the `.receipt` card's own padding for very narrow phones.
- `signup.html`'s inventory toggle buttons (`.toggle-row .btn`) were fighting each other for `width: 100%` inside a flex row; they now use `flex: 1 1 140px` and wrap.

This affects every page sharing `style.css` (login, signup, admin, and the new dashboard), not just admin.

## What's intentionally not in v1 yet
- Frontend (Pages) — billing screen, product management UI, dashboard, print template
- Offline queue/sync
- Same-day edit/void restriction (currently unrestricted — flag if you want a cutoff)

## Known limitations to be aware of
`DELETE /api/admin/shops/:id` and `POST /api/admin/restore` are both irreversible and both wipe real data — there's no soft-delete or undo. Take a backup (`GET /api/admin/backup`, or the BACKUP button in the admin panel) before either one if the data matters. `restore` replaces the *entire* database contents, not just one shop.

Weighted-average cost recalculation on stock-in reads the product's current qty/cost, then writes — there's a small race window if two stock-in requests for the *same product* land at the exact same moment. Not a concern for typical single-terminal small-shop usage; if it ever matters, the fix is a Durable Object per shop to fully serialize writes.

The Gmail SMTP path (`EMAIL_PROVIDER=gmail`) is a hand-written minimal SMTP client — it covers the plain send/auth flow needed here but has no retry logic and hasn't been battle-tested at volume. If email ever becomes business-critical at scale, Resend (or a verified-domain provider generally) is the more robust long-term choice.

## Email OTP + offline Android app (this pass)
- **Signup** now verifies the email with a 6-digit code (`POST /api/shops/signup/request-otp {email}`, then `POST /api/shops/signup` with `otp`). **Forgot password** uses the same kind of code (`POST /api/auth/forgot-password`, then `POST /api/auth/reset-password {email, code, password}`). Codes go through the existing `sendEmail()` gateway, are stored hashed in `otp_codes`, expire in 10 minutes, allow 5 attempts, and are limited to 5 per hour per email. The admin RESET PW button still sends the old link (`{token, password}` still accepted).
- **Offline sales:** `offline.js` caches products/categories/settings and queues sales made offline in IndexedDB; they post automatically when back online. `POST /api/documents/sale` accepts `client_ref` (idempotency key, stops duplicates on retry) and `created_at` (original sale time).
- **Run once in the D1 Console:** `migration-add-otp-and-client-ref.sql`. Deploy the Worker **before** the Pages site picks up the new signup page.
- **Android APK:** see `BUILD-APK.md` (`android-app/` is a Capacitor wrapper; GitHub Actions builds the debug APK).
