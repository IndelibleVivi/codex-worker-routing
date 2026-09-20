// SPDX-License-Identifier: SUL-1.0
// Public artwork derives from the existing Canon cat, product mark and ornaments.
import {catMark,renderLogoSVG} from '../acpx/src/brand.mjs';
import {productMark} from '../acpx/src/mark.mjs';
import {ornamentMarkup} from '../acpx/src/ornaments.mjs';
const ink='#51415f', green='#acc099', soft='#edf2e5', pink='#faedf1', seam='#dfbecb';
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const text=(x,y,s,size=20,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${ink}" ${extra}>${esc(s)}</text>`;
const defs=`<defs><filter id="lift" x="-25%" y="-25%" width="150%" height="160%"><feDropShadow dy="8" stdDeviation="9" flood-color="${ink}" flood-opacity=".1"/></filter><pattern id="weave" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 1.5H6M1.5 0V6" stroke="${ink}" stroke-opacity=".035"/></pattern></defs>`;
const paper=(x,y,w,h,fill='#fffefa')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" fill="${fill}" filter="url(#lift)"/><rect x="${x+10}" y="${y+10}" width="${w-20}" height="${h-20}" rx="7" fill="none" stroke="${green}" stroke-dasharray="5 5"/>`;
export function heroDrawing(lang='en'){
 const zh=lang==='zh',T=(a,b)=>zh?a:b;
 return `<g font-family="Avenir Next,Arial,PingFang SC,Microsoft YaHei,sans-serif">
 <g transform="rotate(-4 329 283)"><rect x="108" y="119" width="455" height="360" rx="25" fill="${soft}"/><rect x="108" y="119" width="455" height="360" rx="25" fill="url(#weave)"/><rect x="121" y="132" width="429" height="334" rx="17" fill="none" stroke="${green}" stroke-dasharray="6 5" stroke-width="1.5"/></g>
 <path d="M61 256C15 312 66 355 116 314S192 272 211 292C238 321 177 364 226 402M484 452C566 493 625 462 603 418" fill="none" stroke="${green}" stroke-width="2.5" stroke-linecap="round"/>
 <g transform="rotate(-5 214 155)">${paper(51,58,337,183)}<rect x="184" y="42" width="83" height="32" rx="3" fill="${pink}" transform="rotate(8 225 58)"/>
 ${text(76,100,T('主 AGENT / 工单','MAIN AGENT / WORK ORDER'),13,'letter-spacing="1.3"')}
 ${text(76,153,T('让导入顺利一点。','A smoother import.'),29,'font-family="Georgia,Songti SC,serif"')}
 ${text(76,193,T('一块责任，一起接住。','One clear responsibility.'),17)}
 <path d="M76 215H239" stroke="${seam}" stroke-width="2" stroke-dasharray="2 5"/></g>
 <g transform="translate(468 273) rotate(7)"><g transform="rotate(14)"><rect x="9" y="-169" width="126" height="118" rx="5" fill="${pink}"/><path d="M22-154h100" stroke="${seam}" stroke-dasharray="5 4" stroke-width="1.5"/></g><circle cy="5" r="145" fill="#deded5"/><circle r="145" fill="#fffefa" filter="url(#lift)"/><circle r="136" fill="${soft}"/><circle r="136" fill="url(#weave)"/><circle r="124" fill="none" stroke="${green}" stroke-width="1.8" stroke-dasharray="5 5"/><g transform="translate(-120 -120) scale(1.875)">${catMark()}</g></g>
 <g transform="rotate(3 252 443)">${paper(84,374,355,169)}
 ${text(109,410,T('带回来 / 结果与证据','RETURN / RESULT + EVIDENCE'),13,'letter-spacing="1.1"')}
 <g stroke="#61794f" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M111 444l5 5 10-12M111 483l5 5 10-12"/></g>
 ${text(139,450,T('修改与检查，一起交回','Changes and checks, together'),18)}
 ${text(139,489,T('主 agent 整合，再交付','Main agent integrates & delivers'),17)}
 </g><g transform="translate(438 463) scale(.56)">${ornamentMarkup('bloom')}</g>
 <path d="M593 79l12 13m-13 0l13-13M34 407l8 9m-9 0l9-9" fill="none" stroke="${green}" stroke-width="2" stroke-linecap="round"/>
 </g>`;
}
export function renderHeroArt(lang='en'){
 return `<!-- SPDX-License-Identifier: SUL-1.0 -->\n<svg xmlns="http://www.w3.org/2000/svg" width="660" height="580" viewBox="0 0 660 580" role="img" aria-label="${lang==='zh'?'一份工单交给 worker，结果与证据回到主 agent':'A work order goes to a worker; results and evidence return to the main agent'}">${defs}${heroDrawing(lang)}</svg>`;
}
export function renderBanner(lang='en',social=false){
 const zh=lang==='zh',w=social?1200:1600,h=social?630:640,scale=social?.66:.89,artX=social?720:930;
 return `<!-- SPDX-License-Identifier: SUL-1.0 -->\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${zh?'Worker Routing — 工作有去有回。':'Worker Routing — Good work. In good company.'}">${defs}<rect width="${w}" height="${h}" fill="#f1f2ec"/><rect x="18" y="18" width="${w-36}" height="${h-36}" rx="24" fill="#fffefa"/><rect x="36" y="36" width="${w-72}" height="${h-72}" rx="16" fill="none" stroke="${green}" stroke-dasharray="7 6"/>
 <g font-family="Avenir Next,Arial,PingFang SC,Microsoft YaHei,sans-serif"><g transform="translate(73 69) scale(1.05)">${productMark().replace(/^<svg[^>]*>/,'').replace('</svg>','')}</g>${text(138,107,'worker routing',32,'font-weight="600"')}
 ${text(80,197,zh?'CODEX 的多模型委派与本地派工台':'MODEL DELEGATION. LOCAL FIELD NOTES.',15,'letter-spacing="2"')}
 ${text(76,zh?304:293,zh?'工作有去有回。':'Good work.',social?70:80,'font-family="Georgia,Songti SC,serif"')}
 ${text(76,zh?399:389,zh?'好搭子，一起做成。':'In good company.',social?(zh?60:69):80,`font-family="Georgia,Songti SC,serif"${zh?'':' font-style="italic"'}`)}
 ${text(81,463,zh?'把完整责任交出去，把结果与证据接回来。':'Hand off a whole responsibility. Bring back the evidence.',social?19:22)}
 ${text(81,540,'NATIVE CODEX  /  OPTIONAL ACP  /  DISPATCH',social?13:16,'letter-spacing="1.4"')}
 ${text(w-78,h-60,'github.com/IndelibleVivi/codex-worker-routing',social?14:17,'text-anchor="end"')}
 </g><g transform="translate(${artX} ${social?40:5}) scale(${scale})">${heroDrawing(lang)}</g></svg>`;
}
export {renderLogoSVG};
