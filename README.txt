Non-inventory (billing-only) hardening
======================================
Overwrite: dashboard.html + style.css

When shop.tracks_inventory = 0:
- Stock tab hidden; cannot open stock panel
- No opening stock / min qty on add product
- Product list: Code | Name | Price | Cost
- Bill: no out-of-stock blocking, no stock meta
- Reports: no stock levels table; type filter only Sale / Sale void
- Item-wise: Stock ± column hidden
- Sales, void, print ORIGINAL/COPY, share, history all work
- Stock in / adjust APIs still reject non-inventory shops on server

No worker/D1 change required for this pass.
