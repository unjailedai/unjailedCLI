"""Actual CLI terminal: three completed tools, silence, then slow live reasoning.
Only a local synthetic model and disposable calculator files are used.
"""
import json,os,pty,re,select,shutil,subprocess,sys,tempfile,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
entry=Path(sys.argv[1]).resolve();receipt_path=Path(sys.argv[2]);baseline='--baseline' in sys.argv[3:]
root=Path(tempfile.mkdtemp(prefix='uj-active-recovery-'));home=root/'config';home.mkdir()
(home/'config.json').write_text(json.dumps({'tools':'cmds','autoMode':'auto','effort':'medium','fx':False,'saveSessions':False,'plan':False}))
(root/'calculator.py').write_text('print(2+3)\n');(root/'package.json').write_text('{"private":true}\n');requests=[]
def frame(delta,finish=None):return ('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':finish}]})+'\n\n').encode()
def call(index,ident,name,args):return {'index':index,'id':ident,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):self.send_response(200);self.end_headers();self.wfile.write(b'{"data":[{"id":"glm-5.3-flash-abliterated"}]}')
 def do_POST(self):
  requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))));n=len(requests)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  try:
   if n==1:
    self.wfile.write(frame({'tool_calls':[call(0,'read','read_file',{'path':'calculator.py'}),call(1,'manifest','read_file',{'path':'package.json'}),call(2,'verify','run_command',{'command':'node -p "2+3"'})]},'tool_calls'))
   elif n==2:
    for _ in range(40):self.wfile.write(b': heartbeat\n\n');self.wfile.flush();time.sleep(.1)
    return
   elif n==3:
    for _ in range(20):self.wfile.write(frame({'reasoning_content':'Checking the fixture before the requested file change.'}));self.wfile.flush();time.sleep(.1)
    self.wfile.write(frame({'tool_calls':[call(0,'write','write_file',{'path':'README.md','content':'Run python3 calculator.py.\n'})]},'tool_calls'))
   else:self.wfile.write(frame({'content':'The requested README is now saved.'},'stop'))
   self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
master,slave=pty.openpty();env={**os.environ,'UNJAILED_HOME':str(home),'UNJAILED_API_KEY':'sk-local-active-fixture','UNJAILED_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','UNJAILED_MODEL':'glm-5.3-flash-abliterated','UNJAILED_REASONING_TIMEOUT':'1','UNJAILED_RESPONSE_TIMEOUT':'10','UNJAILED_NO_FX':'1','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'110','LINES':'40'}
child=subprocess.Popen(['node',str(entry)],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root);os.close(slave);output=''
def wait(predicate,label):
 global output
 end=time.monotonic()+16
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:output+=os.read(master,65536).decode(errors='replace')
   except OSError:break
  if predicate():return
  if child.poll() is not None:break
 raise AssertionError(label+'\n'+re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output)[-2000:])
try:
 wait(lambda:'glm-5.3-flash-abliterated' in output,'startup');os.write(master,b'Read the calculator and manifest, verify 2+3, then create README.md.');time.sleep(.2);os.write(master,b'\r')
 wait(lambda:('stalled again after one low-effort recovery' if baseline else 'requested README is now saved') in output,'baseline failure' if baseline else 'active recovery completed')
 assert len(requests)==(3 if baseline else 4)
 assert 'Step 3' in output and 'Model stalled' in output
 assert (root/'README.md').exists() is (not baseline)
 if not baseline:assert (root/'README.md').read_text()=='Run python3 calculator.py.\n'
 assert (root/'calculator.py').read_text()=='print(2+3)\n'
 result={'version':json.loads((entry.parent.parent/'package.json').read_text())['version'],'realTerminal':True,'localMockModelOnly':True,'completedToolsBeforeStall':3,'silenceLimitSeconds':1,'recoveryReasoningSeconds':2,'responseLimitSeconds':10,'activeRecoveryCompleted':not baseline,'readmeActuallyCreated':not baseline,'calculatorUnchanged':True,'apiRequests':len(requests),'customerMutations':0,'physicalWindowsDeviceTested':False}
 receipt_path.parent.mkdir(parents=True,exist_ok=True);receipt_path.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:
 child.terminate()
 try:child.wait(timeout=3)
 except subprocess.TimeoutExpired:child.kill();child.wait()
 os.close(master);server.shutdown();shutil.rmtree(root)
