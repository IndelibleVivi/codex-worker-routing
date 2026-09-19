// SPDX-License-Identifier: SUL-1.0
import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createProjectionReader } from './dispatch.mjs';
import { projectShare } from './share.mjs';
import { Fault } from './state.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
export async function startDashboard({stateDir, since='all', port=0, reader, idleMs=120000} = {}) {
  if (!Number.isInteger(Number(port)) || Number(port)<0 || Number(port)>65535)
    throw new Fault('USAGE', 'Dashboard port must be between 0 and 65535.');
  const projection = reader ?? createProjectionReader(stateDir);
  await projection.read({since}); // Validate requested period before listening.
  const token = randomBytes(32).toString('hex');
  let origin, touched = Date.now(), opened = false;
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
        if(req.method !== 'GET') return send(405,{error:'Read-only dashboard.'});
        if(url.pathname === '/api/ping') return send(200,{ok:true});
        const period = url.searchParams.get('since') ?? since;
        if(url.pathname === '/api/snapshot') return send(200,await projection.read({since:period}));
        if(url.pathname === '/api/share') return send(200,projectShare(await projection.read({since:period})));
        const match = url.pathname.match(/^\/api\/detail\/([a-f0-9-]{36})$/);
        if(match) return send(200,await projection.detail(match[1]));
        return send(404,{error:'Unknown dashboard endpoint.'});
      }
      if(req.method !== 'GET') return send(405,{error:'Method not allowed.'});
      if(url.pathname === '/share.mjs') return send(200,await fs.readFile(new URL('./share.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');
      if(url.pathname === '/favicon.ico') { res.writeHead(204,headers);res.end();return; }
      const asset = files.get(url.pathname);
      if(!asset) return send(404,{error:'Not found.'});
      send(200,await fs.readFile(new URL(`./dashboard/${asset[0]}`,import.meta.url),'utf8'),asset[1]);
    } catch(error) {
      // Private filesystem paths and raw parser/provider messages never cross HTTP.
      send(error?.code==='USAGE'||error?.code==='BAD_PERIOD'?400:500,{error:error instanceof Fault ? error.code : 'LOCAL_READ_FAILED'});
    }
  });
  const close = () => new Promise((resolve,reject) => {
    clearInterval(timer);
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  let timer;
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(Number(port),'127.0.0.1',resolve);});
  origin = `http://127.0.0.1:${server.address().port}`;
  // No detached daemon. Closing the last page stops its heartbeats and releases
  // this process; a never-opened URL has a five-minute grace period.
  timer = setInterval(() => { if(Date.now()-touched > (opened?idleMs:Math.max(idleMs,300000))) void close(); },Math.min(idleMs,10000));
  timer.unref();
  return {url:`${origin}/#token=${token}&since=${encodeURIComponent(since)}`, server, close, port:server.address().port};
}
