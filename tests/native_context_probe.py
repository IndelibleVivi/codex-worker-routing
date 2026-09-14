#!/usr/bin/env python3
"""Opt-in native context contract probe. Uses synthetic data and a loopback model stub."""
import argparse
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import threading
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--codex-bin', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
probe_temp = tempfile.TemporaryDirectory(prefix='worker-routing-probe-')
root = Path(probe_temp.name)
(root / 'home').mkdir()
(root / 'work').mkdir()
(root / 'home' / 'AGENTS.md').write_text('SHARED_ENGINEERING_SENTINEL\n')
(root / 'work' / 'AGENTS.md').write_text('PROJECT_ENGINEERING_SENTINEL\n')
private_content = 'PRIVATE_BEGIN\n' + 'Synthetic owner preference.\n' * 800 + 'PRIVATE_END\n'
(root / 'main-only.md').write_text(private_content)
spec = importlib.util.spec_from_file_location('installer', repo / 'integrations/main-session/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.install(root / 'main-only.md', root / 'home', True)
(root / 'other_hook.py').write_text("import json,sys\ne=json.load(sys.stdin)\nk=e['hook_event_name']\nt='ROOT_RECALL_SENTINEL' if k=='UserPromptSubmit' else 'WORKER_HOOK_SENTINEL'\nprint(json.dumps({'hookSpecificOutput':{'hookEventName':k,'additionalContext':t}}))\n")
hooks = json.loads((root / 'home' / 'hooks.json').read_text())
for kind in ('UserPromptSubmit', 'SubagentStart'):
    hooks['hooks'][kind] = [{'hooks': [{'type': 'command', 'command': shlex.join([os.sys.executable, str(root / 'other_hook.py')])}]}]
(root / 'home' / 'hooks.json').write_text(json.dumps(hooks))
requests = []
phases = {}
lock = threading.Lock()

class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        headers = {k.lower(): v for k, v in self.headers.items()}
        child = bool(headers.get('x-codex-parent-thread-id') or headers.get('x-openai-subagent'))
        key = 'child' if child else 'root'
        with lock:
            requests.append({'role': key, 'headers': headers, 'body': body})
            phases[key] = phases.get(key, 0) + 1
            phase = phases[key]
            seq = len(requests)
        name = None
        namespace = None
        args = {}
        if key == 'root' and phase == 1:
            name = 'exec_command'
            args = {'cmd': 'pwd', 'max_output_tokens': 200}
        elif key == 'root' and phase == 2:
            name = 'spawn_agent'
            namespace = 'collaboration'
            args = {'task_name': 'probe_worker', 'message': 'WORK_ORDER_SENTINEL. Read local AGENTS.md and report the project engineering marker. Do not read any other file or delegate.', 'fork_turns': 'none'}
        elif key == 'root' and phase == 3:
            name = 'wait_agent'
            namespace = 'collaboration'
            args = {'timeout_ms': 10000}
        elif key == 'root' and phase == 4:
            name = 'interrupt_agent'
            namespace = 'collaboration'
            args = {'target': '/root/probe_worker'}
        elif key == 'root' and phase == 5:
            name = 'followup_task'
            namespace = 'collaboration'
            args = {'target': '/root/probe_worker', 'message': 'FOLLOWUP_WORK_ORDER_SENTINEL. Confirm the same project marker again. Do not read any other file.'}
        elif key == 'root' and phase == 6:
            name = 'wait_agent'
            namespace = 'collaboration'
            args = {'timeout_ms': 10000}
        elif key == 'root' and phase == 7:
            name = 'interrupt_agent'
            namespace = 'collaboration'
            args = {'target': '/root/probe_worker'}
        elif key == 'child' and phase in (1, 3):
            name = 'exec_command'
            args = {'cmd': 'cat AGENTS.md', 'max_output_tokens': 200}
        if name:
            item = {'id': f'fc_{seq}', 'type': 'function_call', 'call_id': f'call_{seq}', 'name': name, 'arguments': json.dumps(args)}
            if namespace:
                item['namespace'] = namespace
        else:
            item = {'id': f'msg_{seq}', 'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'LOCAL_FIXTURE_DONE', 'annotations': []}]}
        resp = {'id': f'resp_{seq}', 'object': 'response', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [{'type': 'response.created', 'response': dict(resp, status='in_progress', output=[])}, {'type': 'response.output_item.added', 'output_index': 0, 'item': dict(item, arguments='') if name else dict(item, content=[])}]
        if name:
            events.append({'type': 'response.function_call_arguments.delta', 'item_id': item['id'], 'output_index': 0, 'delta': item['arguments']})
        else:
            events.append({'type': 'response.output_text.delta', 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': 'LOCAL_FIXTURE_DONE'})
        events.extend([{'type': 'response.output_item.done', 'output_index': 0, 'item': item}, {'type': 'response.completed', 'response': resp}])
        data = ''.join(('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
config = f'model = "gpt-5.5"\nmodel_provider = "local-fixture"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.local-fixture]\nname = "Loopback synthetic fixture"\nbase_url = "http://127.0.0.1:{server.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 2\n'
(root / 'home' / 'config.toml').write_text(config)
env = {k: v for k, v in os.environ.items() if not k.startswith('CODEX_') and 'API_KEY' not in k and ('TOKEN' not in k)}
env['CODEX_HOME'] = str(root / 'home')
command = [args.codex_bin, 'exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--json', '-C', str(root / 'work'), 'Synthetic native worker context test. Delegate the project check and follow up once.']
try:
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:] + result.stdout[-1000:])
    children = [r for r in requests if r['role'] == 'child']
    assert requests and requests[0]['role'] == 'root'
    first = json.dumps(requests[0]['body'])
    assert json.dumps(private_content)[1:-1] in first
    assert 'worker-routing-main-context/v1 end' in first
    assert 'ROOT_RECALL_SENTINEL' in first
    assert len(children) == 4, f'expected 4 child requests, got {len(children)}'
    for child in children:
        encoded = json.dumps(child['body'])
        assert all((s not in encoded for s in ('PRIVATE_BEGIN', 'PRIVATE_END', 'ROOT_RECALL_SENTINEL', 'worker-routing-main-context/v1')))
        assert all((s in encoded for s in ('SHARED_ENGINEERING_SENTINEL', 'PROJECT_ENGINEERING_SENTINEL', 'WORKER_HOOK_SENTINEL', 'WORK_ORDER_SENTINEL')))
    assert any(('FOLLOWUP_WORK_ORDER_SENTINEL' in json.dumps(c['body']) for c in children))
    outputs = requests[-1]['body'].get('input', [])
    assert sum((i.get('type') == 'function_call_output' and 'previous_status' in str(i.get('output')) and ('completed' in str(i.get('output'))) for i in outputs)) == 2
    print(json.dumps({'passed': True, 'root_first_request_has_private_start_and_end': True, 'child_requests_without_private_or_recall': len(children), 'followup_and_two_completed_interrupts': True, 'real_model_inference': False}))
finally:
    server.shutdown()
    probe_temp.cleanup()
