import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {render,cleanup} from 'ink-testing-library';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'uj-progress-order-'));
process.env.UNJAILED_HOME=path.join(root,'config');process.env.UNJAILED_API_KEY='sk-fixture-order';process.env.UNJAILED_NO_FX='1';process.env.NO_COLOR='1';
const {App}=await import('../dist/ui/App.js');const{writeConfig}=await import('../dist/config.js');const{listSessions,loadSession}=await import('../dist/sessions.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label){for(let i=0;i<200;i++){if(fn())return;await sleep(25);}assert.fail(label);}
test.after(()=>{cleanup();fs.rmSync(root,{recursive:true,force:true});});

test('each round preamble precedes its tool log and separate updates remain separate in saved history',async()=>{
 writeConfig({tools:'read',autoMode:'ask',fx:false,saveSessions:true});fs.writeFileSync(path.join(root,'a.txt'),'existing evidence');
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/models'))return Response.json({data:[{id:'glm-5.3'}]});
  requests.push(JSON.parse(init.body));const n=requests.length;
  const message=n<3?{content:n===1?'Checking the first file.':'Checking another detail.',tool_calls:[{id:'inspect'+n,function:{name:'read_file',arguments:JSON.stringify({path:path.join(root,'a.txt')})}}]}:{content:'The evidence explains the behavior.'};
  return Response.json({choices:[{message,finish_reason:n<3?'tool_calls':'stop'}]});
 };
 const ui=render(React.createElement(App));
 try{
  await sleep(200);ui.stdin.write('Nothing appears when the button is pressed.');await sleep(100);ui.stdin.write('\r');
  await waitFor(()=>requests.length===3&&ui.frames.some(f=>f.includes('The evidence explains the behavior.')),'three rounds finish');
  await waitFor(()=>listSessions().some(s=>loadSession(s.id)?.messages.length===2),'session saved');
  const saved=loadSession(listSessions()[0].id);assert.equal(saved.messages.at(-1).content,'Checking the first file.\n\nChecking another detail.\n\nThe evidence explains the behavior.');
  const frames=ui.frames.join('\n');assert.ok(frames.indexOf('Checking the first file.')<frames.indexOf('Step 1 · Reading file'),'first update before first action');assert.ok(frames.indexOf('Checking another detail.')<frames.indexOf('Step 2 · Reading file'),'second update before second action');
  assert.equal(saved.toolHistory.length,2);
 }finally{ui.unmount();ui.cleanup();globalThis.fetch=original;}
});
