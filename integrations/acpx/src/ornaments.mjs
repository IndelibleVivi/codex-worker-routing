// SPDX-License-Identifier: SUL-1.0
import {getTheme} from './themes.mjs';

// Hand-drawn paths share a 320 × 140 frame across the card and dashboard.
// This is decoration only: no labels, IDs, external assets or data geometry.
export function ornamentMarkup(kind='thread',themeId='sage') {
 const c=getTheme(themeId).colors;
 if(kind==='none')return '';
 const thread=`<path d="M12 105C42 86 63 123 97 103S139 76 158 86C174 94 165 113 150 107C134 100 151 74 181 71M220 72C245 78 240 109 265 112C279 114 294 106 305 91" stroke="${c.primaryLine}"/>
  <path d="M198 64C185 39 151 23 146 40C141 58 175 72 198 64C216 34 247 23 252 42C255 62 220 72 198 64ZM195 70C191 84 183 94 177 98M204 72C208 87 217 97 225 99" stroke="${c.secondaryLine}" stroke-width="3"/>
  <path d="M195 61Q202 55 209 65L203 74Q194 75 195 61Z" stroke="${c.ink}" stroke-opacity=".55" stroke-width="1.6"/>
  <path d="M65 42l8 9m-9 0l9-9M281 51l6 7m-7 0l7-7" stroke="${c.primaryLine}" stroke-width="1.7"/>`;
 const bloom=`<path d="M15 111C51 93 77 126 109 107S168 113 195 91C211 77 215 58 222 42M195 91C219 90 238 98 260 113" stroke="${c.primaryLine}"/>
  <path d="M211 72C190 73 185 58 188 53C204 51 212 61 211 72ZM203 84C223 66 240 73 241 78C230 94 212 92 203 84Z" stroke="${c.primaryLine}"/>
  <path d="M222 42C207 38 202 27 211 23C218 20 224 26 225 33C225 15 240 14 242 23C244 31 236 37 229 39C246 33 255 44 248 50C242 56 232 50 227 45C238 59 229 70 221 63C216 57 219 48 222 42C210 55 198 50 201 42C204 35 216 37 222 42Z" stroke="${c.secondaryLine}" stroke-width="2.6"/>
  <circle cx="225" cy="41" r="4" fill="${c.secondarySoft}" stroke="${c.ink}" stroke-opacity=".55" stroke-width="1.5"/>
  <path d="M73 49l8 9m-9 0l9-9M283 81l6 7m-7 0l7-7" stroke="${c.primaryLine}" stroke-width="1.7"/>`;
 return `<g fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${kind==='bloom'?bloom:thread}</g>`;
}

export function renderOrnamentSVG(kind='thread',themeId='sage') {
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 140" aria-hidden="true" focusable="false">${ornamentMarkup(kind,themeId)}</svg>`;
}
