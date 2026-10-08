Auto-approve control — visible ON/OFF on Admin → Pending
========================================================

1) D1: run migration-app-settings.sql (if not already)
2) Redeploy worker.js
3) Upload admin.html + style.css
4) Hard-refresh admin page (Ctrl+Shift+R)

Where to find it
----------------
Log in as super admin → open **Pending** tab.
Blue-bordered card at the top: "Auto-approve after 24 hours" with ON/OFF button.

If the hint says deploy/migration error, the API is missing — finish steps 1–2.
