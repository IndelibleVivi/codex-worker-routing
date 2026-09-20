// SPDX-License-Identifier: SUL-1.0
// Static public projection: only this manifest and synthetic demo data are built.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderPage,SITE} from './page.mjs';
import {renderHeroArt,renderBanner,renderLogoSVG} from './artwork.mjs';
import {renderShareSVG} from '../acpx/src/share.mjs';
import {DEMO_SHARE} from './demo.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(root,'dist');
for(const dir of ['assets/lib','guide','zh/guide'])await fs.mkdir(path.join(out,dir),{recursive:true});
for(const lang of ['en','zh']){
 await fs.writeFile(path.join(out,lang==='en'?'index.html':'zh/index.html'),renderPage(lang));
 await fs.writeFile(path.join(out,lang==='en'?'guide/index.html':'zh/guide/index.html'),renderPage(lang,'guide'));
 for(const [name,svg] of [['hero',renderHeroArt(lang)],['banner',renderBanner(lang)],['social',renderBanner(lang,true)],['demo-sage',renderShareSVG(DEMO_SHARE,'banner',lang,'sage')]])await fs.writeFile(path.join(out,`assets/${name}-${lang}.svg`),svg);
}
await fs.writeFile(path.join(out,'assets/cat.svg'),renderLogoSVG());
for(const name of ['style.css','client.mjs','demo.mjs'])await fs.copyFile(path.join(root,name),path.join(out,'assets',name));
for(const name of ['share.mjs','share-style.mjs','brand.mjs','mark.mjs','mascots.mjs','themes.mjs','ornaments.mjs','time.mjs'])await fs.copyFile(path.join(root,'../acpx/src',name),path.join(out,'assets/lib',name));
for(const lang of ['en','zh'])await fs.copyFile(path.join(root,`assets/social-${lang}.png`),path.join(out,`assets/social-${lang}.png`));
await fs.writeFile(path.join(out,'.nojekyll'),'');
await fs.writeFile(path.join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}</loc></url><url><loc>${SITE}zh/</loc></url><url><loc>${SITE}guide/</loc></url><url><loc>${SITE}zh/guide/</loc></url></urlset>\n`);
await fs.writeFile(path.join(out,'404.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found · Worker Routing</title><body><h1>This page wandered off.</h1><p>这一页走丢了。</p><a href="'+SITE+'">Back to Worker Routing / 返回首页</a></body></html>');
if(process.argv.includes('--sync-banner'))for(const lang of ['en','zh'])await fs.copyFile(path.join(out,`assets/banner-${lang}.svg`),path.join(root,`../../plugins/worker-routing/assets/banner-${lang}.svg`));
console.log('Built bilingual public site in integrations/site/dist (synthetic data only).');
