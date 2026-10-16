'use strict';
// Subtitle conversion (SRT -> WebVTT) and time-shifting for transcoded streams that start mid-file.

function srtToVtt(srt) {
  const body = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}

const TS = /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})/;
function parseTs(s) {
  const m = TS.exec(s);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000) : null;
}
function fmtTs(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// Shift every cue back by `offset` seconds, dropping cues that end before zero.
function shiftVtt(vtt, offset) {
  if (!offset) return vtt;
  const blocks = vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) { out.push(block); continue; }
    const [a, rest] = lines[i].split('-->');
    const [b, ...settings] = rest.trim().split(/\s+/);
    const start = parseTs(a), end = parseTs(b);
    if (start === null || end === null || end - offset <= 0) continue;
    lines[i] = `${fmtTs(Math.max(0, start - offset))} --> ${fmtTs(end - offset)}${settings.length ? ' ' + settings.join(' ') : ''}`;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n') + '\n';
}

const LANGS = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  ru: 'Russian', rus: 'Russian', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', sv: 'Swedish', swe: 'Swedish',
  pl: 'Polish', pol: 'Polish', ar: 'Arabic', ara: 'Arabic', hi: 'Hindi', hin: 'Hindi', tr: 'Turkish', tur: 'Turkish',
};
const langName = (code) => (code ? LANGS[code.toLowerCase()] || code : null);

module.exports = { srtToVtt, shiftVtt, langName };
