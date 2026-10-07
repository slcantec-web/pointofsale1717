// Copies the web app (this repo's root files) into www/ for Capacitor.
// Skips server-only files and the service worker (the APK bundles its files locally).
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "www");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const skip = new Set(["service-worker.js", "auth-callback.html", "worker.js"]);
for (const f of fs.readdirSync(root)) {
  if (skip.has(f)) continue;
  const full = path.join(root, f);
  if (fs.statSync(full).isFile() && /\.(html|css|js|json)$/.test(f) && !/^migration-/.test(f) && !/^schema/.test(f)) {
    fs.copyFileSync(full, path.join(out, f));
  }
}
fs.cpSync(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });
console.log("www/ ready:", fs.readdirSync(out).join(", "));
