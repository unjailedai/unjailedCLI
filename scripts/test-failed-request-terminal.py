"""Actual terminal failure/save/restart/continue; harmless project, local SSE only."""
import json,os,pty,re,select,shutil,subprocess,sys,tempfile,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
entry=Path(sys.argv[1]).resolve();receipt_path=Path(sys.argv[2]);baseline='--baseline' in sys.argv[3:];fresh='--fresh' in sys.argv[3:]
root=Path(tempfile.mkdtemp(prefix='unjailed-failed-intent-'));home=root/'config';sessions=home/'sessions';sessions.mkdir(parents=True)
(home/'config.json').write_text(json.dumps({'tools':'cmds','autoMode':'auto','effort':'medium','fx':False,'saveSessions':True,'plan':False}))
(root/'calculator.py').write_text('print(2 + 3)\n');task='Instead create README.md explaining calculator usage. Do not change calculator.py.'
now=int(time.time()*1000);ident='20261015100000-intentfixture'
if not fresh:(sessions/(ident+'.json')).write_text(json.dumps({'id':ident,'title':'Calculator follow-up','cwd':str(root),'model':'glm-5.3-abliterated','created':now,'updated':now,'messages':[{'role':'user','content':'Create a calculator with a UI.'},{'role':'assistant','content':'The calculator exists; its UI still needs work.'}],'toolHistory':[]}))
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
   if n<=2:
    for _ in range(40):self.wfile.write(frame({'reasoning_content':'No usable model progress'}));self.wfile.flush();time.sleep(.1)
    return
   retained=any(m.get('role')=='user' and m.get('content')==task for m in body['messages'])
   if not retained:delta={'content':'The latest instruction was lost.'};finish='stop'
   elif n==3:delta=tool('inspect','read_file',{'path':str(root/'calculator.py')});finish='tool_calls'
   elif n==4:delta=tool('write','write_file',{'path':str(root/'README.md'),'content':'Run python3 calculator.py to print 5.\n'});finish='tool_calls'
   else:delta={'content':'The requested README is saved.'};finish='stop'
   self.wfile.write(frame(delta,finish));self.wfile.write(b'data: [DONE]\n\n')
  except (BrokenPipeError,ConnectionResetError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
env={**os.environ,'UNJAILED_HOME':str(home),'UNJAILED_API_KEY':'sk-local-intent-fixture','UNJAILED_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','UNJAILED_MODEL':'glm-5.3-abliterated','UNJAILED_REASONING_TIMEOUT':'1','UNJAILED_RESPONSE_TIMEOUT':'10','UNJAILED_NO_FX':'1','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'110','LINES':'40'}
child=None;master=None;output=''
def launch():
 global child,master,output
 master,slave=pty.openpty();output='';child=subprocess.Popen(['node',str(entry),'-c'],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root);os.close(slave)
def wait(predicate,label):
 global output
 end=time.monotonic()+15
 while time.monotonic()<end:
  if select.select([master],[],[],.05)[0]:
   try:output+=os.read(master,65536).decode(errors='replace')
   except OSError:break
  if predicate():return
  if child.poll() is not None:break
 raise AssertionError(label+'\n'+re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output)[-2000:])
def stop():
 global child,master
 if child:
  child.terminate()
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait()
  child=None
 if master is not None:os.close(master);master=None
try:
 launch();wait(lambda:('Logged in' if fresh else 'Resumed') in output,'initial session');os.write(master,task.encode());time.sleep(.2);os.write(master,b'\r')
 wait(lambda:'stalled again after one low-effort recovery' in output,'persistent stall surfaced')
 # This marker is printed after performChat has awaited session persistence.
 wait(lambda:'Message Unjailed' in output,'saved request returned to prompt');time.sleep(.2)
 saved=''.join(p.read_text() for p in sessions.glob('*.jsonl'))
 retained=task in saved;assert retained is (not baseline),'failed intent persistence'
 stop();launch();wait(lambda:'Resumed' in output,'resume after actual restart');os.write(master,b'continue');time.sleep(.2);os.write(master,b'\r')
 wait(lambda:('latest instruction was lost' if baseline else 'requested README is saved') in output,'continuation followed latest intent')
 assert any(m.get('content')==task for m in requests[2]['messages']) is (not baseline)
 assert (root/'README.md').exists() is (not baseline)
 assert (root/'calculator.py').read_text()=='print(2 + 3)\n'
 if not baseline:assert (root/'README.md').read_text()=='Run python3 calculator.py to print 5.\n'
 receipt={'version':json.loads((entry.parent.parent/'package.json').read_text())['version'],'realTerminal':True,'freshSession':fresh,'localMockModelOnly':True,'originalAndRecoveryBothStalled':True,'failedInstructionSaved':retained,'restartAndContinueRetainedLatestRequest':not baseline,'readmeActuallyCreated':not baseline,'originalCalculatorUnchanged':True,'requests':len(requests),'customerMutations':0}
 receipt_path.parent.mkdir(parents=True,exist_ok=True);receipt_path.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
finally:stop();server.shutdown();shutil.rmtree(root)
