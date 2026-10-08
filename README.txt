Fix: stuck Offline after connection returns
==========================================
Overwrite: offline.js

Changes
-------
- While Offline, probe every 4 seconds (was 12s)
- Any response from the server = Online (not only HTTP 200)
- Fallback no-cors probe if CORS health fails
- Tap the Online/Offline chip to force recheck
- Flush no longer blocked by a sticky navigator.onLine=false

Hard-refresh or rebuild APK after upload.
Ensure worker.js with /api/health is deployed.
