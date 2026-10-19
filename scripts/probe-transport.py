#!/usr/bin/env python3
"""Check real Claude request construction against a local fake API, never a model."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading


def without_controls(value):
    if isinstance(value, dict):
        return {k: without_controls(v) for k, v in value.items() if k != 'cache_control'}
    if isinstance(value, list):
        return [without_controls(v) for v in value]
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(without_controls(value), sort_keys=True).encode()).hexdigest()


def ttls(value):
    if isinstance(value, dict):
        own = [value['cache_control'].get('ttl', '5m')] if isinstance(value.get('cache_control'), dict) else []
        return own + [ttl for v in value.values() for ttl in ttls(v)]
    if isinstance(value, list):
        return [ttl for v in value for ttl in ttls(v)]
    return []


def main():
    source = Path(__file__).resolve().parents[1]
    requests = []
    mode_start = 0

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get('content-length', '0'))))
            requests.append(payload)
            # Replay counters from the real incident, including the assistant tail.
            usage = (dict(input_tokens=2, output_tokens=1626, cache_creation_input_tokens=521,
                          cache_read_input_tokens=356681) if len(requests) == mode_start + 1 else
                     dict(input_tokens=14, output_tokens=3, cache_creation_input_tokens=1626,
                          cache_read_input_tokens=357202))
            message = dict(id='msg_local', type='message', role='assistant', content=[dict(type='text', text='.')],
                           model=payload.get('model'), stop_reason='end_turn', stop_sequence=None, usage=usage)
            if payload.get('stream'):
                events = [
                    dict(type='message_start', message={**message, 'content': [], 'stop_reason': None, 'usage': {**usage, 'output_tokens': 0}}),
                    dict(type='content_block_start', index=0, content_block=dict(type='text', text='')),
                    dict(type='content_block_delta', index=0, delta=dict(type='text_delta', text='.')),
                    dict(type='content_block_stop', index=0),
                    dict(type='message_delta', delta=dict(stop_reason='end_turn', stop_sequence=None), usage=usage),
                    dict(type='message_stop'),
                ]
                body = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
                content_type = 'text/event-stream'
            else:
                body = json.dumps(message).encode()
                content_type = 'application/json'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='cache-keeper-probe-') as temp:
            root = Path(temp)
            summaries = {}
            for mode in ['off', 'on']:
                fixture = root / mode
                (fixture / '.claude-plugin').mkdir(parents=True)
                (fixture / 'hooks').mkdir()
                shutil.copyfile(source / '.claude-plugin/plugin.json', fixture / '.claude-plugin/plugin.json')
                for name in ['hooks.json', 'policy.ts', 'register.tsx', 'clock-bridge.ts']:
                    shutil.copyfile(source / 'hooks' / name, fixture / 'hooks' / name)
                shutil.copytree(source / 'types', fixture / 'types')
                path = fixture / 'hooks/register.tsx'
                text = path.read_text()
                if mode == 'on':
                    # Exercise real process.run/plugin.root without touching the live extension.
                    # CLI and VS Code use this same engine; force the GUI startup branch here.
                    (fixture / 'scripts').mkdir()
                    (fixture / 'scripts/install-clock-bridge.py').write_text(
                        "from pathlib import Path\nPath('bridge-probe-ran').write_text('ok')\n"
                        "print('{\"status\":\"ok\",\"reloadRequired\":false,\"extensions\":[]}')\n")
                    text = text.replace("if (e.surface === 'vscode') clockBridge ??= createClockBridge($)", 'clockBridge ??= createClockBridge($)')
                    # Speed up only the disposable fixture: exercise the actual timer,
                    # not a direct tick() call, against the real CLI request builder.
                    policy = fixture / 'hooks/policy.ts'
                    policy_text = policy.read_text()
                    old = "leadMs() { return this.ttl === '1h' ? 300_000 : 60_000 }"
                    assert old in policy_text, 'Update fixture substitution for the changed policy'
                    policy.write_text(policy_text.replace(old, 'leadMs() { return this.ttlMs() - 200 }'))
                    text = text.replace('$.clock.every(15_000,', '$.clock.every(100,')
                    old = "      keeper.finishTurn(e.turnId, e.reason === 'answer' && !!e.usage)\n      await persist($)"
                    assert old in text, 'Update fixture substitution for turn.complete'
                    text = text.replace(old, old + "\n      for (let probeWait = 0; probeWait < 80 && keeper.snapshot().pings === 0; probeWait++) await $.clock.sleep(100)\n      await $.fs.write('probe-policy.json', JSON.stringify({ ...keeper.save(), lastError }))")
                else:
                    old = "on('session.start', async ($, e, next) => {\n    await ensureStarted($)"
                    assert old in text, 'Update fixture substitution for session.start'
                    text = text.replace(old, old + "\n    keeper.disable()")
                path.write_text(text)
                config = root / ('config-' + mode)
                config.mkdir()
                env = os.environ.copy()
                for key in ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'FORCE_PROMPT_CACHING_5M',
                            'ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_PROMPT_CACHE_TTL',
                            'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'DISABLE_PROMPT_CACHING', 'CLAUDECODE']:
                    env.pop(key, None)
                env.update(CLAUDE_CONFIG_DIR=str(config), ANTHROPIC_API_KEY='sk-ant-local-transport-probe',
                           ANTHROPIC_BASE_URL=f'http://127.0.0.1:{server.server_port}',
                           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
                start = len(requests)
                mode_start = start
                result = subprocess.run(
                    ['claude', '--print', '--model', 'claude-sonnet-4-6[1m]', '--effort', 'high',
                     '--plugin-dir', str(fixture), '--strict-mcp-config', '--no-session-persistence',
                     'Reply with one period. Never use tools.'],
                    cwd=fixture, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
                assert result.returncode == 0, 'Local Claude probe failed (no real API call was made)'
                captured = requests[start:]
                policy_file = fixture / 'probe-policy.json'
                assert (len(captured) == 1 if mode == 'off' else 2 <= len(captured) <= 5), f'Unexpected request count in {mode}: {len(captured)}; policy={policy_file.read_text() if policy_file.exists() else "not written"}; stderr={result.stderr.decode(errors="replace")[-3000:]}'
                expected = '5m' if mode == 'off' else '1h'
                assert all(ttls(p) and set(ttls(p)) == {expected} for p in captured), 'Incorrect request TTL'
                summaries[mode] = dict(requests=len(captured), ttls=[ttls(p) for p in captured])
                if mode == 'on':
                    assert (fixture / 'bridge-probe-ran').read_text() == 'ok', 'Native process.run startup helper did not execute'
                    policy_result = json.loads((fixture / 'probe-policy.json').read_text())
                    assert policy_result['pings'] >= 1, f'Real incident counters were not accepted: {policy_result}'
                    assert policy_result['mainUsage']['cache_read_input_tokens'] == 356681, 'Fork overwrote the main-input baseline'
                    summaries[mode]['accepted_incident_counters'] = True
                    summaries[mode]['startup_process_ran'] = True
                    original, fork = captured[0], captured[1]
                    for field in ['model', 'tools', 'system', 'thinking', 'output_config', 'tool_choice']:
                        assert fingerprint(original.get(field)) == fingerprint(fork.get(field)), f'Fork changed {field}'
                    prefix = fork['messages'][:len(original['messages'])]
                    assert fingerprint(prefix) == fingerprint(original['messages']), 'Fork changed the message prefix'
                    summaries[mode]['matching_prefix'] = True
                    summaries[mode]['timer_triggered'] = True
                    summaries[mode]['effort'] = original.get('output_config', {}).get('effort')
            print(json.dumps(summaries, indent=2))
            print('PASS: real request construction, local fake API, zero provider inference')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
