"""Real saved-session continuation, harmless files, and local mock SSE only."""
import json, os, pty, re, select, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
entry=Path(sys.argv[1]).resolve();receipt_path=Path(sys.argv[2]);baseline='--baseline' in sys.argv[3:]
root=Path(tempfile.mkdtemp(prefix='unjailed-resume-pty-'));home=root/'config';sessions=home/'sessions';sessions.mkdir(parents=True)
(home/'config.json').write_text(json.dumps({'tools':'cmds','autoMode':'auto','effort':'medium','fx':False,'saveSessions':True,'plan':False}))
(root/'calculator.py').write_text('print(2 + 3)\n')
now=int(time.time()*1000);ident='20261015100000-resumefixture'
(sessions/(ident+'.json')).write_text(json.dumps({'id':ident,'title':'Calculator follow-up','cwd':str(root),'model':'glm-5.3-abliterated','created':now,'updated':now,'messages':[{'role':'user','content':'Create a calculator and explain it in README.md.'},{'role':'assistant','content':'The calculator exists; the README still needs to be added.'}],'toolHistory':[]}))
requests=[]
def frame(delta,finish=None):return ('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':finish}]})+'\n\n').encode()
def tool(ident,name,args):return {'tool_calls':[{'index':0,'id':ident,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"data":[{"id":"glm-5.3-abliterated"}]}')
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body);n=len(requests)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  try:
   if n==1:
    for _ in range(40):self.wfile.write(frame({'reasoning_content':'No answer or tool progress'}));self.wfile.flush();time.sleep(.1)
    return
   if n==2:delta=tool('inspect','read_file',{'path':str(root/'calculator.py')});finish='tool_calls'
   elif n==3:delta=tool('write','write_file',{'path':str(root/'README.md'),'content':'Run python3 calculator.py to print 5.\n'});finish='tool_calls'
   else:delta={'content':'The calculator README is now saved.'};finish='stop'
   self.wfile.write(frame(delta,finish));self.wfile.write(b'data: [DONE]\n\n')
  except (BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
master,slave=pty.openpty();env={**os.environ,'UNJAILED_HOME':str(home),'UNJAILED_API_KEY':'sk-local-resume-fixture','UNJAILED_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','UNJAILED_MODEL':'glm-5.3-abliterated','UNJAILED_REASONING_TIMEOUT':'1','UNJAILED_RESPONSE_TIMEOUT':'10','UNJAILED_NO_FX':'1','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'110','LINES':'40'}
child=subprocess.Popen(['node',str(entry),'-c'],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root);os.close(slave);output=''
def wait(predicate,label):
 global output
 end=time.monotonic()+12
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:output+=os.read(master,65536).decode(errors='replace')
   except OSError:break
  if predicate():return
  if child.poll() is not None:break
 raise AssertionError(label+'\n'+re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output)[-2500:])
try:
 wait(lambda:'Resumed' in output,'saved chat resumed');os.write(master,b'keep going');time.sleep(.2);os.write(master,b'\r')
 wait(lambda:'reasoning deadline' in output if baseline else 'The calculator README is now saved.' in output,'baseline stop' if baseline else 'continued saved task')
 assert any(m['role']=='user' and m['content']=='keep going' for m in requests[0]['messages'])
 assert any('README still needs' in m.get('content','') for m in requests[0]['messages'])
 completed=(root/'README.md').exists();recovered=any('timed out before completing' in m.get('content','') for b in requests[1:] for m in b['messages'])
 assert completed is (not baseline);assert recovered is (not baseline);assert len(requests)==(1 if baseline else 4)
 if not baseline:
  assert requests[1]['reasoning_effort']=='low'
  assert (root/'README.md').read_text()=='Run python3 calculator.py to print 5.\n'
  assert 'retrying once at low effort' in re.sub(r'\s+',' ',output)
  wait(lambda: any('keep going' in f.read_text() for f in sessions.glob('*.jsonl')),'continued session saved')
 receipt={'version':json.loads((entry.parent.parent/'package.json').read_text())['version'],'realTerminal':True,'realSavedSessionRestored':True,'localMockModelOnly':True,'platform':sys.platform,'followup':'keep going','timeoutBeforeFirstTool':True,'recoveryAttempted':recovered,'readmeActuallyCreated':completed,'requests':len(requests),'priorCalculatorPreserved':(root/'calculator.py').read_text()=='print(2 + 3)\n','customerMutations':0}
 receipt_path.parent.mkdir(parents=True,exist_ok=True);receipt_path.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
finally:
 child.terminate()
 try:child.wait(timeout=3)
 except subprocess.TimeoutExpired:child.kill();child.wait()
 os.close(master);server.shutdown();shutil.rmtree(root)
