import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {render,cleanup} from 'ink-testing-library';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'uj-tool-access-ui-'));
process.env.UNJAILED_HOME=home;process.env.UNJAILED_API_KEY='sk-local-test';process.env.UNJAILED_MODEL='kimi-k3';process.env.UNJAILED_NO_FX='1';process.env.NO_COLOR='1';
const {App}=await import('../dist/ui/App.js');
const {readConfig,writeConfig}=await import('../dist/config.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,message){for(let i=0;i<160;i++){if(fn())return;await sleep(25);}assert.fail(message);}
async function submit(ui,text){ui.stdin.write(text);await sleep(80);ui.stdin.write('\r');await sleep(200);}
const reset=(patch={})=>writeConfig({tools:'read',autoMode:'ask',plan:false,fx:false,saveSessions:false,...patch});
test.after(()=>{cleanup();fs.rmSync(home,{recursive:true,force:true});});

test('auto from read/off opens a permission picker, cancellation retains restricted access and does not persist auto approval',async()=>{
 for(const tools of ['read','off']){
  reset({tools});const ui=render(React.createElement(App));
  try{await sleep(200);await submit(ui,'/auto');assert.ok(ui.frames.some(frame=>/Choose tool permissions/.test(frame)));assert.ok(ui.frames.some(frame=>/Select the access you authorize/.test(frame)));assert.equal(readConfig().tools,tools);assert.equal(readConfig().autoMode,'ask');ui.stdin.write('\u001b');await sleep(200);assert.equal(readConfig().tools,tools);assert.equal(readConfig().autoMode,'ask');await submit(ui,'/tools cmds');assert.equal(readConfig().tools,'cmds');assert.equal(readConfig().autoMode,'ask');}
  finally{ui.unmount();ui.cleanup();}
 }
});

test('permission picker requires an explicit selection; confirmed tools reset stale auto approval and auto off exits yolo',async()=>{
 reset({tools:'read',autoMode:'auto'});const ui=render(React.createElement(App));
 try{
  await sleep(200);await submit(ui,'/tools');assert.match(ui.lastFrame(),/Choose tool permissions/);
  ui.stdin.write('\u001b[B');await sleep(80);ui.stdin.write('\r');await sleep(200);
  assert.equal(readConfig().tools,'cmds');assert.equal(readConfig().autoMode,'ask');
  await submit(ui,'/auto');assert.equal(readConfig().tools,'cmds');assert.equal(readConfig().autoMode,'auto');
  await submit(ui,'/tools cmds');assert.equal(readConfig().autoMode,'ask');
  await submit(ui,'/tools yolo');assert.equal(readConfig().tools,'yolo');
  await submit(ui,'/auto off');assert.equal(readConfig().tools,'cmds');assert.equal(readConfig().autoMode,'ask');
  await submit(ui,'/tools read');assert.equal(readConfig().tools,'read');assert.equal(readConfig().autoMode,'ask');
 }finally{ui.unmount();ui.cleanup();}
});

test('CLI creates a folder and script and executes it only after separate file and command approvals',async()=>{
 reset();const originalFetch=globalThis.fetch;const requests=[];
 const root=path.join(home,'Desktop','calculator');const script=path.join(root,'sum.mjs');
 globalThis.fetch=async (url,init)=>{
  if(String(url).endsWith('/models'))return Response.json({data:[{id:'kimi-k3'}]});
  const request={body:JSON.parse(init.body),controller:null};const body=new ReadableStream({start(c){request.controller=c;}});requests.push(request);return new Response(body,{headers:{'content-type':'text/event-stream'}});
 };
 const ui=render(React.createElement(App));
 const send=(r,delta,finish=null)=>r.controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}]})+'\n\n'));
 const done=r=>{r.controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));r.controller.close();};
 try{
  await sleep(200);await submit(ui,'/tools cmds');
  await submit(ui,'Create a Desktop calculator folder, write a small addition program and run it with 2 and 3.');
  await waitFor(()=>requests.length===1,'first agent request');
  assert.ok(requests[0].body.tools.some(t=>t.function.name==='write_file'));assert.ok(requests[0].body.tools.some(t=>t.function.name==='run_command'));
  send(requests[0],{tool_calls:[{index:0,id:'create-script',function:{name:'write_file',arguments:JSON.stringify({path:script,content:'console.log(Number(process.argv[2]) + Number(process.argv[3]));\n'})}}]},'tool_calls');done(requests[0]);
  await waitFor(()=>/Permission needed/.test(ui.lastFrame()),'file write approval');assert.equal(fs.existsSync(script),false);
  await sleep(200);ui.stdin.write('y');
  await waitFor(()=>requests.length===2,'write completed');assert.equal(fs.readFileSync(script,'utf8'),'console.log(Number(process.argv[2]) + Number(process.argv[3]));\n');
  const quote=s=>'"'+s.replaceAll('"','\\"')+'"';
  send(requests[1],{tool_calls:[{index:0,id:'run-script',function:{name:'run_command',arguments:JSON.stringify({command:quote(process.execPath)+' '+quote(script)+' 2 3',cwd:root})}}]},'tool_calls');done(requests[1]);
  await waitFor(()=>/Permission needed/.test(ui.lastFrame()),'execution approval');assert.equal(requests.length,2);
  await sleep(200);ui.stdin.write('y');
  await waitFor(()=>requests.length===3,'command completed');
  const result=requests[2].body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='run-script');assert.match(result.content,/5/);assert.match(result.content,/Exit code: 0/);
  send(requests[2],{content:'Created the calculator and verified 2 + 3 = 5.'},'stop');done(requests[2]);await waitFor(()=>ui.frames.some(frame=>/Created the calculator/.test(frame)),'task completion');
 }finally{for(const r of requests){try{r.controller.close();}catch{}}ui.unmount();ui.cleanup();globalThis.fetch=originalFetch;}
});
