// SPDX-License-Identifier: SUL-1.0
// Standalone share personalization tests. Pure module: no filesystem, no
// network, no fixtures, no provider or project data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_SLOGANS, SHARE_NUMBER_STYLES, SHARE_ORNAMENTS, SHARE_TEXT_LIMITS,
  normalizeShareStyle,
} from '../src/share-style.mjs';

test('preset tables expose the exact accepted identifiers', () => {
  assert.deepEqual(SHARE_SLOGANS.map(s => s.id), ['together', 'room', 'small', 'company']);
  assert.deepEqual(SHARE_NUMBER_STYLES, [
    { id: 'soft', name: { zh: '柔和', en: 'Soft' } },
    { id: 'book', name: { zh: '书页', en: 'Book' } },
    { id: 'mono', name: { zh: '等宽', en: 'Mono' } },
  ]);
  assert.deepEqual(SHARE_ORNAMENTS, [
    { id: 'thread', name: { zh: '绕线', en: 'Thread' } },
    { id: 'bloom', name: { zh: '小花', en: 'Bloom' } },
    { id: 'none', name: { zh: '留白', en: 'None' } },
  ]);
  assert.deepEqual(SHARE_TEXT_LIMITS, { slogan: 80, sharedBy: 32 });
});

test('empty input yields the language default slogan, empty credit and safe enums', () => {
  assert.deepEqual(normalizeShareStyle(), {
    slogan: 'Good work,\nin good company.', sharedBy: '', numberStyle: 'soft', ornament: 'thread',
  });
  assert.deepEqual(normalizeShareStyle({}, 'en'), {
    slogan: 'Good work,\nin good company.', sharedBy: '', numberStyle: 'soft', ornament: 'thread',
  });
  assert.deepEqual(normalizeShareStyle({}, 'zh'), {
    slogan: '工作有去有回。', sharedBy: '', numberStyle: 'soft', ornament: 'thread',
  });
  // Only 'zh' selects the Chinese default; every other language is English.
  assert.equal(normalizeShareStyle(undefined, 'ZH').slogan, 'Good work,\nin good company.');
  assert.equal(normalizeShareStyle(undefined, 'fr').slogan, 'Good work,\nin good company.');
});

test('undefined or nonstring slogan falls back, explicit empty stays empty', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(normalizeShareStyle({ slogan: bad }).slogan, 'Good work,\nin good company.');
    assert.equal(normalizeShareStyle({ slogan: bad }, 'zh').slogan, '工作有去有回。');
  }
  assert.equal(normalizeShareStyle({ slogan: '' }).slogan, '');
  assert.equal(normalizeShareStyle({ slogan: '' }, 'zh').slogan, '');
  assert.equal(normalizeShareStyle({ slogan: '   ' }).slogan, '');
});

test('slogan truncates at 80 code points without splitting a surrogate pair', () => {
  const cats = '🐈'.repeat(100); // 100 code points, 200 UTF-16 units.
  const out = normalizeShareStyle({ slogan: cats }).slogan;
  assert.equal(Array.from(out).length, 80);
  assert.equal(out, '🐈'.repeat(80));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out));
  assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out));
  // Exactly at the limit is untouched.
  assert.equal(normalizeShareStyle({ slogan: '🐈'.repeat(80) }).slogan, '🐈'.repeat(80));
});

test('sharedBy collapses to one trimmed line capped at 32 code points', () => {
  assert.equal(normalizeShareStyle({ sharedBy: undefined }).sharedBy, '');
  assert.equal(normalizeShareStyle({ sharedBy: 7 }).sharedBy, '');
  assert.equal(normalizeShareStyle({ sharedBy: '  Ada\nLovelace \t Hopper  ' }).sharedBy, 'Ada Lovelace Hopper');
  assert.equal(normalizeShareStyle({ sharedBy: 'line one\r\nline two\rline three' }).sharedBy, 'line one line two line three');
  const long = '猫'.repeat(50);
  const out = normalizeShareStyle({ sharedBy: long }).sharedBy;
  assert.equal(Array.from(out).length, 32);
  assert.equal(out, '猫'.repeat(32));
});

test('mixed-script multiline keeps newlines, drops tabs and other control chars', () => {
  const out = normalizeShareStyle({ slogan: 'A\u0000B\u0007C\u001fD\tE\r\nF' }).slogan;
  assert.equal(out, 'ABCD E\nF');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out));
  // Vertical whitespace inside the slogan survives as a real line break.
  assert.equal(normalizeShareStyle({ slogan: '第一行\n第二行 行三' }).slogan, '第一行\n第二行 行三');
});

test('unknown or hostile enum values fall back to soft / thread', () => {
  assert.equal(normalizeShareStyle({ numberStyle: 'fancy' }).numberStyle, 'soft');
  assert.equal(normalizeShareStyle({ ornament: 'glitter' }).ornament, 'thread');
  for (const bad of [null, 0, {}, [], '../etc/passwd']) {
    const out = normalizeShareStyle({ numberStyle: bad, ornament: bad });
    assert.equal(out.numberStyle, 'soft');
    assert.equal(out.ornament, 'thread');
  }
  assert.equal(normalizeShareStyle({ numberStyle: 'book', ornament: 'none' }).numberStyle, 'book');
  assert.equal(normalizeShareStyle({ numberStyle: 'book', ornament: 'none' }).ornament, 'none');
});

test('only the four contract fields survive; aggregate or extra keys are dropped', () => {
  const out = normalizeShareStyle({
    slogan: 'hello', sharedBy: 'me',
    numberStyle: 'mono', ornament: 'bloom',
    responsibilities: 999, worker_turns: 41, accepted: 12, route: 'private', theme: 'sage',
    nested: { external_tokens: 12345 }, project: '/Users/someone/secret',
  });
  assert.deepEqual(out, { slogan: 'hello', sharedBy: 'me', numberStyle: 'mono', ornament: 'bloom' });
  assert.deepEqual(Object.keys(out).sort(), ['numberStyle', 'ornament', 'sharedBy', 'slogan']);
  const serialized = JSON.stringify(out);
  for (const leak of ['999', '41', '12', 'private', 'sage', '12345', '/Users/someone/secret']) {
    assert.ok(!serialized.includes(leak), `unexpected leak: ${leak}`);
  }
});

test('XML-special characters pass through literally for the renderer to encode', () => {
  const hostile = '<script>alert("x")&</script>';
  const out = normalizeShareStyle({ slogan: hostile, sharedBy: "A & B <'quote'>" });
  assert.equal(out.slogan, hostile);
  assert.equal(out.sharedBy, "A & B <'quote'>");
  // No double-escaping: ampersands are not turned into entities here.
  assert.ok(!out.slogan.includes('&lt;'));
  assert.ok(!out.slogan.includes('&amp;'));
});

test('nonobject input never throws and never spreads the argument', () => {
  for (const bad of [null, undefined, 42, 'text', true, [], ['slogan']]) {
    const out = normalizeShareStyle(bad);
    assert.deepEqual(out, { slogan: 'Good work,\nin good company.', sharedBy: '', numberStyle: 'soft', ornament: 'thread' });
  }
  assert.equal(normalizeShareStyle(Object.create(null)).slogan, 'Good work,\nin good company.');
});
