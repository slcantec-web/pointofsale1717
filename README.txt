1) Real Online/Offline detection
2) Auto-approve pending shops after 24h (admin toggle)
=====================================================

D1 Console — run migration-app-settings.sql

Redeploy worker.js

Upload:
  offline.js
  dashboard.html
  style.css
  admin.html

Online/Offline
--------------
- Probes GET /api/health every 12s (not only navigator.onLine)
- Failed API calls mark Offline; success marks Online
- Chip + red banner update correctly on mobile when data is off

Auto-approve
------------
- Admin → Pending tab → "Auto-approve after 24 hours" toggle
- Default OFF
- When ON: pending shops older than 24h become active (on list load + on login)
- Shop receives approval email
