import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {render,cleanup} from 'ink-testing-library';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'uj-draft-ui-'));
process.env.UNJAILED_HOME=path.join(root,'config');process.env.UNJAILED_API_KEY='sk-fixture-draft';process.env.UNJAILED_NO_FX='1';process.env.NO_COLOR='1';
const {App}=await import('../dist/ui/App.js');const {writeConfig}=await import('../dist/config.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label){for(let i=0;i<200;i++){if(fn())return;await sleep(25);}assert.fail(label);}
test.after(()=>{cleanup();fs.rmSync(root,{recursive:true,force:true});});

test('live code is visible before stream completion; no file exists until complete call and actual approval',async()=>{
 writeConfig({tools:'cmds',autoMode:'ask',saveSessions:false,fx:false});
 const original=globalThis.fetch,target=path.join(root,'live.js'),requests=[],encoder=new TextEncoder();let streamController;
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/models'))return Response.json({data:[{id:'glm-5.3'}]});
  requests.push(JSON.parse(init.body));
  if(requests.length>1)return Response.json({choices:[{message:{content:'Created the file.'}}]});
  return new Response(new ReadableStream({start(c){streamController=c;}}),{headers:{'content-type':'text/event-stream'}});
 };
 const ui=render(React.createElement(App));
 const send=delta=>streamController.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\n'));
 try{
  await sleep(200);ui.stdin.write('Create a JavaScript file');await sleep(100);ui.stdin.write('\r');
  await waitFor(()=>streamController,'stream opened');await waitFor(()=>/Waiting for model/.test(ui.lastFrame()),'honest waiting state');assert.ok(!ui.lastFrame().includes('LIVE DRAFT'));
  send({tool_calls:[{index:0,id:'write',function:{name:'write_file',arguments:'{"path":'+JSON.stringify(target)+',"content":"const livePreview = 42;\\n'}}]});
  await waitFor(()=>/const livePreview = 42;/.test(ui.lastFrame()),'code visible while JSON incomplete');assert.match(ui.lastFrame(),/LIVE DRAFT/);assert.match(ui.lastFrame(),/not executed yet/);assert.equal(fs.existsSync(target),false);assert.equal(requests.length,1);
  ui.stdin.write('queued next task');await sleep(100);assert.match(ui.lastFrame(),/queued next task/);
  send({tool_calls:[{index:0,function:{arguments:'console.log(livePreview);\\n"}'}}]});
  streamController.enqueue(encoder.encode('data: [DONE]\n\n'));streamController.close();
  await waitFor(()=>/Waiting for permission/.test(ui.lastFrame()),'normal approval still required');assert.equal(fs.existsSync(target),false);assert.ok(!ui.lastFrame().includes('LIVE DRAFT'));
  await sleep(200);ui.stdin.write('y');await waitFor(()=>fs.existsSync(target),'file created only after permission');
  assert.equal(fs.readFileSync(target,'utf8'),'const livePreview = 42;\nconsole.log(livePreview);\n');await waitFor(()=>ui.frames.some(f=>/Created the file./.test(f)),'completion');assert.match(ui.frames.join('\n'),/Step 1 · Writing file/);
  assert.ok(!requests[1].messages.some(m=>m.content?.includes('LIVE DRAFT')),'draft UI never becomes conversation content');
 }finally{ui.unmount();ui.cleanup();globalThis.fetch=original;}
});
