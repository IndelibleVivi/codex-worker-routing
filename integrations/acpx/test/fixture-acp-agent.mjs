// Synthetic ACP server for testing the REAL pinned acpx package. No model, API,
// third-party account, user data, or network calls. All state is in test HOME.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const home=process.env.HOME;
const store=path.join(home,'fixture-sessions.json'),audit=path.join(home,'fixture-audit.ndjson');
const lockDir=`${store}.lock`;
let sessions={};try{sessions=JSON.parse(await fs.readFile(store,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
// Cross-process safety: several fixture processes can share one HOME. Saving
// therefore takes an exclusive lock and does a read-modify-write that only
// overwrites records THIS process changed, so overlapping processes never lose
// each other's sessions. Fixture-only; not a claim about any real adapter.
const dirty=new Set(),removed=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function withLock(fn){
 // Exclusive-create lock directory. A crashed owner leaves it behind; the
 // parent test cleans the whole HOME, so a short-lived fixture tolerates that.
 for(;;){try{await fs.mkdir(lockDir,{mode:0o700});break}catch(e){if(e.code!=='EEXIST')throw e;await sleep(2)}}
 try{return await fn()}finally{await fs.rmdir(lockDir).catch(()=>{})}
}
async function readStore(){
 try{const v=JSON.parse(await fs.readFile(store,'utf8'));return v&&typeof v==='object'?v:{}}catch(e){if(e.code!=='ENOENT')throw e;return {}}
}
async function reload(){sessions=await readStore();return sessions}
async function save(){
 return withLock(async()=>{
  const current=await readStore();
  for(const id of removed)delete current[id];
  for(const id of dirty)if(sessions[id])current[id]=sessions[id];
  const temp=`${store}.${randomUUID()}.tmp`;
  try{await fs.writeFile(temp,JSON.stringify(current),{mode:0o600});await fs.rename(temp,store)}
  finally{await fs.rm(temp,{force:true})}
  sessions=current;dirty.clear();removed.clear();
  return current;
 });
}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply=(id,result)=>send({id,result});
const fail=(id,message)=>send({id,error:{code:-32602,message}});
const pending=new Map(),permissions=new Map();
async function complete(id,params,text,stopReason='end_turn'){
 if(stopReason!=='cancelled')send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
 reply(id,{stopReason});pending.delete(params.sessionId);
}
const input=readline.createInterface({input:process.stdin});
let inputClosed=false;
input.on('close',()=>{
 // A failed integration test can terminate its CLI before cancellation arrives.
 // EOF must end this synthetic adapter, including FIXTURE_WAIT's parked timer.
 inputClosed=true;
 for(const item of pending.values())clearTimeout(item.timer);
 pending.clear();
});
input.on('line',line=>{
 (async()=>{
  const q=JSON.parse(line);
  if(!q.method){const p=permissions.get(q.id);if(p){permissions.delete(q.id);p(q.result)}return}
  // Register a parked prompt before the first awaited audit/store operation.
  // The turn file can become observable while save() is still finalizing;
  // cancel in that window must settle this request, not disappear.
  const preparingText=q.method==='session/prompt'?(q.params?.prompt??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
  const preparing=preparingText.includes('FIXTURE_WAIT')||preparingText.includes('FIXTURE_PROGRESS_ONLY')
   ?{id:q.id,params:q.params,timer:null,cancelStopReason:preparingText.includes('CANCEL_END_TURN')?'end_turn':'cancelled'}:null;
  if(preparing)pending.set(q.params.sessionId,preparing);
  await fs.appendFile(audit,JSON.stringify({method:q.method,sessionId:q.params?.sessionId??null})+'\n',{mode:0o600});
  const {id,method,params={}}=q;
  if(method==='initialize')return reply(id,{protocolVersion:1,agentInfo:{name:'cwr-synthetic-fixture',version:'1'},agentCapabilities:{loadSession:true,promptCapabilities:{}},authMethods:[]});
  if(method==='session/new'){await reload();const sessionId=randomUUID();sessions[sessionId]={turn:0,cwd:params.cwd};dirty.add(sessionId);await save();return reply(id,{sessionId})}
  if(method==='session/load'){await reload();if(!sessions[params.sessionId])return fail(id,'Synthetic session no longer exists');return reply(id,{})}
  if(method==='session/prompt'){
   await reload();
   if(inputClosed||(preparing&&pending.get(params.sessionId)!==preparing))return;
   const s=sessions[params.sessionId];
   if(!s){if(preparing)pending.delete(params.sessionId);return fail(id,'Unknown synthetic session')}
   const text=params.prompt.filter(p=>p.type==='text').map(p=>p.text).join('\n');
   s.turn++;dirty.add(params.sessionId);await save();
   if(inputClosed||(preparing&&pending.get(params.sessionId)!==preparing))return;
   if(text.includes('FIXTURE_PROGRESS_ONLY')){
    send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic progress, no final response.'}}}});
    // Deliberately no prompt response. Tests cancel through the real public
    // runtime; some adapters acknowledge cancellation with end_turn instead.
    pending.set(params.sessionId,{id,params,timer:null,cancelStopReason:text.includes('CANCEL_END_TURN')?'end_turn':'cancelled'});return;
   }
   if(text.includes('FIXTURE_WAIT')){const timer=setTimeout(()=>complete(id,params,'finished'),30000);pending.set(params.sessionId,{id,params,timer});return}
   if(text.includes('FIXTURE_WRITE')){
    const requestId=randomUUID();
    const answer=new Promise(resolve=>permissions.set(requestId,resolve));
    send({id:requestId,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{toolCallId:randomUUID(),title:'Edit synthetic fixture',kind:'edit',status:'pending'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'reject-once',name:'Reject once',kind:'reject_once'}]}});
    const r=await answer;const allowed=r?.outcome?.outcome==='selected'&&r.outcome.optionId==='allow-once';
    if(allowed)await fs.writeFile(path.join(s.cwd,'fixture-result.txt'),'fixture only\n');
   return complete(id,params,JSON.stringify({turn:s.turn,sessionId:params.sessionId,allowed}));
  }
   if(text.includes('cwr-delivery')){
    // The prompt carries the actual request_id/session_id the collector expects;
    // echo them into a synthetic cwr-delivery block so real --deliver turns
    // exercise collection end-to-end. No model, no provider, no host data.
    const rid=(text.match(/"request_id":"([0-9a-f-]{36})"/)||[])[1]??randomUUID();
    const sid=(text.match(/"session_id":"([0-9a-f-]{36})"/)||[])[1]??params.sessionId;
    const block='```cwr-delivery\n'+JSON.stringify({schema:'cwr.acp.delivery/1',status:'ready',summary:'synthetic delivery',request_id:rid,session_id:sid,criteria:[],checks:[],artifacts:[],decision_impacts:[{target:'synthetic target',finding:'synthetic finding',consequence:'synthetic consequence',evidence_refs:['test/fixture-acp-agent.mjs']}],questions:[]})+'\n```';
    return complete(id,params,block);
   }
   // Echo only the isolation-relevant environment names. Synthetic values only;
   // no host secrets, credentials, user data or network access.
   return complete(id,params,JSON.stringify({turn:s.turn,sessionId:params.sessionId,main_marker_present:Boolean(process.env.CWR_PRIVATE_TEST_MARKER),home,
    tmpdir:process.env.TMPDIR??null,temp:process.env.TEMP??null,tmp:process.env.TMP??null,userprofile:process.env.USERPROFILE??null,
    appdata:process.env.APPDATA??null,localappdata:process.env.LOCALAPPDATA??null,
    comspec:process.env.COMSPEC??null,pathext:process.env.PATHEXT??null,systemroot:process.env.SystemRoot??null}));
  }
  if(method==='session/cancel'){
   const p=pending.get(params.sessionId);if(p){clearTimeout(p.timer);await complete(p.id,p.params,'',p.cancelStopReason??'cancelled')}
   if(id!==undefined)reply(id,{});return;
  }
  if(method==='session/close'){await reload();delete sessions[params.sessionId];removed.add(params.sessionId);await save();if(id!==undefined)reply(id,{});return}
  if(id!==undefined)send({id,error:{code:-32601,message:'Fixture method not supported'}});
 })().catch(e=>{process.stderr.write(`fixture error: ${e.message}\n`);process.exitCode=1});
});
