import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentTurn,streamChat} from '../dist/api.js';
import {toolDefinitions,executeTool} from '../dist/tools.js';
const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n';
const tool=(id,name,args)=>frame({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args)}}]},'tool_calls')+'data: [DONE]\n\n';
async function fixture(respond,run){
 const requests=[],timers=new Set();const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.writeHead(200,{'content-type':'text/event-stream'});respond(res,requests.length,later);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run(`http://127.0.0.1:${server.address().port}`,requests);}finally{for(const t of timers)clearTimeout(t);server.closeAllConnections();await new Promise(r=>server.close(r));}
}
function thinking(res){res.write(frame({reasoning_content:'Checking the concrete fixture result.'}));const t=setInterval(()=>res.write(frame({reasoning_content:' Continue checking.'})),20);res.on('close',()=>clearInterval(t));return()=>clearInterval(t);}
test('active recovery can finish beyond its silence limit and perform the requested real file change',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uj-recovery-progress-'));fs.writeFileSync(path.join(dir,'calculator.py'),'print(2+3)\n');
 try{await fixture((res,n,later)=>{
  if(n===1)return res.end(tool('read','read_file',{path:'calculator.py'}));
  if(n===2){const t=setInterval(()=>res.write(': heartbeat\n\n'),20);res.on('close',()=>clearInterval(t));return;}
  if(n===3){const stop=thinking(res);later(()=>{stop();if(!res.destroyed)res.end(tool('write','write_file',{path:'README.md',content:'Run python3 calculator.py.\n'}));},340);return;}
  res.end(frame({content:'The README is saved and the calculator is unchanged.'},'stop')+'data: [DONE]\n\n');
 },async(base,requests)=>{
  const operations=[],recoveries=[];
  const final=await agentTurn(base,'synthetic','glm-5.3-flash-abliterated',[{role:'user',content:'Read calculator.py and create its README.'}],{onToken(){},onRecovery:m=>recoveries.push(m)},new AbortController().signal,{tools:toolDefinitions('cmds'),effort:'medium',reasoningTimeoutMs:180,responseTimeoutMs:1200,execute:async(name,args)=>{operations.push(name);return executeTool(name,args,dir,async()=>true,{mode:'cmds',autoApprove:true});}});
  assert.match(final,/README is saved/);assert.equal(requests.length,4);assert.equal(recoveries.length,1);assert.deepEqual(operations,['read_file','write_file']);assert.equal(fs.readFileSync(path.join(dir,'README.md'),'utf8'),'Run python3 calculator.py.\n');assert.equal(fs.readFileSync(path.join(dir,'calculator.py'),'utf8'),'print(2+3)\n');assert.equal(requests[2].reasoning_effort,'low');
 });}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reasoning-aware silence watchdog still rejects heartbeats without model output',async()=>{
 await fixture(res=>{const t=setInterval(()=>res.write(': heartbeat\n\n'),20);res.on('close',()=>clearInterval(t));},async base=>{
  await assert.rejects(streamChat(base,'synthetic','m',[],{onToken(){}},new AbortController().signal,{reasoningTimeoutMs:180,responseTimeoutMs:1200,reasoningProgress:true}),/reasoning deadline/);
 });
});
test('continuous recovery reasoning cannot outlive the absolute response deadline',async()=>{
 await fixture(res=>thinking(res),async base=>{
  await assert.rejects(streamChat(base,'synthetic','m',[],{onToken(){}},new AbortController().signal,{reasoningTimeoutMs:180,responseTimeoutMs:340,reasoningProgress:true}),/response deadline/);
 });
});
