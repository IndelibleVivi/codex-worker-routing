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
const expected=['index.html','zh/index.html','guide/index.html','zh/guide/index.html','404.html','.nojekyll','sitemap.xml',
 'assets/style.css','assets/client.mjs','assets/demo.mjs','assets/cat.svg',
 ...['en','zh'].flatMap(l=>['hero','banner','social','demo-sage'].map(n=>`assets/${n}-${l}.svg`).concat(`assets/social-${l}.png`)),
 ...['share','share-style','brand','mark','mascots','themes','ornaments','time'].map(n=>`assets/lib/${n}.mjs`)].sort();
assert.deepEqual(paths,expected,'Only the explicit public projection may be deployed');
for(const file of ['artwork.mjs','build.mjs','check.mjs','client.mjs','demo.mjs','page.mjs','guide.mjs']){
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
for(const [lang,file] of [['en','index.html'],['zh-CN','zh/index.html'],['en','guide/index.html'],['zh-CN','zh/guide/index.html']]){
 const html=await fs.readFile(path.join(dist,file),'utf8');
 assert.ok(html.includes(`<html lang="${lang}"`));
 assert.ok(html.includes('hreflang="en"')&&html.includes('hreflang="zh-CN"'));
 assert.match(html,/<noscript>/);
 if(!file.includes('guide/'))assert.match(html,/SYNTHETIC DATA|合成数据/);
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
  const [resource,anchor]=url.split('#');
  let target=path.resolve(dist,path.dirname(file),resource);
  if(resource.endsWith('/'))target=path.join(target,'index.html');
  await fs.access(target);
  if(anchor){const targetHTML=await fs.readFile(target,'utf8');assert.ok(targetHTML.includes(`id="${anchor}"`),`Missing destination ${url} in ${file}`);}
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
// --- Search metadata contract ------------------------------------------------
// Validate relationships and meaning across the four routes against the known
// public website contract, the language set and the built projection. The
// expected origin is the deployed site base; a wrong host fails here even if it
// is self-consistent in the generated output.
const PUBLIC_SITE='https://indeliblevivi.github.io/codex-worker-routing/';
const PUBLIC_REPO='https://github.com/IndelibleVivi/codex-worker-routing';
const pages={
 'index.html':{lang:'en',ogLocale:'en_US',zh:false,guide:false},
 'zh/index.html':{lang:'zh-CN',ogLocale:'zh_CN',zh:true,guide:false},
 'guide/index.html':{lang:'en',ogLocale:'en_US',zh:false,guide:true},
 'zh/guide/index.html':{lang:'zh-CN',ogLocale:'zh_CN',zh:true,guide:true},
};
const meta=html=>{
 const head=html.slice(0,html.indexOf('</head>'));
 const metaTag=(attrName,value)=>[...head.matchAll(new RegExp(`<meta ${attrName}="${value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}" content="([^"]*)"`,'g'))].map(m=>m[1]);
 const named=m=>metaTag('name',m);
 const prop=m=>metaTag('property',m);
 const link=rel=>[...head.matchAll(new RegExp(`<link rel="${rel}"([^>]*)>`,'g'))].map(m=>({href:m[1].match(/href="([^"]*)"/)?.[1],hreflang:m[1].match(/hreflang="([^"]*)"/)?.[1]}));
 return {
  title:head.match(/<title>([^<]*)<\/title>/)?.[1],
  description:named('description')[0],
  // Crawler directives: the site-wide "robots" meta and bot-specific variants
  // such as "googlebot", which also control indexing.
  robots:[...head.matchAll(/<meta name="(robots|googlebot|[a-z-]*bot)" content="([^"]*)"/gi)].map(m=>m[2]),
  canonical:link('canonical'),
  alternates:link('alternate'),
  og:Object.fromEntries(['og:type','og:site_name','og:title','og:description','og:url','og:locale','og:image','og:image:type','og:image:width','og:image:height','og:image:alt'].map(k=>[k,prop(k)[0]])),
  twitter:{card:named('twitter:card')[0],title:named('twitter:title')[0],description:named('twitter:description')[0],image:named('twitter:image')[0],imageAlt:named('twitter:image:alt')[0]},
  jsonLd:[...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m=>JSON.parse(m[1])),
 };
};
const read=async file=>meta(await fs.readFile(path.join(dist,file),'utf8'));
const canonicalFor=file=>PUBLIC_SITE+file.replace(/index\.html$/,'');
const graphOf=page=>page.jsonLd.flatMap(block=>block['@graph']||[]);
const titles=[],descriptions=[],contexts=[];
for(const [file,expect] of Object.entries(pages)){
 const page=await read(file);
 const label=file+': ';
 const {title,description,canonical,alternates,og,twitter,jsonLd}=page;
 const selfUrl=canonicalFor(file);
 // Titles and descriptions: present, distinct, not keyword-stuffed. The upper
 // bounds are editorial; character counts do not guarantee search appearance.
 assert.ok(title,label+'a <title> is present');
 assert.ok(title.length<=70,label+'title stays within a reasonable editorial length');
 // The homepage titles name the product identity; the guide may keep the brand only.
 assert.ok(title.includes('Worker Routing'),label+'title names the product brand');
 if(!expect.guide)assert.ok(title.includes('Codex'),label+'the homepage title names the Codex product identity');
 assert.ok(description&&description.length>0,label+'a meta description is present');
 assert.notEqual(description.trim(),title.trim(),label+'description is distinct from the title');
 assert.equal(og['og:title'],title,label+'og:title matches the title');
 assert.equal(og['og:description'],description,label+'og:description matches the meta description');
 titles.push(title);descriptions.push(description);
 // Canonical, exactly self-referential against the known public origin.
 assert.equal(canonical.length,1,label+'exactly one canonical link');
 assert.equal(canonical[0].href,selfUrl,label+'canonical is the exact self URL under the public origin');
 // Reciprocal alternates with a matching language and x-default.
 assert.equal(alternates.length,3,label+'one alternate per supported language and x-default');
 const alt=Object.fromEntries(alternates.map(t=>[t.hreflang,t.href]));
 assert.deepEqual(Object.keys(alt).sort(),['en','x-default','zh-CN'],label+'exactly the en / zh-CN / x-default alternates');
 assert.equal(alt[expect.lang],selfUrl,label+'matching-language alternate is the self URL');
 const defaultLangFile=expect.zh?file.slice(3):file; // the English route for this view
 assert.equal(alt['x-default'],canonicalFor(defaultLangFile),label+'x-default is the default-language (English) route for this view');
 const counterpart=expect.zh?file.slice(3):'zh/'+file;
 assert.equal(alt[expect.zh?'en':'zh-CN'],canonicalFor(counterpart),label+'the other language points at its matching route');
 // Social metadata and real same-origin asset existence.
 const image=og['og:image'];
 assert.equal(og['og:type'],'website',label+'og:type');
 assert.equal(og['og:url'],selfUrl,label+'og:url equals the canonical');
 assert.equal(og['og:locale'],expect.ogLocale,label+'og:locale matches the page language');
 assert.ok(og['og:site_name'],label+'og:site_name present');
 assert.ok(image?.startsWith(PUBLIC_SITE)&&image.endsWith('-'+expect.lang.split('-')[0]+'.png'),label+'og:image is the language-matched same-origin PNG');
 await fs.access(path.join(dist,image.slice(PUBLIC_SITE.length)));
 assert.equal(og['og:image:type'],'image/png',label+'og:image:type');
 assert.equal(og['og:image:width'],'1200',label+'og:image:width');
 assert.equal(og['og:image:height'],'630',label+'og:image:height');
 assert.ok((og['og:image:alt']||'').length>8,label+'og:image:alt text');
 assert.ok((og['og:image:alt']||'').includes('Worker Routing'),label+'social alt names the product artwork');
 assert.equal(twitter.card,'summary_large_image',label+'twitter:card');
 assert.equal(twitter.title,title,label+'twitter:title matches');
 assert.equal(twitter.description,description,label+'twitter:description matches');
 assert.equal(twitter.image,image,label+'twitter:image matches og:image');
 assert.ok((twitter.imageAlt||'').length>8,label+'twitter:image:alt present');
 // JSON-LD semantics: one graph, expressed in the page language.
 assert.equal(jsonLd.length,1,label+'exactly one JSON-LD block');
 contexts.push(jsonLd[0]['@context']);
 const graph=graphOf(page);
 assert.ok(graph.length>=1,label+'the JSON-LD block carries a node graph');
 for(const node of graph){
  assert.ok(node['@type'],label+'every node declares @type');
  assert.ok(node['@id']||node.url,label+'block-level nodes carry an @id or url');
  if('inLanguage' in node){
   const langs=[].concat(node.inLanguage);
   assert.ok(langs.includes(expect.lang),label+'every node language set includes the page language');
   if(typeof node.inLanguage==='string')assert.equal(node.inLanguage,expect.lang,label+'page-level node language matches <html lang>');
  }
  for(const key of ['name','description','caption'])if(key in node)assert.ok(String(node[key]).length>0,label+key+' is non-empty');
  for(const [k,v] of Object.entries(node)){
   if(k==='@context')continue;
   if(typeof v==='string'&&/^https?:\/\//.test(v))assert.ok(v.startsWith(PUBLIC_SITE)||v.startsWith(PUBLIC_REPO),label+k+' URL stays on the public site or repository');
  }
 }
 const byType=t=>graph.filter(n=>n['@type']===t);
 const pageNode=byType('WebPage')[0];
 assert.ok(pageNode,label+'a WebPage node');
 assert.equal(pageNode['@id'],selfUrl+'#page',label+'WebPage @id follows the canonical route');
 assert.equal(pageNode.url,selfUrl,label+'WebPage url is the self canonical');
 assert.equal(pageNode.inLanguage,expect.lang,label+'WebPage language matches <html lang>');
 assert.equal(pageNode.isPartOf?.['@id'],PUBLIC_SITE+'#website',label+'WebPage resolves to the shared WebSite node');
 assert.equal(pageNode.about?.['@id'],PUBLIC_SITE+'#software',label+'WebPage resolves to the shared product node');
 // The page image is declared inline on primaryImageOfPage; resolve it there.
 const imageNode=pageNode.primaryImageOfPage;
 assert.ok(imageNode&&imageNode['@type']==='ImageObject',label+'the WebPage declares an ImageObject');
 assert.equal(imageNode.url,image,label+'the image node matches og:image');
 await fs.access(path.join(dist,imageNode.url.slice(PUBLIC_SITE.length)));
 assert.equal(imageNode.width,1200,label+'the image node is the 1200-wide social asset');
 assert.equal(imageNode.height,630,label+'the image node is the 630-tall social asset');
 const crumbs=byType('BreadcrumbList')[0];
 if(!expect.guide){
  // The homepage is the root: no breadcrumb, and no self-referential duplicate.
  assert.equal(pageNode.breadcrumb,undefined,label+'the homepage WebPage carries no breadcrumb');
  assert.equal(crumbs,undefined,label+'the homepage emits no BreadcrumbList');
  // Shared identities are declared on the homepages, with a stable SITE url and
  // both languages, and no single-language conflict on a shared entity.
  const website=byType('WebSite')[0];
  assert.ok(website,label+'a WebSite node');
  assert.equal(website['@id'],PUBLIC_SITE+'#website',label+'the WebSite @id is the site base');
  assert.equal(website.url,PUBLIC_SITE,label+'the WebSite url is the stable SITE base');
  assert.deepEqual([].concat(website.inLanguage).sort(),['en','zh-CN'],label+'the WebSite declares both languages');
  const product=byType('SoftwareSourceCode')[0];
  assert.ok(product,label+'a SoftwareSourceCode product node');
  assert.equal(product['@id'],PUBLIC_SITE+'#software',label+'the product @id is the site base');
  assert.equal(product.url,PUBLIC_SITE,label+'the product url is the stable SITE base across translations');
  assert.deepEqual([].concat(product.inLanguage).sort(),['en','zh-CN'],label+'the product declares both languages');
  assert.equal(product.isPartOf?.['@id'],website['@id'],label+'the product is part of the site identity');
  assert.equal(product.name,'Worker Routing',label+'the product name is the public product name');
  assert.equal(product.codeRepository,PUBLIC_REPO,label+'the product codeRepository is the public repository');
  assert.equal(product.license,PUBLIC_REPO+'/blob/main/LICENSE',label+'the product license points at the repository LICENSE');
  assert.equal(product.runtimePlatform,'Codex',label+'the product runtimePlatform is Codex');
 }else{
  // Guide breadcrumbs: the matching-language homepage, then the guide. Two items only.
  assert.ok(crumbs,label+'the guide emits a BreadcrumbList');
  assert.equal(crumbs['@id'],pageNode.breadcrumb?.['@id'],label+'WebPage.breadcrumb resolves to the BreadcrumbList');
  assert.equal(crumbs.itemListElement.length,2,label+'guide breadcrumbs have exactly two items');
  for(const [index,item] of crumbs.itemListElement.entries())assert.equal(item.position,index+1,label+'breadcrumb positions are ordered');
  assert.equal(crumbs.itemListElement[0].item,canonicalFor(expect.zh?'zh/index.html':'index.html'),label+'the first breadcrumb is the matching-language homepage');
  assert.equal(crumbs.itemListElement[0].name,expect.zh?'首页':'Home',label+'the first breadcrumb is localized');
  assert.equal(crumbs.itemListElement[1].item,selfUrl,label+'the last breadcrumb is the current guide');
  // The guide declares no product identity of its own.
  assert.equal(byType('SoftwareSourceCode').length,0,label+'the product node is declared on homepages, not the guide');
  assert.equal(byType('WebSite').length,0,label+'the site node is declared on homepages, not the guide');
 }
}
assert.equal(new Set(titles).size,titles.length,'All four routes need distinct titles');
assert.equal(new Set(descriptions).size,descriptions.length,'All four routes need distinct descriptions');
assert.deepEqual([...new Set(contexts)],['https://schema.org'],'Every JSON-LD block uses the schema.org context');

// The sitemap must name exactly the four canonical HTML routes, once each, with
// no invented lastmod. robots.txt is origin-root only; the file allowlist above
// already excludes any project-subdirectory robots.txt.
const sitemap=await fs.readFile(path.join(dist,'sitemap.xml'),'utf8');
assert.match(sitemap,/^<\?xml version="1\.0" encoding="UTF-8"\?>/,'sitemap has an XML declaration');
assert.match(sitemap,/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/,'sitemap uses the sitemap 0.9 namespace');
const locs=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);
assert.deepEqual([...locs].sort(),Object.keys(pages).map(canonicalFor).sort(),'sitemap <loc> set must exactly match the four canonical HTML routes');
assert.equal(new Set(locs).size,locs.length,'no duplicate sitemap entries');
assert.doesNotMatch(sitemap,/<lastmod>/,'no synthetic lastmod timestamps');

// Indexing permissions: normal pages must not opt out; index/follow and
// max-image-preview are valid, so only blocking directives are rejected. The 404
// page is the one route that must stay noindex.
const blocking=dirs=>dirs.split(',').map(d=>d.trim().toLowerCase()).some(d=>['noindex','nofollow','none'].includes(d));
for(const file of Object.keys(pages)){
 const html=await fs.readFile(path.join(dist,file),'utf8');
 for(const content of meta(html).robots)assert.ok(!blocking(content),`${file} must not carry a blocking robots directive: ${content}`);
}
const notFound=meta(await fs.readFile(path.join(dist,'404.html'),'utf8'));
assert.ok(notFound.robots.some(c=>/\bnoindex\b/.test(c)),'404 must stay noindex');
assert.doesNotMatch(sitemap,/404/,'the 404 page is not in the sitemap');

console.log(`Website checks passed: ${paths.length} public files, bilingual links, browser imports, banner parity, synthetic totals and the ${Object.keys(pages).length}-route search metadata contract.`);
