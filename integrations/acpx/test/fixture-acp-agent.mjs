// Synthetic ACP server for testing the REAL pinned acpx package. No model, API,
// third-party account, user data, or network calls. All state is in test HOME.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const home=process.env.HOME;
const store=path.join(home,'fixture-sessions.json'),audit=path.join(home,'fixture-audit.ndjson');
let sessions={};try{sessions=JSON.parse(await fs.readFile(store,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
async function save(){
 const temp=`${store}.${randomUUID()}.tmp`;
 try{await fs.writeFile(temp,JSON.stringify(sessions),{mode:0o600});await fs.rename(temp,store)}
 finally{await fs.rm(temp,{force:true})}
}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply=(id,result)=>send({id,result});
const fail=(id,message)=>send({id,error:{code:-32602,message}});
const pending=new Map(),permissions=new Map();
async function complete(id,params,text,stopReason='end_turn'){
 if(stopReason!=='cancelled')send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
 reply(id,{stopReason});pending.delete(params.sessionId);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 (async()=>{
  const q=JSON.parse(line);
  if(!q.method){const p=permissions.get(q.id);if(p){permissions.delete(q.id);p(q.result)}return}
  await fs.appendFile(audit,JSON.stringify({method:q.method,sessionId:q.params?.sessionId??null})+'\n',{mode:0o600});
  const {id,method,params={}}=q;
  if(method==='initialize')return reply(id,{protocolVersion:1,agentInfo:{name:'cwr-synthetic-fixture',version:'1'},agentCapabilities:{loadSession:true,promptCapabilities:{}},authMethods:[]});
  if(method==='session/new'){const sessionId=randomUUID();sessions[sessionId]={turn:0,cwd:params.cwd};await save();return reply(id,{sessionId})}
  if(method==='session/load'){if(!sessions[params.sessionId])return fail(id,'Synthetic session no longer exists');return reply(id,{})}
  if(method==='session/prompt'){
   const s=sessions[params.sessionId];if(!s)return fail(id,'Unknown synthetic session');
   const text=params.prompt.filter(p=>p.type==='text').map(p=>p.text).join('\n');
   s.turn++;await save();
   if(text.includes('FIXTURE_WAIT')){const timer=setTimeout(()=>complete(id,params,'finished'),30000);pending.set(params.sessionId,{id,params,timer});return}
   if(text.includes('FIXTURE_WRITE')){
    const requestId=randomUUID();
    const answer=new Promise(resolve=>permissions.set(requestId,resolve));
    send({id:requestId,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{toolCallId:randomUUID(),title:'Edit synthetic fixture',kind:'edit',status:'pending'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'reject-once',name:'Reject once',kind:'reject_once'}]}});
    const r=await answer;const allowed=r?.outcome?.outcome==='selected'&&r.outcome.optionId==='allow-once';
    if(allowed)await fs.writeFile(path.join(s.cwd,'fixture-result.txt'),'fixture only\n');
    return complete(id,params,JSON.stringify({turn:s.turn,sessionId:params.sessionId,allowed}));
   }
   // Echo only the isolation-relevant environment names. Synthetic values only;
   // no host secrets, credentials, user data or network access.
   return complete(id,params,JSON.stringify({turn:s.turn,sessionId:params.sessionId,main_marker_present:Boolean(process.env.CWR_PRIVATE_TEST_MARKER),home,
    temp:process.env.TEMP??null,tmp:process.env.TMP??null,userprofile:process.env.USERPROFILE??null,
    appdata:process.env.APPDATA??null,localappdata:process.env.LOCALAPPDATA??null,
    comspec:process.env.COMSPEC??null,pathext:process.env.PATHEXT??null,systemroot:process.env.SystemRoot??null}));
  }
  if(method==='session/cancel'){
   const p=pending.get(params.sessionId);if(p){clearTimeout(p.timer);await complete(p.id,p.params,'','cancelled')}
   if(id!==undefined)reply(id,{});return;
  }
  if(method==='session/close'){delete sessions[params.sessionId];await save();if(id!==undefined)reply(id,{});return}
  if(id!==undefined)send({id,error:{code:-32601,message:'Fixture method not supported'}});
 })().catch(e=>{process.stderr.write(`fixture error: ${e.message}\n`);process.exitCode=1});
});
