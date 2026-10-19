'use strict';
// Copies a built app into the server's downloads and records its version in apps.json, which the
// apps read to offer updates (Account → Check for updates). Used by build.sh and ../androidtv/build.sh.
// node publish.js <key> <apk> <versionCode> <versionName>
const fs = require('node:fs');
const path = require('node:path');

const [key, apk, code, name] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'public', 'downloads');
const file = path.basename(apk);
fs.copyFileSync(apk, path.join(dir, file));
const index = path.join(dir, 'apps.json');
let apps = {};
try { apps = JSON.parse(fs.readFileSync(index, 'utf8')); } catch { /* first one */ }
apps[key] = { versionCode: Number(code), versionName: name, file };
fs.writeFileSync(index, `${JSON.stringify(apps, null, 2)}\n`);
console.log(`Published ${file} ${name} (${code}) to public/downloads`);
