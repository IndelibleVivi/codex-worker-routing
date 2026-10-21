// SPDX-License-Identifier: SUL-1.0
import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createProjectionReader } from './dispatch.mjs';
import { projectShare } from './share.mjs';
import { renderLogoSVG } from './brand.mjs';
import { renderProductMarkSVG } from './mark.mjs';
import { readPreferences,writePreferences } from './preferences.mjs';
import { Fault } from './state.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/storage-view.mjs', ['storage.mjs', 'text/javascript; charset=utf-8']],
]);
export async function startDashboard({stateDir, configPath, since='all', port=0, reader, storage, idleMs=120000} = {}) {
  if (!Number.isInteger(Number(port)) || Number(port)<0 || Number(port)>65535)
    throw new Fault('USAGE', 'Dashboard port must be between 0 and 65535.');
  const projection = reader ?? createProjectionReader(stateDir);
  await projection.read({since}); // Validate requested period before listening.
  const token = randomBytes(32).toString('hex');
  let origin, touched = Date.now(), opened = false;
  // Lazily loaded on the explicit Storage view, never on the 15-second Dispatch
  // refresh. Its local paths/metadata stay out of /api/snapshot and /api/share.
  async function storageCall(name,options){
    if(!configPath)throw new Fault('STORAGE_UNAVAILABLE','No storage config.');
    const [{loadConfig},api]=await Promise.all([import('./config.mjs'),import('./storage.mjs')]);
    const current=await loadConfig(configPath);
    if(current.stateDir!==stateDir)throw new Fault('STORAGE_CONFIG_CHANGED','The state root changed; reopen the dashboard.');
    return api[name](current,options);
  }
  const storageService=storage??{
    inventory:options=>storageCall('inventoryStorage',options),
    plan:options=>storageCall('planStorage',options),
    apply:options=>storageCall('applyStoragePlan',options),
  };
  const server = http.createServer(async (req,res) => {
    const headers = {
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    };
    const send = (status, body, type='application/json; charset=utf-8') => {
      res.writeHead(status, {...headers,'Content-Type':type});
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if(req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin))
        return send(403,{error:'This dashboard accepts only its own loopback origin.'});
      const url = new URL(req.url,origin);
      if(url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
        if(supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) return send(401,{error:'Open the private URL printed by cwr-acp dashboard.'});
        touched = Date.now(); opened = true;
        if(url.pathname === '/api/close' && req.method === 'POST') { send(200,{closed:true}); setImmediate(close); return; }
        if(url.pathname === '/api/preferences' && req.method === 'PUT') {
          let body='';
          for await (const chunk of req) {
            body+=chunk;
            if(Buffer.byteLength(body)>1024) return send(413,{error:'PREFERENCES_TOO_LARGE'});
          }
          let value;
          try { value=JSON.parse(body); } catch { return send(400,{error:'BAD_PREFERENCES'}); }
          return send(200,await writePreferences(stateDir,value));
        }
        if(['/api/storage/plan','/api/storage/apply'].includes(url.pathname)) {
          if(req.method!=='POST')return send(405,{error:'POST_REQUIRED'});
          if(req.headers.origin!==origin)return send(403,{error:'LOCAL_ORIGIN_REQUIRED'});
          if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return send(415,{error:'JSON_REQUIRED'});
          let body='';
          for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return send(413,{error:'STORAGE_INPUT_TOO_LARGE'});}
          let value;try{value=JSON.parse(body);}catch{return send(400,{error:'BAD_STORAGE_INPUT'});}
          if(!value||typeof value!=='object'||Array.isArray(value))return send(400,{error:'BAD_STORAGE_INPUT'});
          if(url.pathname.endsWith('/plan')){
            if(Object.keys(value).some(k=>!['targetIds','olderThanMs'].includes(k))||!Array.isArray(value.targetIds)||!value.targetIds.length||value.targetIds.length>64||value.targetIds.some(id=>typeof id!=='string'||id.length>200)||new Set(value.targetIds).size!==value.targetIds.length||!Number.isSafeInteger(value.olderThanMs)||value.olderThanMs<86400000||value.olderThanMs>3650*86400000)return send(400,{error:'BAD_STORAGE_INPUT'});
            return send(200,await storageService.plan(value));
          }
          const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
          if(Object.keys(value).some(k=>!['planId','confirm'].includes(k))||typeof value.planId!=='string'||!uuid.test(value.planId)||value.confirm!==value.planId)return send(400,{error:'STORAGE_CONFIRMATION_REQUIRED'});
          return send(200,await storageService.apply(value));
        }
        if(req.method !== 'GET') return send(405,{error:'Read-only dashboard.'});
        if(url.pathname==='/api/storage'){
          if([...url.searchParams.keys()].some(k=>!['olderThanDays','extraHome'].includes(k))||url.searchParams.getAll('olderThanDays').length>1||url.searchParams.getAll('extraHome').length>1)return send(400,{error:'BAD_STORAGE_INPUT'});
          const days=Number(url.searchParams.get('olderThanDays')??7);
          if(!Number.isSafeInteger(days)||days<1||days>3650)return send(400,{error:'BAD_STORAGE_INPUT'});
          const extraHome=url.searchParams.get('extraHome');
          if(extraHome!==null&&(!extraHome.length||extraHome.length>4096||extraHome.includes('\0')))return send(400,{error:'BAD_STORAGE_INPUT'});
          return send(200,await storageService.inventory({olderThanMs:days*86400000,...(extraHome?{extraHomes:[extraHome]}:{})}));
        }
        if(url.pathname === '/api/ping') return send(200,{ok:true});
        if(url.pathname === '/api/preferences') return send(200,await readPreferences(stateDir));
        const period = url.searchParams.get('since') ?? since;
        const timeZone = url.searchParams.get('timeZone') ?? 'UTC';
        if(url.pathname === '/api/snapshot') return send(200,await projection.read({since:period,timeZone}));
        if(url.pathname === '/api/share') return send(200,projectShare(await projection.read({since:period,timeZone})));
        const match = url.pathname.match(/^\/api\/detail\/([a-f0-9-]{36})$/);
        if(match) return send(200,await projection.detail(match[1],{timeZone}));
        return send(404,{error:'Unknown dashboard endpoint.'});
      }
      if(req.method !== 'GET') return send(405,{error:'Method not allowed.'});
      if(['/share-style.mjs','/ornaments.mjs'].includes(url.pathname)) return send(200,await fs.readFile(new URL('.'+url.pathname,import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/share.mjs') return send(200,await fs.readFile(new URL('./share.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/themes.mjs') return send(200,await fs.readFile(new URL('./themes.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/mascots.mjs') return send(200,await fs.readFile(new URL('./mascots.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/brand.mjs') return send(200,await fs.readFile(new URL('./brand.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/mark.mjs') return send(200,await fs.readFile(new URL('./mark.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/time.mjs') return send(200,await fs.readFile(new URL('./time.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/logo.svg') return send(200,renderLogoSVG(),'image/svg+xml');
      if(url.pathname === '/mark.svg') return send(200,renderProductMarkSVG(),'image/svg+xml');
      const asset = files.get(url.pathname);
      if(!asset) return send(404,{error:'Not found.'});
      send(200,await fs.readFile(new URL(`./dashboard/${asset[0]}`,import.meta.url),'utf8'),asset[1]);
    } catch(error) {
      // Private filesystem paths and raw parser/provider messages never cross HTTP.
      send(['USAGE','BAD_PERIOD','BAD_TIME_ZONE','BAD_PREFERENCES','BAD_STORAGE_INPUT'].includes(error?.code)?400:error instanceof Fault&&req.url?.startsWith('/api/storage')?409:500,{error:error instanceof Fault ? error.code : 'LOCAL_READ_FAILED'});
    }
  });
  let closing;
  const close = () => closing??=(new Promise((resolve,reject) => {
    clearInterval(timer);
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  let timer;
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(Number(port),'127.0.0.1',resolve);});
  origin = `http://127.0.0.1:${server.address().port}`;
  // No detached daemon. Closing the last page stops its heartbeats and releases
  // this process; a never-opened URL has a five-minute grace period.
  timer = setInterval(() => { if(Date.now()-touched > (opened?idleMs:Math.max(idleMs,300000))) void close(); },Math.min(idleMs,10000));
  timer.unref();
  return {url:`${origin}/#token=${token}&since=${encodeURIComponent(since)}`, server, close, port:server.address().port};
}
