import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolDraftBuffer} from '../dist/ui/tool-draft.js';
import {streamChat} from '../dist/api.js';

test('incomplete JSON tool strings decode incrementally with Windows paths, escapes and unicode',()=>{
 const args=JSON.stringify({path:'C:\\Users\\User\\Desktop\\a.java',content:'class A {\n\tString x = "hello"; // 😃\n}\n'}).replace('😃','\\ud83d\\ude03');
 for(const size of [1,3,40,args.length]){
  const buffer=new ToolDraftBuffer(0);
  for(let i=0;i<args.length;i+=size)buffer.append('write_file',args.slice(i,i+size));
  const draft=buffer.snapshot();assert.equal(draft.target,'C:\\Users\\User\\Desktop\\a.java');assert.equal(draft.preview,'class A {\n\tString x = "hello"; // 😃\n}\n');assert.equal(buffer.scannedCharacters,args.length);
 }
 const incomplete=new ToolDraftBuffer(1);incomplete.append('write_file','{"path":"src/main.js","content":"const live = 1;\\n');
 assert.equal(incomplete.snapshot().preview,'const live = 1;\n');assert.equal(incomplete.snapshot().target,'src/main.js');
});

test('large drafts keep only a bounded tail, ignore nested/unrelated fields and strip terminal controls',()=>{
 const text='x'.repeat(300000)+'\nlast line';const buffer=new ToolDraftBuffer(0),args=JSON.stringify({nested:{content:'do not display nested data'},path:'a\u001b]0;title\u0007.js',old_text:'old hidden text',new_text:text+'\u001b[31m\u0000'});
 buffer.append('edit_file',args);const draft=buffer.snapshot();assert.ok(draft.preview.length<=2400);assert.ok(draft.preview.includes('last line'));assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(draft.preview+draft.target));assert.ok(!draft.preview.includes('nested data'));assert.equal(draft.characters,text.length+6);assert.equal(buffer.scannedCharacters,args.length);
});

test('actual API parser emits tool fragments before completion and never treats them as assistant tokens',async()=>{
 const original=globalThis.fetch,updates=[],tokens=[];let controller;const encoder=new TextEncoder();
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}});
 const send=delta=>controller.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\n'));
 try{
  let finished=false;
  const pending=streamChat('https://fixture.invalid/v1','fake','glm-5.3',[],{onToken:t=>tokens.push(t),onToolDelta:d=>updates.push(d)},new AbortController().signal).then(r=>{finished=true;return r;});
  while(!controller)await new Promise(r=>setImmediate(r));
  send({tool_calls:[{index:0,id:'a',function:{name:'write_',arguments:'{"path":"a.js","content":"const a'}}]});
  send({tool_calls:[{index:0,function:{name:'file',arguments:' = 1;"}'}}]});
  await new Promise(r=>setTimeout(r,30));assert.equal(finished,false);assert.equal(updates.length,2);assert.equal(updates[1].name,'write_file');assert.equal(updates[1].argumentsDelta,' = 1;"}');assert.deepEqual(tokens,[]);
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();const result=await pending;assert.equal(JSON.parse(result.toolCalls[0].args).content,'const a = 1;');
 }finally{globalThis.fetch=original;}
});
