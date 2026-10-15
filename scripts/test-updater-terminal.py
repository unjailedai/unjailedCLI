"""Real Linux terminal /update check with a fake npm; never installs a package."""
import json, os, pty, re, select, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
entry=Path(sys.argv[1]).resolve();receipt_path=Path(sys.argv[2])
root=Path(tempfile.mkdtemp(prefix='unjailed-update-pty-'));home=root/'config';home.mkdir();bin_dir=root/'bin';bin_dir.mkdir();log=root/'npm-calls.jsonl'
(home/'config.json').write_text(json.dumps({'fx':False,'saveSessions':False,'tools':'off'}))
fake=bin_dir/'npm'
fake.write_text('#!'+sys.executable+'\nimport json,sys\nwith open('+repr(str(log))+',"a") as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nif sys.argv[1:]==["view","unjailed","version"]:print("0.12.8")\nelse:sys.exit(91)\n');fake.chmod(0o755)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'{"data":[{"id":"glm-5.3"}]}')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
master,slave=pty.openpty();env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],'UNJAILED_HOME':str(home),'UNJAILED_API_KEY':'sk-local-updater-fixture','UNJAILED_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','UNJAILED_MODEL':'glm-5.3','UNJAILED_NO_FX':'1','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'110','LINES':'40'}
child=subprocess.Popen(['node',str(entry)],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root);os.close(slave);output=''
def wait(predicate,label):
 global output
 deadline=time.monotonic()+12
 while time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:output+=os.read(master,65536).decode(errors='replace')
   except OSError:break
  if predicate():return
  if child.poll() is not None:break
 raise AssertionError(label+'\n'+output[-2500:])
try:
 wait(lambda:'glm-5.3' in output,'startup');os.write(master,b'/update');time.sleep(.15);os.write(master,b'\r')
 wait(lambda:re.search(r'No downgrade or reinstall\s+attempted',output) is not None,'safe npm lag explanation')
 assert [json.loads(x) for x in log.read_text().splitlines()]==[['view','unjailed','version']]
 assert 'Installing unjailed@' not in output and 'Updating 0.' not in output and 'DEP0190' not in output
 os.write(master,b'still responsive');wait(lambda:'still responsive' in output,'prompt remains editable')
 receipt={'version':json.loads((entry.parent.parent/'package.json').read_text())['version'],'realTerminal':True,'platform':sys.platform,'fakeNpmOnly':True,'oneRegistryCheck':True,'staleNpmSkipped':True,'installCommands':0,'misleadingUpdateArrow':False,'shellDeprecationWarning':False,'promptRemainedEditable':True,'customerMutations':0}
 receipt_path.parent.mkdir(parents=True,exist_ok=True);receipt_path.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
finally:
 child.terminate()
 try:child.wait(timeout=3)
 except subprocess.TimeoutExpired:child.kill();child.wait()
 os.close(master);server.shutdown();shutil.rmtree(root)
