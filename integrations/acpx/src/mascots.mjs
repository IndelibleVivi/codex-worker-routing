// SPDX-License-Identifier: SUL-1.0
import {catMark} from './brand.mjs';
// Siblings share the Canon cat's ink, embroidered smile and pink cheeks.
// The Canon cat is returned verbatim; themed animals never replace its source.
export function mascotMark(id = 'cat') {
  if(id === 'rabbit') return `<g stroke-linecap="round" stroke-linejoin="round">
    <path fill="#57414f" d="M27 59C19 38 18 9 30 7C44 5 48 30 48 49Q61 45 75 50C83 34 92 17 104 22C118 28 104 54 99 63C113 76 117 98 101 107C88 116 39 118 22 107C5 96 12 71 27 59Z"/>
    <path fill="#d5aab4" d="M30 17C26 16 28 40 33 48Q36 54 40 50C43 40 36 17 30 17Z"/>
    <path fill="#d7c29e" d="M95 26C105 20 111 26 108 33C105 44 96 56 97 61C87 58 82 55 78 53C83 44 85 32 95 26Z"/>
    <path d="M30 76Q38 69 46 78M78 80Q84 75 91 81" fill="none" stroke="#fffefa" stroke-width="3.2"/>
    <ellipse cx="31" cy="87" rx="7" ry="4.5" fill="#edbed0"/><ellipse cx="91" cy="93" rx="7" ry="4.5" fill="#edbed0"/>
    <path d="M57 84Q62 82 66 85Q63 90 60 89Z" fill="#edbed0"/>
    <path d="M61 89Q58 97 53 92M61 89Q65 98 71 93" fill="none" stroke="#fffefa" stroke-width="2.2"/>
    <path d="M30 86l-2 3m5-2-2 3m58 2-2 3m6-2-2 3" stroke="#88657f" stroke-width="1"/>
  </g>`;
  if(id === 'dog') return `<g stroke-linecap="round" stroke-linejoin="round">
    <path fill="#455165" d="M29 42C42 29 76 31 94 46L104 82C112 101 94 112 64 114C37 116 18 105 22 85Z"/>
    <path fill="#455165" d="M35 42C29 32 16 40 11 54C5 68 5 89 16 92C27 94 31 72 37 58Z"/>
    <path fill="#a8bfca" d="M91 43C96 36 108 42 115 55C123 69 123 88 114 92C103 96 98 76 89 62C85 54 86 47 91 43Z"/>
    <path d="M105 51Q116 68 115 80" fill="none" stroke="#cfdae0" stroke-width="1.4" stroke-dasharray="2 3"/>
    <path d="M34 66Q42 59 50 68M78 72Q85 67 92 74" fill="none" stroke="#fffefa" stroke-width="3.2"/>
    <path fill="#fffefa" d="M46 86C48 75 61 77 66 81C77 79 87 86 84 94C81 104 49 104 45 95Q43 90 46 86Z"/>
    <path fill="#455165" d="M56 84Q63 80 70 85Q70 91 64 93Q58 91 56 84Z"/>
    <path d="M64 93v3" stroke="#455165" stroke-width="1.7"/>
    <path fill="#edbed0" d="M61 98Q68 100 74 96C76 107 65 111 62 103Z"/>
    <ellipse cx="31" cy="82" rx="7" ry="4" fill="#edbed0"/><ellipse cx="94" cy="89" rx="7" ry="4" fill="#edbed0"/>
  </g>`;
  if(id === 'bear') return `<g stroke-linecap="round" stroke-linejoin="round">
    <path fill="#59465e" d="M23 51C8 43 9 26 22 23C34 20 43 32 41 39Q62 31 84 43C90 27 107 30 113 40C121 54 112 64 106 66C117 79 117 99 103 107C87 117 42 117 24 108C7 99 10 74 23 51Z"/>
    <path fill="#bdadce" d="M17 34C10 46 26 56 34 45C40 35 25 24 17 34Z"/>
    <path fill="#e3ba9e" d="M96 41C86 49 96 64 106 57C116 50 105 32 96 41Z"/>
    <path d="M31 70Q38 63 46 72M79 75Q85 70 92 77" fill="none" stroke="#fffefa" stroke-width="3.2"/>
    <path fill="#fff4df" d="M48 89C47 76 78 76 80 91C82 106 47 108 48 89Z"/>
    <path fill="#59465e" d="M56 84Q63 82 69 85Q68 91 63 92Q59 90 56 84Z"/>
    <path d="M63 92v3m-6 0q6 6 12 0" fill="none" stroke="#59465e" stroke-width="1.7"/>
    <ellipse cx="29" cy="84" rx="7" ry="4.5" fill="#edbed0"/><ellipse cx="96" cy="90" rx="7" ry="4.5" fill="#edbed0"/>
    <path d="M28 83l-2 3m5-2-2 3m65 1-2 3m6-2-2 3" stroke="#88657f" stroke-width="1"/>
  </g>`;
  return catMark();
}
export function renderMascotSVG(id = 'cat') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 128 128" role="img" aria-label="Worker Routing companion">${mascotMark(id)}</svg>`;
}
