'use strict';
// Minimal streaming .tar.gz (POSIX ustar) writer and reader, enough for Marquee's backup files.
// Archives open in any standard tool (7-Zip, Windows 11 Explorer, `tar -xzf`).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough, Writable, pipeline } = require('node:stream');

const BLOCK = 512;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name, size, mtime) {
  const h = Buffer.alloc(BLOCK);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar splits long names into prefix (<=155) + name (<=100) at a slash.
    const i = name.lastIndexOf('/', 155);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 100) throw new Error(`Path too long for the backup: ${name}`);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii');
  h.fill(' ', 148, 156); // checksum is computed with this field as spaces
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/**
 * Writes entries to a gzip stream. entries: [{ name, data: Buffer }] or [{ name, file: '/path' }].
 * Returns the readable .tar.gz stream.
 */
function createTarGz(entries) {
  const tar = new PassThrough();
  const gz = zlib.createGzip({ level: 6 });
  (async () => {
    try {
      for (const e of entries) {
        let size, mtime, source;
        if (e.data) { size = e.data.length; mtime = Date.now(); source = e.data; }
        else {
          let st;
          try { st = fs.statSync(e.file); } catch { continue; } // file vanished: skip it
          size = st.size; mtime = st.mtimeMs; source = e.file;
        }
        await write(tar, header(e.name, size, mtime));
        if (Buffer.isBuffer(source)) await write(tar, source);
        else await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(source);
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(tar, { end: false });
        });
        const pad = (BLOCK - (size % BLOCK)) % BLOCK;
        if (pad) await write(tar, Buffer.alloc(pad));
      }
      await write(tar, Buffer.alloc(BLOCK * 2));
      tar.end();
    } catch (err) {
      tar.destroy(err);
    }
  })();
  return pipeline(tar, gz, () => {});
}

function write(stream, buf) {
  return new Promise((resolve) => { if (stream.write(buf)) resolve(); else stream.once('drain', resolve); });
}

// Only plain relative paths are allowed out of an archive.
function safeName(name) {
  const n = name.replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((p) => p === '..')) return null;
  return n;
}

/**
 * Extracts a .tar.gz stream into `dest`. Only regular files are written; anything trying to escape
 * `dest` makes the whole extraction fail. Resolves to the list of extracted names.
 */
function extractTarGz(input, dest, { maxBytes = 4 * 1024 ** 3 } = {}) {
  return new Promise((resolve, reject) => {
    const names = [];
    let buf = Buffer.alloc(0);
    let current = null; // { remaining, pad, fd }
    let total = 0;
    let ended = false;
    const fail = (err) => { if (current?.fd != null) fs.closeSync(current.fd); reject(err); };

    const sink = new Writable({
      write(chunk, enc, cb) {
        try {
          total += chunk.length;
          if (total > maxBytes) throw new Error('Backup is too large');
          buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
          for (;;) {
            if (current) {
              if (current.remaining > 0) {
                const n = Math.min(current.remaining, buf.length);
                if (!n) break;
                if (current.fd != null) fs.writeSync(current.fd, buf, 0, n);
                current.remaining -= n;
                buf = buf.subarray(n);
                if (current.remaining > 0) break;
              }
              if (buf.length < current.pad) break;
              buf = buf.subarray(current.pad);
              if (current.fd != null) fs.closeSync(current.fd);
              current = null;
              continue;
            }
            if (ended || buf.length < BLOCK) break;
            const h = buf.subarray(0, BLOCK);
            buf = buf.subarray(BLOCK);
            if (h.every((b) => b === 0)) { ended = true; break; }
            let sum = 0;
            for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
            const stored = parseInt(h.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);
            if (sum !== stored) throw new Error('This is not a valid Marquee backup (bad archive header)');
            const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
            const prefix = str(345, 500);
            const rawName = (prefix ? `${prefix}/` : '') + str(0, 100);
            const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
            const type = String.fromCharCode(h[156] || 48);
            let fd = null;
            if (type === '0') {
              const name = safeName(rawName);
              if (!name) throw new Error(`Unsafe path in backup: ${rawName}`);
              const out = path.join(dest, name);
              if (!out.startsWith(path.resolve(dest) + path.sep)) throw new Error(`Unsafe path in backup: ${rawName}`);
              fs.mkdirSync(path.dirname(out), { recursive: true });
              fd = fs.openSync(out, 'w');
              names.push(name);
            } else if (!['5', 'x', 'g'].includes(type)) {
              throw new Error(`Unsupported entry in backup: ${rawName}`);
            }
            current = { remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, fd };
          }
          cb();
        } catch (err) { cb(err); }
      },
    });
    pipeline(input, zlib.createGunzip(), sink, (err) => {
      if (err) return fail(err.code === 'Z_DATA_ERROR' || err.code === 'Z_BUF_ERROR' ? new Error('This is not a valid Marquee backup (not a .tar.gz file)') : err);
      if (current?.fd != null) { fs.closeSync(current.fd); return reject(new Error('The backup file is incomplete')); }
      resolve(names);
    });
  });
}

module.exports = { createTarGz, extractTarGz, safeName };
