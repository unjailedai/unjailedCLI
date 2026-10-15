import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {agentTurn,ReasoningTimeoutError} from '../dist/api.js';
import {toolDefinitions} from '../dist/tools.js';

const event=(delta,finish_reason=null)=>'data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n';
const tool=(id,name,args,reason='Reasoning for '+id)=>event({reasoning_content:reason})+event({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args)}}]},'tool_calls')+'data: [DONE]\n\n';
function stall(res,delta={reasoning_content:'Still reasoning'}){
 res.write(event(delta));const timer=setInterval(()=>res.write(': heartbeat\n\n'),20);res.on('close',()=>clearInterval(timer));
}
async function fixture(replies,run){
 const requests=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.writeHead(200,{'content-type':'text/event-stream'});const reply=replies[requests.length-1];if(typeof reply==='function')reply(res);else res.end(reply??event({content:'Unexpected request'},'stop'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run(`http://127.0.0.1:${server.address().port}`,requests);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const options=execute=>({tools:toolDefinitions('cmds'),effort:'medium',reasoningTimeoutMs:180,responseTimeoutMs:2000,execute});

test('later-round reasoning stall continues from both command results, preserves preamble, and suppresses replay during recovery',async()=>{
 const inspect={command:'node --version'},check={command:'node -p "2+3"'};
 const recovered=tool('repeat','run_command',check,'Recovery reasoning').replace('data: [DONE]\n\n','')+
  event({tool_calls:[{index:1,id:'write',function:{name:'write_file',arguments:'{"path":"add.py","content":"print(5)"}'}}]},'tool_calls')+'data: [DONE]\n\n';
 await fixture([
  tool('inspect','run_command',inspect,'First exact trace\n  spaces'),tool('check','run_command',check),
  res=>{res.write(event({content:'Let me check the environment first.'}));stall(res);},
  recovered,tool('verify','read_file',{path:'add.py'}),event({content:'Created and verified add.py.'},'stop'),
 ],async(base,requests)=>{
  const executed=[],recoveries=[],history=[{role:'user',content:'Create a calculator and verify it'}];
  const final=await agentTurn(base,'fake','glm-5.3-abliterated',history,{onToken(){},onRecovery:m=>recoveries.push(m)},new AbortController().signal,options(async(name,args)=>{executed.push({name,args});return{ok:true,output:name==='run_command'?'checked successfully':'print(5)'};}));
  assert.equal(final,'Created and verified add.py.');assert.equal(requests.length,6);assert.equal(recoveries.length,1);
  assert.deepEqual(executed.map(x=>x.name),['run_command','run_command','write_file','read_file']);
  assert.ok(requests[3].messages.some(m=>m.role==='assistant'&&m.content==='Let me check the environment first.'));
  for(const id of ['inspect','check'])assert.ok(requests[3].messages.some(m=>m.role==='tool'&&m.tool_call_id===id));
  assert.equal(requests[3].reasoning_effort,'low');assert.equal(requests[3].max_tokens,8192);
  assert.equal(requests[4].reasoning_effort,'medium');assert.equal(requests[4].max_tokens,undefined);
  assert.match(history.find(m=>m.role==='tool'&&m.tool_call_id==='repeat').content,/not executed again/);
  assert.equal(requests[1].messages.find(m=>m.tool_calls)?.reasoning_content,'First exact trace\n  spaces');
  assert.equal(requests[1].chat_template_kwargs.clear_thinking,false);
  assert.equal(requests[4].messages.find(m=>m.tool_calls?.some(c=>c.id==='write'))?.reasoning_content,'Recovery reasoning');
  assert.ok(!JSON.stringify(history).includes('First exact trace')); // transient, never persisted
 });
});

test('persistent stalls get one recovery for the whole task and then stop',async()=>{
 await fixture([res=>stall(res),res=>stall(res)],async(base,requests)=>{
  let actions=0,recoveries=0;
  await assert.rejects(agentTurn(base,'fake','glm-5.3-abliterated',[{role:'user',content:'Create a calculator'}],{onToken(){},onRecovery(){recoveries++;}},new AbortController().signal,options(async()=>{actions++;return{ok:true,output:'unexpected'};})),error=>error instanceof ReasoningTimeoutError && /again after one low-effort recovery/.test(error.message));
  assert.equal(requests.length,2);assert.equal(recoveries,1);assert.equal(actions,0);
 });
});

test('a follow-up without action keywords recovers after tools have actually run in that turn',async()=>{
 await fixture([tool('inspect','read_file',{path:'a'}),res=>stall(res),event({content:'The issue is explained by the inspected file.'},'stop')],async(base,requests)=>{
  let actions=0,recoveries=0;const history=[{role:'user',content:'Nothing happens when I press the button.'}];
  const final=await agentTurn(base,'fake','glm-5.3-abliterated',history,{onToken(){},onRecovery(){recoveries++;}},new AbortController().signal,options(async()=>{actions++;return{ok:true,output:'Existing file inspected'};}));
  assert.equal(actions,1);assert.equal(recoveries,1);assert.equal(requests.length,3);assert.equal(final,'The issue is explained by the inspected file.');assert.ok(requests[2].messages.some(m=>m.role==='tool'&&m.tool_call_id==='inspect'));
 });
});

test('non-keyword follow-ups recover a later promise to act once actual tool work has begun',async()=>{
 await fixture([tool('inspect','read_file',{path:'a'}),event({content:"Let me check the next file."},'stop'),event({content:'The next file is not needed; the issue is already identified.'},'stop')],async(base,requests)=>{
  let recoveries=0;
  await agentTurn(base,'fake','glm-5.3-abliterated',[{role:'user',content:'Nothing happens when I press the button.'}],{onToken(){},onRecovery(){recoveries++;}},new AbortController().signal,options(async()=>({ok:true,output:'Evidence read'})));
  assert.equal(recoveries,1);assert.equal(requests.length,3);
 });
});

test('partial tool calls, denied permissions, and user abort never trigger stalled-task recovery',async()=>{
 for(const mode of ['partial','denied','abort']){
  const ctrl=new AbortController();let actions=0;
  const replies=mode==='denied'?[tool('denied','write_file',{path:'a',content:'x'}),res=>stall(res)]:[res=>{stall(res,mode==='partial'?{tool_calls:[{index:0,function:{name:'write_file',arguments:'{"path":'}}]}:{reasoning_content:'thinking'});}];
  await fixture(replies,async(base,requests)=>{
   await assert.rejects(agentTurn(base,'fake','glm-5.3-abliterated',[{role:'user',content:'Create a file'}],{onToken(){},onRecovery(){if(mode==='abort')ctrl.abort();else assert.fail('Unexpected recovery');}},ctrl.signal,options(async()=>{actions++;return{ok:false,output:'User declined approval. Nothing executed.'};})));
   assert.equal(requests.length,mode==='denied'?2:1);assert.equal(actions,mode==='denied'?1:0);
  });
 }
});

test('no tool access or non-action questions do not trigger task recovery',async()=>{
 for(const config of [{task:'Explain recursion',tools:toolDefinitions('cmds')},{task:'Create a calculator',tools:[]}])await fixture([res=>stall(res)],async(base,requests)=>{
  await assert.rejects(agentTurn(base,'fake','glm-5.3-abliterated',[{role:'user',content:config.task}],{onToken(){},onRecovery(){assert.fail('Unexpected recovery');}},new AbortController().signal,{...options(async()=>assert.fail()),tools:config.tools}),ReasoningTimeoutError);assert.equal(requests.length,1);
 });
});

test('reasoning traces are GLM-only, whole-chain bounded, task-scoped and absent after session restore',async()=>{
 for(const [model,reason] of [['glm-5.3-abliterated','x'.repeat(30001)],['deepseek-v4-pro','private trace']])await fixture([tool('one','read_file',{path:'a'},reason),event({content:'Read it.'},'stop')],async(base,requests)=>{
  const history=[{role:'user',content:'Read file a'}];await agentTurn(base,'fake',model,history,{onToken(){}},new AbortController().signal,options(async()=>({ok:true,output:'content'})));
  assert.ok(!requests[1].messages.some(m=>'reasoning_content'in m));assert.ok(!JSON.stringify(history).includes(reason));
  if(model.startsWith('glm'))assert.equal(requests[1].chat_template_kwargs.clear_thinking,true);
  else assert.equal(requests[1].chat_template_kwargs,undefined);
 });
 await fixture([tool('one','read_file',{path:'a'},'private trace'),event({content:'Read it.'},'stop'),event({content:'Restored.'},'stop'),event({content:'New task.'},'stop')],async(base,requests)=>{
  const history=[{role:'user',content:'Read file a'}];const run=h=>agentTurn(base,'fake','glm-5.3-abliterated',h,{onToken(){}},new AbortController().signal,options(async()=>({ok:true,output:'content'})));
  await run(history);assert.equal(requests[1].chat_template_kwargs.clear_thinking,false);
  await run(JSON.parse(JSON.stringify(history)));assert.equal(requests[2].chat_template_kwargs.clear_thinking,true);
  history.push({role:'user',content:'What is 2+3?'});await run(history);assert.ok(!requests[3].messages.some(m=>'reasoning_content'in m));
 });
});

test('transport retry discards the failed reasoning trace before preserving the completed trace',async()=>{
 await fixture([event({reasoning_content:'Discard this trace'})+'data: '+JSON.stringify({error:{code:'stream_interrupted',message:'Disconnected'}})+'\n\n',tool('one','read_file',{path:'a'},'Keep only this trace'),event({content:'Read it.'},'stop')],async(base,requests)=>{
  await agentTurn(base,'fake','glm-5.3-abliterated',[{role:'user',content:'Read file a'}],{onToken(){}},new AbortController().signal,options(async()=>({ok:true,output:'content'})));
  assert.equal(requests.length,3);assert.equal(requests[2].messages.find(m=>m.tool_calls)?.reasoning_content,'Keep only this trace');
 });
});
