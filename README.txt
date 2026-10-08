Faster Online recovery
======================
Overwrite: offline.js

- Offline retries every 2 seconds (was 4s)
- Probe timeout ~1.8s while offline (was 5s + 5s sequential)
- CORS + no-cors probes run in parallel
- Browser "online" event → show Online immediately, then confirm
- Timer no longer resets on every failed probe (that was causing delay)

Hard-refresh or rebuild APK after upload.
