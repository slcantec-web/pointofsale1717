Fix: data not loading after back Online
======================================
Overwrite:
  offline.js
  dashboard.html

What was wrong
--------------
Connection status flipped Online, but products/settings were never
re-fetched after a reconnect — the list stayed empty or stale.

Proper behaviour now
--------------------
1) Health probe confirms Online (needs 2 failures before Offline)
2) Successful API calls prove Online
3) When Offline → Online: automatically
   - flush queued sales/writes
   - reload shop settings, categories, products
   - refresh Bill pick list + Products list
4) SYNC button uses real probe (not only navigator.onLine)

Also redeploy worker.js if /api/health is not live yet.
Hard-refresh web app or rebuild APK.
