import os, sys, pty, select, subprocess, tempfile, threading, json, time, re, shlex
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

entry = Path(sys.argv[1]).resolve()
receipt_path = Path(sys.argv[2])
root = Path(tempfile.mkdtemp(prefix='unjailed-permission-pty-'))
home = root / 'config'
home.mkdir()
config = home / 'config.json'
config.write_text(json.dumps({'tools':'read','autoMode':'ask','fx':False,'saveSessions':False}))
script = root / 'Desktop' / 'calculator' / 'sum.py'
content = 'a = float(input("a: "))\nb = float(input("b: "))\nprint(a + b)\n'
command = "printf '2\\n3\\n' | python3 " + shlex.quote(str(script))
requests = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        payload = json.dumps({'data':[{'id':'glm-5.3-abliterated'}]}).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(payload)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        assert any(tool['function']['name']=='write_file' for tool in body.get('tools',[])), 'unexpected tool-free planning request'
        assert not any('Before doing anything: reply with ONLY a short numbered plan' in message.get('content','') for message in body['messages']), 'forced planning preamble'
        messages = body['messages']
        last = messages[-1]
        if last['role'] == 'tool':
            if last.get('tool_call_id') == 'write-calculator' and 'denied' not in last['content'].lower() and 'skipped' not in last['content'].lower() and 'declined' not in last['content'].lower() and 'cancelled' not in last['content'].lower():
                delta = {'tool_calls':[{'index':0,'id':'run-calculator','type':'function','function':{'name':'run_command','arguments':json.dumps({'command':command,'cwd':str(script.parent)})}}]}
                finish = 'tool_calls'
            else:
                delta = {'content':'Permission was denied; no changes made.' if last.get('tool_call_id') == 'write-calculator' else 'Created the Python calculator and verified 2 + 3 = 5.'}
                finish = 'stop'
        elif last['role'] == 'user' and not last['content'].startswith('Continue the original task'):
            delta = {'content':'Let me start wiring in the fix immediately:'}
            finish = 'stop'
        else:
            delta = {'tool_calls':[{'index':0,'id':'write-calculator','type':'function','function':{'name':'write_file','arguments':json.dumps({'path':str(script),'content':content})}}]}
            finish = 'tool_calls'
        payload = ('data: '+json.dumps({'choices':[{'delta':delta,'finish_reason':finish}]})+'\n\ndata: [DONE]\n\n').encode()
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers(); self.wfile.write(payload)

server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
master, slave = pty.openpty()
env = {**os.environ,'UNJAILED_HOME':str(home),'UNJAILED_API_KEY':'sk-local-permission-fixture','UNJAILED_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','UNJAILED_MODEL':'glm-5.3-abliterated','UNJAILED_NO_FX':'1','NO_COLOR':'1','TERM':'xterm-256color','COLUMNS':'110','LINES':'40'}
child = subprocess.Popen(['node',str(entry)],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root)
os.close(slave)
output = ''
def pump(seconds=.1):
    global output
    end = time.monotonic()+seconds
    while time.monotonic()<end:
        if select.select([master],[],[],min(.05,max(0,end-time.monotonic())))[0]:
            try: output += os.read(master,65536).decode(errors='replace')
            except OSError: break
def wait(predicate, label):
    end = time.monotonic()+12
    while time.monotonic()<end:
        pump()
        if predicate(): return
        if child.poll() is not None: break
    raise AssertionError(label+'\n'+re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output)[-3000:])
def send(text):
    os.write(master,text.encode()); pump(.2); os.write(master,b'\r'); pump(.3)
def config_is(tools,auto):
    value=json.loads(config.read_text()); return value['tools']==tools and value['autoMode']==auto

try:
    wait(lambda:'glm-5.3-abliterated' in output,'CLI startup')
    send('/auto')
    wait(lambda:'Choose tool permissions' in output,'permission picker visible')
    assert config_is('read','ask'), 'opening picker escalated permissions'
    os.write(master,b'\x1b'); pump(1.2)
    assert config_is('read','ask'), 'cancellation escalated permissions'
    send('/tools cmds'); wait(lambda:config_is('cmds','ask'),'confirmed tools enabled')
    start=len(output); send('Create a Desktop calculator folder and Python addition script. This is the denial receipt.')
    wait(lambda:'Waiting for permission' in output[start:],'first file approval visible')
    assert not script.exists()
    pump(.3); os.write(master,b'n')
    wait(lambda:len(requests)>=3,'denied tool result sent')
    assert not script.exists(), 'denied write created file'
    assert any('denied' in m.get('content','').lower() or 'skipped' in m.get('content','').lower() or 'declined' in m.get('content','').lower() or 'cancelled' in m.get('content','').lower() for m in requests[2]['messages'] if m['role']=='tool'), json.dumps(requests[2]['messages'][-2:])
    pump(.5)
    start=len(output); send('Create a Desktop calculator folder and Python addition script, then run it with 2 and 3.')
    wait(lambda:'Waiting for permission' in output[start:],'second file approval visible')
    assert not script.exists()
    pump(.3); start=len(output); os.write(master,b'y')
    wait(lambda:script.exists(),'approved Python file created')
    assert script.read_text()==content
    wait(lambda:len(requests)>=6,'write result returned')
    wait(lambda:'run_command' in output[start:] and 'Waiting for permission' in output[start:],'command approval reached')
    pump(.5); os.write(master,b'y')
    wait(lambda:len(requests)>=7,'approved command result returned')
    result = next(m['content'] for m in requests[-1]['messages'] if m.get('tool_call_id')=='run-calculator' and m['role']=='tool')
    assert '5' in result and 'Exit code: 0' in result, result
    wait(lambda:'Created the Python calculator' in output,'completion rendered')
    receipt = {'version':json.loads((entry.parent.parent/'package.json').read_text())['version'],'hostPlatform':sys.platform,'realTerminal':True,'localMockModelOnly':True,'permissionPickerVisible':True,'pickerCancellationRetainsReadOnly':True,'deniedWriteCreatedFile':False,'fileAndCommandRequiredSeparateApprovals':True,'pythonProgramOutput':result,'pythonInput':[2,3],'customerMutations':0,'windowsPhysicalDeviceTested':False,'actionPromiseRecovered':True,'noDefaultPlanningRequest':True,'model':'glm-5.3-abliterated'}
    receipt_path.parent.mkdir(parents=True,exist_ok=True)
    receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))
finally:
    child.terminate()
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    os.close(master);server.shutdown()
    import shutil
    shutil.rmtree(root)
