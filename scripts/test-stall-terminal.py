"""Exercise real terminal recovery after two completed commands, using local SSE."""
import json, os, pty, re, select, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

entry = Path(sys.argv[1]).resolve()
receipt_path = Path(sys.argv[2])
root = Path(tempfile.mkdtemp(prefix='unjailed-stall-pty-'))
home = root / 'config'
home.mkdir()
(home / 'config.json').write_text(json.dumps({'tools': 'cmds', 'autoMode': 'auto', 'fx': False, 'saveSessions': False, 'plan': True}))
command = 'node -e "require(\'node:fs\').appendFileSync(\'executions.txt\',\'x\'); console.log(5)"'
requests = []
release_draft = threading.Event()

def frame(delta, finish=None):
    return ('data: ' + json.dumps({'choices': [{'delta': delta, 'finish_reason': finish}]}) + '\n\n').encode()

def call(index, ident, name, args):
    return {'index': index, 'id': ident, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'glm-5.3-abliterated'}]}).encode())
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        n = len(requests)
        try:
            if n == 3:
                self.wfile.write(frame({'content': 'Let me check the environment first.'})); self.wfile.flush()
                for _ in range(30):
                    self.wfile.write(frame({'reasoning_content': 'Thinking without tool progress'})); self.wfile.flush(); time.sleep(.1)
                return
            if n in [1, 2, 4]:
                calls = [call(0, 'inspect', 'run_command', {'command': 'node --version'})] if n == 1 else [call(0, 'checked', 'run_command', {'command': command})] if n == 2 else [call(0, 'duplicate', 'run_command', {'command': command}), call(1, 'write', 'write_file', {'path': 'result.txt', 'content': 'verified 5\n'})]
                self.wfile.write(frame({'reasoning_content': 'Complete reasoning for round ' + str(n)}))
                if n == 4:
                    self.wfile.write(frame({'tool_calls': [calls[0], {'index': 1, 'id': 'write', 'type': 'function', 'function': {'name': 'write_file'}}]}))
                    # A genuinely unfinished JSON string: the real CLI must show
                    # received text while leaving the target file absent.
                    self.wfile.write(frame({'tool_calls': [{'index': 1, 'function': {'arguments': '{"path":"result.txt","content":"verified 5\\n'}}]}))
                    self.wfile.flush()
                    if not release_draft.wait(12): raise AssertionError('preview was never acknowledged')
                    self.wfile.write(frame({'tool_calls': [{'index': 1, 'function': {'arguments': '"}'}}]}, 'tool_calls'))
                else:
                    self.wfile.write(frame({'tool_calls': calls}, 'tool_calls'))
            else:
                self.wfile.write(frame({'content': 'Finished and verified the calculator.'}, 'stop'))
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
master, slave = pty.openpty()
env = {**os.environ, 'UNJAILED_HOME': str(home), 'UNJAILED_API_KEY': 'sk-local-stall-fixture', 'UNJAILED_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1', 'UNJAILED_MODEL': 'glm-5.3-abliterated', 'UNJAILED_REASONING_TIMEOUT': '1', 'UNJAILED_RESPONSE_TIMEOUT': '10', 'UNJAILED_NO_FX': '1', 'NO_COLOR': '1', 'TERM': 'xterm-256color', 'COLUMNS': '110', 'LINES': '40'}
child = subprocess.Popen(['node', str(entry)], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root)
os.close(slave)
output = ''

def wait(predicate, label):
    global output
    end = time.monotonic() + 15
    while time.monotonic() < end:
        if select.select([master], [], [], .05)[0]:
            try: output += os.read(master, 65536).decode(errors='replace')
            except OSError: break
        if predicate(): return
        if child.poll() is not None: break
    raise AssertionError(label + '\n' + re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)[-3000:])

try:
    wait(lambda: 'glm-5.3-abliterated' in output, 'startup')
    os.write(master, b'Create a calculator and verify it.'); time.sleep(.2); os.write(master, b'\r')
    wait(lambda: 'LIVE DRAFT' in output and 'verified 5' in output, 'incoming draft visible before completion')
    assert not (root / 'result.txt').exists(), 'partial draft executed'
    assert 'not executed yet' in output
    release_draft.set()
    wait(lambda: 'Finished and verified the calculator.' in output, 'completed recovery rendered')
    assert len(requests) == 5
    assert (root / 'executions.txt').read_text() == 'x', 'completed command replayed'
    assert (root / 'result.txt').read_text() == 'verified 5\n'
    assert 'Model stalled' in output and 'continuing once' in output
    assert requests[3]['reasoning_effort'] == 'low'
    assert any(m.get('tool_call_id') == 'checked' and m['role'] == 'tool' for m in requests[3]['messages'])
    assert any(m.get('tool_call_id') == 'duplicate' and 'not executed again' in m.get('content', '') for m in requests[4]['messages'])
    assert requests[1]['chat_template_kwargs']['clear_thinking'] is False
    assert 'Plan mode' not in output
    receipt = {'version': json.loads((entry.parent.parent / 'package.json').read_text())['version'], 'realTerminal': True, 'localMockModelOnly': True, 'hostPlatform': sys.platform, 'liveDraftVisibleBeforeCompleteArguments': True, 'partialDraftDidNotCreateFile': True, 'completedCommandsBeforeStall': 2, 'commandMutationExecutedExactlyOnce': True, 'stallRecoveryVisible': True, 'completedToolResultsPresentDuringRecovery': True, 'newFileCreatedAfterRecovery': True, 'forcedPlanning': False, 'apiRequests': len(requests), 'windowsPhysicalDeviceTested': False, 'customerMutations': 0}
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
finally:
    release_draft.set()
    child.terminate()
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    os.close(master); server.shutdown(); shutil.rmtree(root)
