// SPDX-License-Identifier: SUL-1.0
// Standalone share personalization contract. Author-entered and independent of
// aggregate statistics: nothing here inspects tasks, projects or routes, and
// author text is never derived from receipt data. Browser and Node import this
// module unchanged; it has no dependencies, I/O or side effects.
export const SHARE_SLOGANS = [
  { id: 'together', zh: '工作有去有回。', en: 'Good work,\nin good company.' },
  { id: 'room', zh: '把空间，留给好点子。', en: 'A little help.\nRoom to bloom.' },
  { id: 'small', zh: '小小协作，慢慢成事。', en: 'Small steps.\nShared momentum.' },
  { id: 'company', zh: '今天也有好搭子。', en: 'Good company.\nGood things ahead.' },
];
export const SHARE_NUMBER_STYLES = [
  { id: 'soft', name: { zh: '柔和', en: 'Soft' } },
  { id: 'book', name: { zh: '书页', en: 'Book' } },
  { id: 'mono', name: { zh: '等宽', en: 'Mono' } },
];
export const SHARE_ORNAMENTS = [
  { id: 'thread', name: { zh: '绕线', en: 'Thread' } },
  { id: 'bloom', name: { zh: '小花', en: 'Bloom' } },
  { id: 'none', name: { zh: '留白', en: 'None' } },
];
// Limits count Unicode code points, not UTF-16 units, so a 4-byte emoji is one.
export const SHARE_TEXT_LIMITS = { slogan: 80, sharedBy: 32 };
const DEFAULT_NUMBER_STYLE = 'soft';
const DEFAULT_ORNAMENT = 'thread';
const has = (list, id) => list.some(entry => entry.id === id);
// Tabs become spaces and CRLF becomes LF; every other C0 control is dropped.
// XML-special text stays literal: the renderer owns encoding, never this module.
const sanitize = value => value
  .replace(/\r\n?/g, '\n')
  .replace(/\t/g, ' ')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
// Truncate by code points so a surrogate pair is never split into lone halves.
const clampCodePoints = (value, limit) => {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
};
// Single physical line: interior newlines collapse with surrounding runs.
const collapseSpaces = value => value.replace(/\s+/g, ' ').trim();
export function normalizeShareStyle(input = {}, language = 'en') {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const zh = language === 'zh';
  const defaultSlogan = zh ? SHARE_SLOGANS[0].zh : SHARE_SLOGANS[0].en;
  const slogan = typeof source.slogan === 'string'
    ? clampCodePoints(sanitize(source.slogan).trim(), SHARE_TEXT_LIMITS.slogan)
    : defaultSlogan;
  const sharedBy = typeof source.sharedBy === 'string'
    ? clampCodePoints(collapseSpaces(sanitize(source.sharedBy)), SHARE_TEXT_LIMITS.sharedBy)
    : '';
  const numberStyle = has(SHARE_NUMBER_STYLES, source.numberStyle) ? source.numberStyle : DEFAULT_NUMBER_STYLE;
  const ornament = has(SHARE_ORNAMENTS, source.ornament) ? source.ornament : DEFAULT_ORNAMENT;
  return { slogan, sharedBy, numberStyle, ornament };
}
