Document types across all transaction reports
=============================================

1) D1 Console — run migration-doc-types.sql
2) Redeploy Worker with worker.js
3) GitHub — overwrite dashboard.html + style.css
   (schema files optional, for docs/new installs)

What you get
------------
- doc_types table: Sale, Sale void, Stock in, Stock adjust, Stock in void
- Item-wise transactions report includes ALL types (not only sales)
- TYPE column + filter on Reports
- Stock ± column for stock movements
- History shows Type (Sale / Sale void)
- Audit log uses same labels
- Badges work on web + mobile

API
---
GET /api/doc-types
GET /api/reports/transactions?type=STOCK_ADJUST&from=&to=
