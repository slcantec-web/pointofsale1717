Stock adjust cost + mobile receipt preview
==========================================

Upload / overwrite:
  dashboard.html
  style.css
  worker.js   ← redeploy Cloudflare Worker

1) Stock Adjust cost
   - No manual unit cost field
   - Shows "AVG COST (auto)" from product moving average
   - Server ignores client cost; qty-only change; moving average unchanged
   - Stock In still asks for unit cost (updates moving average)

2) Mobile print / slip preview
   - PRINT opens an on-screen receipt preview sheet
   - CLOSE to dismiss
   - PRINT on the bar tries the system print dialog
   - Works when window.print() is blocked in phone browsers / PWA

Hard-refresh the app after deploy (or clear site data) so the new UI loads.
