import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicJSON, paths } from '../src/state.mjs';
import { loadConfig, selectRoute } from '../src/config.mjs';
export const sleep = ms => new Promise(r => setTimeout(r,ms));
export function deferred() { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
export async function fixture(overrides={}) {
  const lexicalRoot = await fs.mkdtemp(path.join(os.tmpdir(),'cwr-test-'));
  // Match production config loading, which canonicalizes an existing system
  // ancestor before applying strict no-symlink checks to managed descendants.
  // On macOS os.tmpdir() is normally under /var, an OS-owned symlink to
  // /private/var; retaining the lexical path would bypass that entry contract.
  const root = await fs.realpath(lexicalRoot);
  await fs.chmod(root,0o700);
  const cwd=path.join(root,'workspace'); await fs.mkdir(cwd,{mode:0o700});
  const configFile=path.join(root,'routes.json');
  const raw={schema:'cwr.acp.config/1',stateDir:path.join(root,'state'),routes:{worker:{enabled:true,argv:[process.execPath],workerHome:path.join(root,'worker-home'),workspaces:[cwd],passEnv:[],contextRevision:'synthetic-v1',maxPermissions:'full',sessionOptions:{},timeoutMs:2000,...overrides}}};
  await fs.writeFile(configFile,JSON.stringify(raw),{mode:0o600});
  const config=await loadConfig(configFile);
  const selection=await selectRoute(config,'worker',cwd);
  const binding={schema:'cwr.acp.binding/1',id:randomUUID(),route:'worker',routeFingerprint:selection.fingerprint,cwd:selection.cwd,closed:false,handle:null};
  await atomicJSON(paths(config.stateDir,binding.id).binding,binding);
  const orderFile=path.join(root,'order.md');await fs.writeFile(orderFile,'Investigate the synthetic importer.');
  return {root,cwd,raw,configFile,config,selection,binding,orderFile,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

/** Contract double only. Does NOT implement ACP or substitute for test:acpx. */
export function fakeAcpx(behavior={}) {
  const records=new Map(), calls=[];
  const api={records,calls,
    decodeAcpxRuntimeHandleState: s=>{try{return JSON.parse(s)}catch{return undefined}},
    createRuntimeStore:()=>({load:async id=>records.get(id),save:async r=>records.set(r.acpxRecordId,r)}),
    createAcpRuntime: options=>{
      const launch=randomUUID(); let launched=false, activeResult;
      const ensureLaunch=async()=>{
        if(launched)return;
        await options.processLifecycle.onBeforeSpawn({launchId:launch});
        await options.processLifecycle.onSpawned({launchId:launch,pid:12345});launched=true;
      };
      return {
        ensureSession:async input=>{
          calls.push(['ensure',input,options]);
          await ensureLaunch();
          if(behavior.initHang) return new Promise(()=>{});
          if(behavior.initError) throw Object.assign(new Error('synthetic init error'),{code:'INIT_ERROR'});
          const id=randomUUID();
          const handle={sessionKey:input.sessionKey,backend:'acpx',acpxRecordId:id,backendSessionId:`acp-${id}`,cwd:input.cwd,runtimeSessionName:JSON.stringify({mode:input.mode,acpxRecordId:id})};
          records.set(id,{acpxRecordId:id,acpSessionId:handle.backendSessionId,cwd:input.cwd,agentArgv:options.agentRegistry.resolve(input.agent)});
          return handle;
        },
        startTurn: input=>{
          calls.push(['start',input,options]);
          const d=deferred();activeResult=d;
          let streamClosed=false,cancelled=false;
          const finish=()=>d.resolve(cancelled?{status:'cancelled',stopReason:'cancelled'}:behavior.terminal??{status:'completed',stopReason:'end_turn'});
          const started=ensureLaunch();
          const onAbort=()=>{cancelled=true;finish()};
          input.signal?.addEventListener('abort',onAbort,{once:true});
          // Result does not depend on consuming the event stream.
          const turnNumber=(calls.filter(call=>call[0]==='start').length);
          const job=(async()=>{
            await started;
            if(behavior.firstTurnGate && turnNumber===1) await behavior.firstTurnGate;
            else await sleep(behavior.delay??2);
            finish();
          })();
          job.catch(d.reject);
          d.promise.finally(()=>input.signal?.removeEventListener('abort',onAbort));
          behavior.onStart?.(input);
          return {
            promptStarted:started,result:d.promise,
            events:{async *[Symbol.asyncIterator](){
              await started;
              if(behavior.streamError)throw Object.assign(new Error('stream failed'),{code:'STREAM_ERROR'});
              for(const e of behavior.events??[{type:'text_delta',stream:'thought',text:'PRIVATE_THOUGHT'},{type:'text_delta',stream:'output',text:'Synthetic result.'}]){
                if(streamClosed)break;
                yield e;
              }
              await d.promise;
            }},
            cancel:async()=>{calls.push(['cancel']);cancelled=true;finish()},
            closeStream:async()=>{calls.push(['closeStream']);streamClosed=true},
          };
        },
        getStatus:async({handle})=>({acpxRecordId:handle.acpxRecordId,backendSessionId:behavior.changedSession??handle.backendSessionId,models:behavior.models,usage:behavior.usage}),
        close:async input=>{
          calls.push(['close',input]);
          if(behavior.cleanupError)throw new Error('synthetic cleanup failure');
          if(activeResult)activeResult.resolve({status:'cancelled',stopReason:'cancelled'});
          if(launched&&!behavior.leakedProcess)options.processLifecycle.onExit({launchId:launch,pid:12345});
        },
      };
    },
  };
  return api;
}
