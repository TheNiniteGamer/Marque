'use strict';
// The Android apps update themselves from /downloads/apps.json: it must describe the files there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('apps.json lists the Android apps in the downloads folder with their versions', () => {
  const dir = path.join(__dirname, '..', 'public', 'downloads');
  const apps = JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8'));
  for (const key of ['android', 'androidtv']) {
    const a = apps[key];
    assert.ok(a, key);
    assert.ok(Number.isInteger(a.versionCode) && a.versionCode > 0, `${key} versionCode`);
    assert.match(a.versionName, /^\d+\.\d+\.\d+$/);
    assert.ok(fs.statSync(path.join(dir, a.file)).size > 10000, `${key}: ${a.file} is there`);
    // The build scripts' versions match what's published.
    const script = fs.readFileSync(path.join(__dirname, '..', key === 'android' ? 'android' : 'androidtv', 'build.sh'), 'utf8');
    assert.equal(Number(/VERSION_CODE:-(\d+)/.exec(script)[1]), a.versionCode, `${key} build.sh and apps.json agree`);
  }
});
