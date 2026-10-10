// Run in CI after `npx cap add android`.
// Sets versionName/versionCode from the release tag and wires up release signing.
//   VERSION_NAME   e.g. 1.0.1
//   KEYSTORE_PATH, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD
const fs = require("fs");
const path = require("path");

const gradlePath = path.join(__dirname, "android", "app", "build.gradle");
let g = fs.readFileSync(gradlePath, "utf8");

const name = process.env.VERSION_NAME;
if (!/^\d+\.\d+\.\d+$/.test(name || "")) throw new Error("VERSION_NAME must look like 1.2.3, got: " + name);
const [maj, min, pat] = name.split(".").map(Number);
const code = maj * 10000 + min * 100 + pat; // always increases with the version

g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`);
g = g.replace(/versionName\s+"[^"]*"/, `versionName "${name}"`);

if (!g.includes("signingConfigs.release")) {
  const signing = `
    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_PATH"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
`;
  if (!/\n\s*buildTypes\s*\{/.test(g)) throw new Error("buildTypes block not found in build.gradle");
  g = g.replace(/\n(\s*)buildTypes\s*\{/, `${signing}\n$1buildTypes {`);
  const bt = g.indexOf("buildTypes");
  const head = g.slice(0, bt);
  const tail = g.slice(bt).replace(/(release\s*\{)/, `$1\n            signingConfig signingConfigs.release`);
  g = head + tail;
}

fs.writeFileSync(gradlePath, g);
console.log(`Patched build.gradle: versionName ${name}, versionCode ${code}, release signing on`);
