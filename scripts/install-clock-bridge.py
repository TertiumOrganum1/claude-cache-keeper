#!/usr/bin/env python3
"""Discover Claude Code extensions and repair the verified cache-clock bridge."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

LEGACY_MARK = '/* cache-keeper-native-clock-v1 */'
MARK = '/* cache-keeper-native-clock-v2 */'
ID = r'[$A-Za-z_][$\w]*'
CALLBACK = ',noteCacheKeeperWarm:(ckStamp)=>{if(ckStamp.sessionId!==this.sessionId.peek())return false;let ckOld=this.promptCacheRecord.peek(),ckNew=ckApplyWarmStamp(ckOld,ckStamp,Date.now());if(ckNew!==ckOld)this.promptCacheRecord.value=ckNew;return true}'
STYLE = '\n/* Local cache-keeper compact band */\n[role="group"][aria-label="From the cache-keeper plugin"]:has(> [data-engine-site="AbovePrompt"]) > [data-engine-mark] { display: none; }\n'


def one(pattern, source, what):
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise ValueError(f'Unsupported {what}: expected one match, found {len(matches)}')
    return matches[0]


def patched(source, helper):
    # Do not guess a replacement when the native cache record contract changes.
    for contract in ('recordPromptCacheFrame(', 'promptCacheRecord', '.anchorAt', '.compactedAt', '.ttl'):
        if contract not in source:
            raise ValueError('Unsupported native cache record: ' + contract)
    if LEGACY_MARK in source:
        legacy_host = 'noteInput:(Q)=>this.noteModInput(Q),noteCacheKeeperWarm:(Q)=>{if(Q.sessionId!==this.sessionId.peek())return;let z=this.promptCacheRecord.peek(),G=ckApplyWarmStamp(z,Q,Date.now());if(G!==z)this.promptCacheRecord.value=G}'
        legacy_effect = 'r(()=>{let V=ckReadWarmStamp(Q,z);if(V)$.host.noteCacheKeeperWarm?.(V)},[Q,$,z]);'
        legacy_helper = helper.split('\nconst ckClockAcks')[0]
        legacy_chunk = LEGACY_MARK + '\n' + legacy_helper + '\n'
        if source.count(legacy_chunk) != 1 or source.count(legacy_host) != 1 or source.count(legacy_effect) != 1:
            raise ValueError('Partial or conflicting legacy bridge')
        source = source.replace(legacy_chunk, '', 1).replace(legacy_host, 'noteInput:(Q)=>this.noteModInput(Q)', 1).replace(legacy_effect, '', 1)
    effect_binding = one(r'(' + ID + r')=function\((' + ID + r'),(' + ID + r')\)\{return ' + ID + r'\.current\.useEffect\(\2,\3\)\}', source, 'React effect binding')[1]
    host = one(r'noteInput:\((' + ID + r')\)=>this\.noteModInput\(\1\)', source, 'session host')
    # Names may change between builds; the component/site and host properties are the contracts.
    band = one(r'function (' + ID + r')\(\{store:(' + ID + r'),isWorking:[^}]{1,300}\}\)\{let\{tree:(' + ID + r'),drawnBy:(' + ID + r'),handlers:(' + ID + r')\}=' + ID + r'\(\{store:\2,component:"AbovePrompt",', source, 'AbovePrompt component')
    name, store, tree, owners, handlers = band.groups()
    one(r'function ' + re.escape(name) + r'\(', source, 'AbovePrompt function name')
    effect = f'{effect_binding}(()=>{{let ckStamp=ckReadWarmStamp({tree},{owners});if(ckStamp){store}.host.noteCacheKeeperWarm?.(ckStamp);ckAckClockBridge({tree},{owners},{handlers},{store});}},[{tree},{store},{owners},{handlers}]);'
    if MARK in source:
        if source.count(MARK) == 1 and source.count(CALLBACK) == 1 and source.count(effect) == 1 and source.count(helper) == 1:
            return source
        raise ValueError('Partial or conflicting clock bridge')
    if 'ckApplyWarmStamp' in source or 'ckReadWarmStamp' in source or 'noteCacheKeeperWarm:' in source:
        raise ValueError('Partial or conflicting clock bridge')
    render_end = f'}});if({tree}===null)return null;'
    end = source.find(render_end, band.end(), band.end() + 1800)
    if end < 0:
        raise ValueError('Unsupported AbovePrompt return path')
    candidate = source[:end] + source[end:].replace(render_end, '});' + effect + f'if({tree}===null)return null;', 1)
    candidate = candidate.replace(host[0], host[0] + CALLBACK, 1)
    return candidate.replace('function ' + name + '(', MARK + '\n' + helper + '\nfunction ' + name + '(', 1)


def discover(roots):
    targets = []
    for root in roots:
        registry = root / 'extensions.json'
        if not registry.exists():
            continue
        entries = json.loads(registry.read_text())
        for entry in entries:
            if entry.get('identifier', {}).get('id', '').lower() != 'anthropic.claude-code':
                continue
            relative = entry.get('relativeLocation')
            if not isinstance(relative, str):
                raise ValueError('Claude extension registry has no relativeLocation')
            path = (root / relative).resolve()
            if path.parent != root.resolve():
                raise ValueError('Claude extension registry points outside its extension directory')
            if path not in targets:
                targets.append(path)
    return targets


def atomic_write(path, content):
    mode = path.stat().st_mode & 0o777
    fd, temp = tempfile.mkstemp(prefix='.cache-keeper-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def fingerprint(version, target):
    # A reinstall of the same version rewrites the bundle, so size/mtime join the version.
    stat = target.stat()
    return {'version': version, 'size': stat.st_size, 'mtime': stat.st_mtime_ns}


def load_patched(state):
    try:
        data = json.loads((state / 'patched.json').read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_patched(state, records):
    fd, temp = tempfile.mkstemp(prefix='.patched-', dir=state)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(records, stream, indent=2)
        os.replace(temp, state / 'patched.json')
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def repair(extension, helper, state, check, records):
    metadata = json.loads((extension / 'package.json').read_text())
    if metadata.get('publisher', '').lower() != 'anthropic' or metadata.get('name') != 'claude-code':
        raise ValueError('Target is not Anthropic.claude-code')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][\w.-]+)?', metadata.get('version', '')):
        raise ValueError('Unrecognized extension version')
    target = extension / 'webview/index.js'
    if not check and records.get(str(extension)) == fingerprint(metadata['version'], target):
        return {'version': metadata['version'], 'path': str(extension), 'status': 'ready', 'reloadRequired': False, 'backup': None}
    source = target.read_text()
    candidate = patched(source, helper)
    css = extension / 'webview/index.css'
    original_css = css.read_text()
    styled = original_css if '[aria-label="From the cache-keeper plugin"]' in original_css else original_css + STYLE
    changed = candidate != source or styled != original_css
    if changed:
        with tempfile.TemporaryFile(mode='w+') as stream:
            stream.write(candidate)
            stream.seek(0)
            subprocess.run(['node', '--check', '--input-type=module'], stdin=stream, capture_output=True, text=True, check=True, timeout=10)
    backup = None
    if changed and not check:
        backup = state / 'backups' / (metadata['version'] + '-' + datetime.datetime.now().strftime('%Y%m%dT%H%M%S%f'))
        backup.mkdir(parents=True, mode=0o700)
        for file in (target, css):
            shutil.copy2(file, backup / file.name)
            (backup / file.name).chmod(0o600)
        if candidate != source:
            atomic_write(target, candidate)
        if styled != original_css:
            atomic_write(css, styled)
    if not check:
        records[str(extension)] = fingerprint(metadata['version'], target)
    return {'version': metadata['version'], 'path': str(extension), 'status': 'would-repair' if check and changed else 'repaired' if changed else 'ready', 'reloadRequired': changed and not check, 'backup': str(backup) if backup else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auto', action='store_true', help='Discover registered extensions (default without --extension)')
    parser.add_argument('--extension', type=Path)
    parser.add_argument('--extensions-dir', action='append', type=Path)
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.claude/cache-keeper')
    parser.add_argument('--check', action='store_true', help='Validate candidate without changing installed files')
    args = parser.parse_args()
    results = []
    try:
        roots = args.extensions_dir or [Path.home() / '.vscode/extensions', Path.home() / '.vscode-insiders/extensions']
        targets = [args.extension] if args.extension else discover(roots)
        helper = Path(__file__).with_name('vscode-clock-bridge.cjs').read_text().split('module.exports =')[0].strip()
        args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (args.state_dir / 'repair.lock').open('a') as lock:
            # Multiple open chats share this OS lock. It is released even on timeout/kill.
            fcntl.flock(lock, fcntl.LOCK_EX)
            records = load_patched(args.state_dir)
            before = dict(records)
            for extension in targets:
                try:
                    results.append(repair(extension, helper, args.state_dir, args.check, records))
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    results.append({'path': str(extension), 'status': 'unsupported' if isinstance(error, ValueError) else 'error', 'detail': str(error), 'reloadRequired': False})
            if records != before:
                save_patched(args.state_dir, records)
        status = next((r['status'] for r in results if r['status'] in ('unsupported', 'error')), 'ok' if results else 'missing')
        report = {'status': status, 'reloadRequired': any(r['reloadRequired'] for r in results), 'extensions': results}
    except (ValueError, OSError) as error:
        report = {'status': 'error', 'detail': str(error), 'reloadRequired': False, 'extensions': results}
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] == 'ok' else 1


if __name__ == '__main__':
    raise SystemExit(main())
