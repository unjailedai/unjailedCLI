import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planUpdate,runSelfUpdate} from '../dist/updater.js';
import {VERSION} from '../dist/constants.js';

test('updater installs only a newer published version, never a local floor or an older npm tag',()=>{
 assert.equal(planUpdate('0.12.9','0.12.9','0.12.8').status,'ahead');
 assert.equal(planUpdate('0.12.10','0.12.10','0.12.8').target,undefined);
 assert.equal(planUpdate('0.11.2','0.12.0','0.11.2').status,'ahead');
 assert.equal(planUpdate('0.12.10','0.12.10','0.12.10').status,'current');
 assert.equal(planUpdate('0.12.9','0.12.9','0.12.10').target,'0.12.10');
 assert.equal(planUpdate('0.12.0','0.12.0','0.13.0').target,'0.13.0');
});

test('failed or malformed registry versions never become an install target',()=>{
 for(const latest of [null,'','latest','0.15.0 && echo bad','0.15.0\n','01.2.3','1.0.0-01']) {
  const plan=planUpdate('0.14.0','0.12.0',latest);
  assert.equal(plan.status,'unavailable');assert.equal(plan.target,undefined);
 }
 assert.equal(planUpdate('invalid','0.12.0','0.15.0').status,'unavailable');
});

test('updater respects prerelease precedence and build metadata',()=>{
 assert.equal(planUpdate('0.13.0-beta.10','0.12.0','0.13.0-beta.2').status,'ahead');
 assert.equal(planUpdate('0.13.0-beta.10','0.12.0','0.13.0').target,'0.13.0');
 assert.equal(planUpdate('0.13.0+build.4','0.12.0','0.13.0+build.5').status,'current');
 assert.equal(planUpdate('0.13.0+build.4','0.12.0','0.12.1').status,'ahead');
});

async function fakeNpm(latest,run,{fail=false}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uj-updater with space-'));
 const bin=path.join(root,'bin'),prefix=path.join(root,'prefix'),log=path.join(root,'calls.jsonl');
 const pkg=path.join(prefix,'node_modules','unjailed');
 fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'original'),'preserve me');
 const script=path.join(bin,'fake.cjs');
 fs.writeFileSync(script,`const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='view'){console.log(${JSON.stringify(latest)});process.exit(0);}if(a[0]==='config'){console.log(${JSON.stringify(prefix)});process.exit(0);}if(a[0]==='install'){fs.mkdirSync(${JSON.stringify(pkg)},{recursive:true});fs.writeFileSync(path.join(${JSON.stringify(pkg)},'new-install'),a[2]);console.error('npm notice: report errors at support');process.exit(${fail?1:0});}process.exit(9);`);
 if(process.platform==='win32')fs.writeFileSync(path.join(bin,'npm.cmd'),`@"${process.execPath}" "${script}" %*\r\n`);
 else {const npm=path.join(bin,'npm');fs.writeFileSync(npm,`#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${script.replaceAll("'","'\\''")}' "$@"\n`);fs.chmodSync(npm,0o755);}
 const oldPath=process.env.PATH;process.env.PATH=bin+path.delimiter+oldPath;
 const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 try {await run({calls,pkg,root});}finally{process.env.PATH=oldPath;fs.rmSync(root,{recursive:true,force:true});}
}

test('actual updater subprocess skips a stale tag without touching the installed package',async()=>{
 await fakeNpm('0.12.8',async({calls,pkg})=>{
  const lines=[],result=await runSelfUpdate(line=>lines.push(line));
  assert.equal(result.status,'unchanged');assert.match(result.message,/No downgrade or reinstall attempted/);
  assert.deepEqual(calls(),[['view','unjailed','version']]);assert.deepEqual(lines,[]);
  assert.equal(fs.readFileSync(path.join(pkg,'original'),'utf8'),'preserve me');
 });
});

