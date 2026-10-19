#!/usr/bin/env python3
"""Exercise discovery/repair against isolated extension folders, never the live install."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install-clock-bridge.py')
# Small executable fixture with the native contracts the patch relies on.
BUNDLE = '''var r=function(a,b){return React.current.useEffect(a,b)};
class Session{constructor(){this.engineSurface={noteInput:(Q)=>this.noteModInput(Q),isHoldingCards:()=>false}}
recordPromptCacheFrame(frame){this.promptCacheRecord.value=frame}}
function pD5({store:$,isWorking:J,viewport:Z,onLeave:X,onOpenUrl:Y}){let{tree:Q,drawnBy:z,handlers:G}=bX({store:$,component:"AbovePrompt",instanceId:mu1,props:{hasSurvey:!1,isWorking:J},viewport:Z,onOpenUrl:Y});if(Q===null)return null;let q=F("div",{className:I2.band,children:F(ZH,{tree:Q,...G})});return F(VG,{plugins:z,children:q})}
function Mm($,J){if($?.compactedAt!==void 0)return{kind:"cold"};if($===void 0||$.anchorAt===void 0||$.ttl===void 0)return{kind:"unknown"};let Z=uy0[$.ttl],X=Math.min(Z,$.anchorAt+Z-J);return X}
'''


class AutoBridge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.exts = self.root / 'extensions'
        self.exts.mkdir()
        self.state = self.root / 'state'

    def extension(self, version, source=BUNDLE):
        path = self.exts / ('anthropic.claude-code-' + version)
        (path / 'webview').mkdir(parents=True)
        (path / 'package.json').write_text(json.dumps({'name': 'claude-code', 'publisher': 'Anthropic', 'version': version}))
        (path / 'webview/index.js').write_text(source)
        (path / 'webview/index.css').write_text('.existing{color:red}')
        (self.exts / 'extensions.json').write_text(json.dumps([{'identifier': {'id': 'Anthropic.claude-code'}, 'version': version, 'relativeLocation': path.name}]))
        return path

    def run_installer(self, *args):
        result = subprocess.run(['python3', str(SCRIPT), '--auto', '--extensions-dir', str(self.exts), '--state-dir', str(self.state), *args], capture_output=True, text=True)
        self.assertTrue(result.stdout.strip().startswith('{'), result.stderr)
        return result, json.loads(result.stdout)

    def test_discovers_new_version_and_repairs_once(self):
        path = self.extension('2.1.301')
        result, report = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(report['reloadRequired'])
        self.assertIn('noteCacheKeeperWarm:', (path / 'webview/index.js').read_text())
        self.assertIn('From the cache-keeper plugin', (path / 'webview/index.css').read_text())
        changed = (path / 'webview/index.js').stat().st_mtime_ns
        result, again = self.run_installer()
        self.assertFalse(again['reloadRequired'])
        self.assertEqual((path / 'webview/index.js').stat().st_mtime_ns, changed)
        backups = list(self.state.glob('backups/*/index.js'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), BUNDLE)
        # Simulate an extension update replacing the webview in the same folder.
        (path / 'webview/index.js').write_text(BUNDLE)
        _, report = self.run_installer()
        self.assertTrue(report['reloadRequired'])

    def test_renamed_minified_bindings_are_supported(self):
        source = BUNDLE.replace('pD5', 'NewBand').replace('Q', 'tree9').replace('z', 'owners9').replace('r=function', 'effect9=function')
        path = self.extension('2.2.0', source)
        result, report = self.run_installer()
        self.assertEqual(result.returncode, 0, report)
        self.assertTrue(report['reloadRequired'])
        # Execute the generated effect, rather than only asserting its source.
        subprocess.run(['node', '-e', '''const fs=require('fs'),vm=require('vm'),assert=require('assert');
const s=fs.readFileSync(process.argv[1],'utf8');
const effect=s.match(/effect9\\(\\(\\)=>\\{let ckStamp=.*?\\},\\[.*?\\]\\);/)[0];
let got;vm.runInNewContext(effect,{effect9:f=>f(),tree9:{type:'Box',props:{key:'cache-keeper-warm:chat-a:1000:1h'}},owners9:['cache-keeper'],G:{},$:{host:{noteCacheKeeperWarm:s=>got=s}},ckReadWarmStamp:require(process.argv[2]).ckReadWarmStamp,ckAckClockBridge:require(process.argv[2]).ckAckClockBridge});
assert.equal(got.at,1000);assert.equal(got.sessionId,'chat-a');''', str(path / 'webview/index.js'), str(SCRIPT.with_name('vscode-clock-bridge.cjs'))], check=True)

    def test_incompatible_bundle_is_reported_without_touching_it(self):
        path = self.extension('3.0.0', BUNDLE.replace('recordPromptCacheFrame', 'changedClockContract'))
        before = (path / 'webview/index.js').read_bytes()
        result, report = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'unsupported')
        self.assertFalse(report['reloadRequired'])
        self.assertEqual((path / 'webview/index.js').read_bytes(), before)
        self.assertEqual((path / 'webview/index.css').read_text(), '.existing{color:red}')

    def test_parallel_chat_startups_do_not_duplicate_patch(self):
        path = self.extension('2.1.301')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.run_installer(), range(3)))
        self.assertEqual(sum(report['reloadRequired'] for _, report in results), 1)
        self.assertEqual((path / 'webview/index.js').read_text().count('noteCacheKeeperWarm:'), 1)

    def test_dry_run_and_unregistered_old_copy_remain_untouched(self):
        old = self.extension('2.1.300')
        new = self.extension('2.1.301')
        _, report = self.run_installer('--check')
        self.assertFalse(report['reloadRequired'])
        self.assertEqual((new / 'webview/index.js').read_text(), BUNDLE)
        self.run_installer()
        self.assertEqual((old / 'webview/index.js').read_text(), BUNDLE)
        self.assertIn('noteCacheKeeperWarm:', (new / 'webview/index.js').read_text())


if __name__ == '__main__':
    unittest.main()
