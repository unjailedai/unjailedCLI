import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {render,cleanup} from 'ink-testing-library';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'uj-direct-ui-'));
process.env.UNJAILED_HOME=path.join(root,'config');process.env.UNJAILED_API_KEY='sk-fixture-direct';process.env.UNJAILED_NO_FX='1';process.env.NO_COLOR='1';
const {App}=await import('../dist/ui/App.js');const {writeConfig,readConfig,configPath}=await import('../dist/config.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,message){for(let i=0;i<200;i++){if(fn())return;await sleep(25);}assert.fail(message);}
async function submit(ui,text){ui.stdin.write(text);await sleep(100);ui.stdin.write('\r');await sleep(150);}
function reset(patch={}){fs.rmSync(configPath(),{force:true});writeConfig({tools:'cmds',autoMode:'ask',fx:false,saveSessions:false,...patch});}
function response(message){return Response.json({choices:[{message}]});}
test.after(()=>{cleanup();fs.rmSync(root,{recursive:true,force:true});});

test('missing plan preference starts directly with tools, preserves per-file approval, and stays direct next turn and restart',async()=>{
 for(const model of ['glm-5.3-abliterated','glm-5.3-flash-abliterated']){
  reset({model});assert.equal(readConfig().plan,undefined);
  const target=path.join(root,model+'.py'),requests=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
   if(String(url).endsWith('/models'))return Response.json({data:[{id:model}]});
   const body=JSON.parse(init.body);requests.push(body);
   assert.ok(body.tools.some(t=>t.function.name==='write_file'),'first request exposes tools instead of asking for a plan');
   assert.ok(!body.messages.some(m=>m.content?.includes('Before doing anything: reply with ONLY a short numbered plan')));
   if(requests.length===1)return response({tool_calls:[{id:'create',function:{name:'write_file',arguments:JSON.stringify({path:target,content:'print(2 + 3)\n'})}}]});
   return response({content:'The requested task is complete.'});
  };
  let ui=render(React.createElement(App));
  try{
   await sleep(200);await submit(ui,'Create a calculator script.');
   await waitFor(()=>ui.frames.some(f=>/Waiting for permission/.test(f)),'file permission prompt');
   assert.equal(requests.length,1);assert.equal(fs.existsSync(target),false,'no write before actual permission');
   await sleep(200);ui.stdin.write('y');await waitFor(()=>requests.length===2,'tool result request');
   await waitFor(()=>ui.frames.some(f=>/requested task is complete/.test(f)),'completion');assert.equal(fs.readFileSync(target,'utf8'),'print(2 + 3)\n');
   await submit(ui,'Check the result again.');await waitFor(()=>requests.length===3,'second prompt executes without a planning pass');
   assert.ok(!ui.frames.some(f=>/Draft plan|Start this plan\?|drafting a plan/.test(f)));
   ui.unmount();ui.cleanup();ui=render(React.createElement(App));await sleep(200);await submit(ui,'Check this project.');await waitFor(()=>requests.length===4,'restart remains direct');
   assert.equal(readConfig().plan,undefined);assert.ok(!ui.frames.some(f=>/Draft plan|Start this plan\?/.test(f)));
  }finally{ui.unmount();ui.cleanup();globalThis.fetch=original;}
 }
});

test('explicit plan mode is respected, reject does not act, and plan off immediately restores direct execution',async()=>{
 reset({model:'glm-5.3-abliterated',plan:true});const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/models'))return Response.json({data:[{id:'glm-5.3-abliterated'}]});
  const body=JSON.parse(init.body);requests.push(body);
  return response({content:requests.length===1?'1. Inspect the project.\n2. Make the requested change.':'Direct task complete.'});
 };
 const ui=render(React.createElement(App));
 try{
  await sleep(200);await submit(ui,'Fix the calculator.');await waitFor(()=>/Start this plan\?/.test(ui.lastFrame()),'explicit planning approval');
  assert.equal(requests.length,1);assert.equal(requests[0].tools,undefined);
  await sleep(200);ui.stdin.write('\u001b');await waitFor(()=>ui.frames.some(f=>/Plan rejected/.test(f)),'plan rejected');assert.equal(requests.length,1);
  await submit(ui,'/plan off');assert.equal(readConfig().plan,false);await submit(ui,'Fix the calculator.');await waitFor(()=>requests.length===2,'direct execution after plan off');
  assert.ok(requests[1].tools.some(t=>t.function.name==='write_file'));await waitFor(()=>ui.frames.some(f=>/Direct task complete/.test(f)),'direct completion');
 }finally{ui.unmount();ui.cleanup();globalThis.fetch=original;}
});

test('opt-in planning after real tool use strips both old calls and results from the planning request',async()=>{
 reset({model:'glm-5.3-abliterated',plan:false});const original=globalThis.fetch,requests=[];
 const target=path.join(root,'existing.txt');fs.writeFileSync(target,'project evidence');
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/models'))return Response.json({data:[{id:'glm-5.3-abliterated'}]});
  const body=JSON.parse(init.body);requests.push(body);
  if(requests.length===1)return response({tool_calls:[{id:'inspect',function:{name:'read_file',arguments:JSON.stringify({path:target})}}]});
  if(requests.length===2){assert.match(body.messages.find(m=>m.role==='tool').content,/project evidence/);return response({content:'Inspected the project evidence.'});}
  assert.equal(body.tools,undefined);assert.ok(body.messages.every(m=>m.role!=='tool'&&!m.tool_calls),'no orphaned calls in planning history');
  return response({content:'1. Inspect the change.\n2. Update the file.'});
 };
 const ui=render(React.createElement(App));
 try{
  await sleep(200);await submit(ui,'Read the existing file.');await waitFor(()=>ui.frames.some(f=>/Inspected the project evidence/.test(f)),'first tool turn');
  await submit(ui,'/plan on');await submit(ui,'Update the existing file.');await waitFor(()=>/Start this plan\?/.test(ui.lastFrame()),'planning with old tool history');
  assert.equal(requests.length,3);await sleep(200);ui.stdin.write('\u001b');await waitFor(()=>ui.frames.some(f=>/Plan rejected/.test(f)),'reject plan');assert.equal(fs.readFileSync(target,'utf8'),'project evidence');
 }finally{ui.unmount();ui.cleanup();globalThis.fetch=original;}
});