test('actual updater rejects malformed metadata without executing an installation',async()=>{
 await fakeNpm('999.0.0 && echo unsafe',async({calls})=>{
  const result=await runSelfUpdate(()=>assert.fail('No installation progress expected'));
  assert.equal(result.status,'unavailable');assert.equal(calls().length,1);
 });
});

test('actual updater uses one registry check and reports the exact successfully installed version',async()=>{
 await fakeNpm('999.0.0',async({calls,pkg})=>{
  const lines=[],result=await runSelfUpdate(line=>lines.push(line));
  assert.equal(result.status,'updated');assert.match(result.message,/Installed 999\.0\.0/);
  assert.equal(calls().filter(a=>a[0]==='view').length,1);
  assert.equal(calls().filter(a=>a[0]==='install').length,1);
  assert.equal(calls().find(a=>a[0]==='install')[2],'unjailed@999.0.0');
  assert.equal(fs.readFileSync(path.join(pkg,'new-install'),'utf8'),'unjailed@999.0.0');
  assert.ok(lines.some(s=>s.includes('Installing unjailed@999.0.0')));
 });
});

test('failed updates do not recommend @latest and restore the Windows package backup',async()=>{
 await fakeNpm('999.0.0',async({calls,pkg})=>{
  const result=await runSelfUpdate(()=>{});
  assert.equal(result.status,'failed');assert.match(result.message,/update to 999\.0\.0 failed/);
  assert.ok(!result.message.includes('npm install -g unjailed@latest'));
  assert.equal(fs.readFileSync(path.join(pkg,'original'),'utf8'),'preserve me');
  assert.equal(calls().filter(a=>a[0]==='install').length,1);
  if(process.platform==='win32')assert.ok(!fs.existsSync(path.join(pkg,'new-install')),'failed partial install moved aside before restoration');
 },{fail:true});
});

test('actual updater does not reinstall an equal npm version',async()=>{
 await fakeNpm(VERSION,async({calls})=>{
  const result=await runSelfUpdate(()=>assert.fail('Unexpected install'));
  assert.equal(result.status,'unchanged');assert.equal(calls().length,1);
 });
});

test('the real /update UI explains npm lag without an install or misleading update arrow',async()=>{
 await fakeNpm('0.12.8',async({calls,root})=>{
  const priorEnv={};for(const key of ['UNJAILED_HOME','UNJAILED_API_KEY','UNJAILED_NO_FX','NO_COLOR'])priorEnv[key]=process.env[key];
  Object.assign(process.env,{UNJAILED_HOME:path.join(root,'config'),UNJAILED_API_KEY:'sk-updater-fixture',UNJAILED_NO_FX:'1',NO_COLOR:'1'});
  const originalFetch=globalThis.fetch;
  const {default:React}=await import('react');const {render}=await import('ink-testing-library');
  const {App}=await import('../dist/ui/App.js');const {writeConfig}=await import('../dist/config.js');
  writeConfig({tools:'off',fx:false,saveSessions:false});
  globalThis.fetch=async()=>Response.json({data:[{id:'glm-5.3'}]});
  const ui=render(React.createElement(App));const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  try {
   await sleep(150);ui.stdin.write('/update');await sleep(100);ui.stdin.write('\r');
   for(let i=0;i<150&&!ui.frames.some(f=>f.includes('No downgrade or reinstall attempted'));i++)await sleep(30);
   const frames=ui.frames.join('\n');assert.match(frames,/No downgrade or reinstall attempted/);
   assert.ok(!frames.includes('Installing unjailed@'));assert.ok(!frames.includes(`Updating ${VERSION} →`));
   assert.deepEqual(calls(),[['view','unjailed','version']]);
   ui.stdin.write('still responsive');await sleep(100);assert.match(ui.lastFrame(),/still responsive/);
  }finally{
   ui.unmount();ui.cleanup();globalThis.fetch=originalFetch;
   for(const [key,value] of Object.entries(priorEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 });
});
