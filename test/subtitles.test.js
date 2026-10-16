'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { srtToVtt, shiftVtt } = require('../lib/subtitles');

const SRT = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello\r\n\r\n2\r\n00:01:05,250 --> 00:01:07,000\r\n<i>World</i>\r\n';

test('srtToVtt converts header, BOM, CRLF and comma timestamps', () => {
  const vtt = srtToVtt(SRT);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.500\nHello/);
  assert.match(vtt, /00:01:05\.250 --> 00:01:07\.000/);
  assert.ok(!vtt.includes('\r'));
});

test('shiftVtt moves cues earlier and drops cues that already ended', () => {
  const out = shiftVtt(srtToVtt(SRT), 60);
  assert.ok(!out.includes('Hello'));
  assert.match(out, /00:00:05\.250 --> 00:00:07\.000\n<i>World<\/i>/);
});

test('shiftVtt clamps a cue that straddles the offset and keeps settings', () => {
  const out = shiftVtt('WEBVTT\n\n00:09.000 --> 00:12.000 align:start\nHi\n', 10);
  assert.match(out, /00:00:00\.000 --> 00:00:02\.000 align:start\nHi/);
});
