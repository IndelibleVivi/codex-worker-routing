// SPDX-License-Identifier: SUL-1.0
// Verify the deployable projection, its links and its public-data boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DEMO_SHARE,DEMO_DAYS} from './demo.mjs';
import {renderBanner} from './artwork.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const dist=path.join(root,'dist');
const files=await fs.readdir(dist,{recursive:true,withFileTypes:true});
const paths=files.filter(f=>f.isFile()).map(f=>path.relative(dist,path.join(f.parentPath,f.name)).split(path.sep).join('/')).sort();
const expected=['index.html','zh/index.html','404.html','.nojekyll','sitemap.xml',
 'assets/style.css','assets/client.mjs','assets/demo.mjs','assets/cat.svg',
 ...['en','zh'].flatMap(l=>['hero','banner','social','demo-sage'].map(n=>`assets/${n}-${l}.svg`).concat(`assets/social-${l}.png`)),
 ...['share','share-style','brand','mark','mascots','themes','ornaments','time'].map(n=>`assets/lib/${n}.mjs`)].sort();
assert.deepEqual(paths,expected,'Only the explicit public projection may be deployed');
for(const file of ['artwork.mjs','build.mjs','check.mjs','client.mjs','demo.mjs','page.mjs']){
 const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
}
for(const file of paths.filter(f=>/\.(html|mjs|svg|css)$/.test(f))){
 const text=await fs.readFile(path.join(dist,file),'utf8');
 assert.doesNotMatch(text,/\/Users\/|\/home\/|stateDir|routes\.json/,'Private paths/config must not enter public assets: '+file);
 if(file.endsWith('.mjs')){
  assert.doesNotMatch(text,/(?:from\s*|import\s*)['"](?:node:|https?:)/,'Browser modules must stay local');
  for(const m of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))await fs.access(path.resolve(dist,path.dirname(file),m[1]));
 }
}
for(const [lang,file] of [['en','index.html'],['zh-CN','zh/index.html']]){
 const html=await fs.readFile(path.join(dist,file),'utf8');
 assert.ok(html.includes(`<html lang="${lang}">`));
 assert.ok(html.includes('hreflang="en"')&&html.includes('hreflang="zh-CN"'));
 assert.match(html,/<noscript>/);
 assert.match(html,/SYNTHETIC DATA|合成数据/);
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length,'HTML ids must be unique');
 for(const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)){
  const url=m[1];
  if(url.startsWith('#')){assert.ok(ids.includes(url.slice(1)),`Missing anchor ${url}`);continue;}
  if(url.startsWith('http')){
   const match=url.match(/^https:\/\/github.com\/IndelibleVivi\/codex-worker-routing\/blob\/main\/(.+)$/);
   if(match)await fs.access(path.resolve(root,'../..',match[1]));
   continue;
  }
  let target=path.resolve(dist,path.dirname(file),url);
  if(url.endsWith('/'))target=path.join(target,'index.html');
  await fs.access(target);
 }
}
for(const lang of ['en','zh']){
 const banner=await fs.readFile(path.join(root,`../../plugins/worker-routing/assets/banner-${lang}.svg`),'utf8');
 assert.equal(banner,renderBanner(lang),'Regenerate banners with --sync-banner');
 const png=await fs.readFile(path.join(dist,`assets/social-${lang}.png`));
 assert.equal(png.subarray(1,4).toString(),'PNG');
 assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
}
assert.equal(DEMO_DAYS.reduce((a,b)=>a+b,0),DEMO_SHARE.worker_turns);
assert.equal(DEMO_SHARE.runtime_completed+DEMO_SHARE.failed+DEMO_SHARE.cancelled,DEMO_SHARE.responsibilities);
console.log(`Website checks passed: ${paths.length} public files, bilingual links, browser imports, banner parity and synthetic totals.`);
