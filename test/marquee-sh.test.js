'use strict';
// marquee.sh, the Linux control script: it parses, and adds new settings to an existing .env the way
// marquee.ps1 does on Windows (without touching what's there, even with Windows line endings).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const run = (dir, ...args) => execFileSync('bash', [path.join(dir, 'marquee.sh'), ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('marquee.sh parses and shows its help', () => {
  execFileSync('bash', ['-n', path.join(ROOT, 'marquee.sh')]);
  assert.match(run(ROOT, 'help'), /marquee\.sh start/);
});

test('sync-env adds only the settings .env lacks, once, with their explanations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-sh-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'marquee.sh'), path.join(dir, 'marquee.sh'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
    // An older .env, written on Windows: CRLF, its own values, and a setting commented out.
    fs.writeFileSync(path.join(dir, '.env'), 'MOVIES_DIR=D:/Movies\r\nTV_DIR=E:/TV Shows\r\n#GPU=\r\n');
    const out = run(dir, 'sync-env');
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.ok(env.startsWith('MOVIES_DIR=D:/Movies\r\nTV_DIR=E:/TV Shows\r\n#GPU=\r\n'), 'what was there is untouched');
    assert.match(out, /YOUTUBE_DIR/);
    assert.doesNotMatch(out, /\bMOVIES_DIR\b|\bGPU\b/, 'settings already mentioned are not added');
    assert.match(env, /# Where downloaded YouTube videos are saved\nYOUTUBE_DIR=\.\/media\/youtube/);
    assert.equal(env.match(/^OPTIMIZED_DIR=/gm).length, 1);
    assert.match(run(dir, 'sync-env'), /already has every setting/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
