import test from 'node:test';
import assert from 'node:assert/strict';
import {streamChatRetry,agentTurn} from '../dist/api.js';
import {toolDefinitions} from '../dist/tools.js';
const chunk=delta=>'data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\n';
const failure=(error={message:'The model stream was interrupted. Retry to continue.'})=>'data: '+JSON.stringify({error})+'\n\n';
function sse(text){return new Response(text,{headers:{'content-type':'text/event-stream'}});}
async function run(replies,check){const original=globalThis.fetch;const requests=[];
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));if(requests.length>replies.length)throw Error('Unexpected retry');return sse(replies[requests.length-1]);};
 try{await check(requests);}finally{globalThis.fetch=original;}
}
test('known stream interruption before answer/tools retries once and executes only the recovered tool',async()=>{
 await run([chunk({reasoning_content:'thinking'})+failure(),chunk({tool_calls:[{index:0,id:'create',function:{name:'write_file',arguments:'{"path":"a.py","content":"print(5)"}'}}]})+'data: [DONE]\n\n',chunk({content:'Created the file.'})+'data: [DONE]\n\n'],async requests=>{
  let executed=0,retries=0,text='';const history=[{role:'user',content:'Create a calculator file'}];
  await agentTurn('https://fixture.invalid/v1','fake','glm-5.3-abliterated',history,{onToken:t=>text+=t,onRetry:()=>retries++},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async(name,args)=>{executed++;assert.equal(name,'write_file');assert.equal(args.path,'a.py');return{ok:true,output:'Created a.py'};}});
  assert.equal(requests.length,3);assert.equal(retries,1);assert.equal(executed,1);assert.equal(text,'Created the file.');assert.deepEqual(requests[0].messages,requests[1].messages);assert.ok(!JSON.stringify(history).includes('retrying'));
 });
});
test('persistent early interruptions stop after one retry, with no fake answer text',async()=>{
 await run([failure(),failure()],async requests=>{let text='';await assert.rejects(streamChatRetry('https://fixture.invalid/v1','fake','m',[],{onToken:t=>text+=t},new AbortController().signal),/stream was interrupted/);assert.equal(requests.length,2);assert.equal(text,'');});
});
test('answer or partial tool-call progress prevents replay; incomplete calls never execute',async()=>{
 for(const delta of [{content:'Starting the change.'},{tool_calls:[{index:0,id:'partial',function:{name:'write_file',arguments:'{"path":'}}]},{tool_calls:[{index:0}]}])await run([chunk(delta)+failure()],async requests=>{
  let executed=0;await assert.rejects(agentTurn('https://fixture.invalid/v1','fake','m',[{role:'user',content:'Create a file'}],{onToken(){}},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async()=>{executed++;return{ok:true,output:'must not run'};}}),/stream was interrupted/);assert.equal(requests.length,1);assert.equal(executed,0);
 });
});
test('unknown, authorization and policy SSE errors are never retried',async()=>{
 for(const error of [{message:'Forbidden',code:'auth_failed'},{message:'Blocked',code:'request_blocked'},{message:'Some other provider error'}])await run([failure(error)],async requests=>{await assert.rejects(streamChatRetry('https://fixture.invalid/v1','fake','m',[],{onToken(){}},new AbortController().signal));assert.equal(requests.length,1);});
});
test('abort while waiting for retry prevents another network request',async()=>{
 await run([failure()],async requests=>{const ctrl=new AbortController();await assert.rejects(streamChatRetry('https://fixture.invalid/v1','fake','m',[],{onToken(){},onRetry:()=>ctrl.abort()},ctrl.signal));assert.equal(requests.length,1);});
});

test('recovery after an already completed tool reuses its result and never runs it twice',async()=>{
 const tool=chunk({tool_calls:[{index:0,id:'already-created',function:{name:'write_file',arguments:'{"path":"result.txt","content":"done"}'}}]})+'data: [DONE]\n\n';
 await run([tool,failure(),chunk({content:'Created and verified the file.'})+'data: [DONE]\n\n'],async requests=>{
  let executed=0;
  await agentTurn('https://fixture.invalid/v1','fake','glm-5.3-abliterated',[{role:'user',content:'Create a result file'}],{onToken(){}},new AbortController().signal,{tools:toolDefinitions('cmds'),execute:async()=>{executed++;return{ok:true,output:'File already created successfully'};}});
  assert.equal(executed,1);assert.equal(requests.length,3);assert.deepEqual(requests[1].messages,requests[2].messages);assert.ok(requests[2].messages.some(m=>m.role==='tool'&&m.tool_call_id==='already-created'));
 });
});

test('terminal marker prevents replay even without answer text',async()=>{
 await run(['data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+failure()],async requests=>{await assert.rejects(streamChatRetry('https://fixture.invalid/v1','fake','m',[],{onToken(){}},new AbortController().signal));assert.equal(requests.length,1);});
});
