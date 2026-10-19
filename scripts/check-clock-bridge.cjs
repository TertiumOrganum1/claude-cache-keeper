const assert = require('node:assert/strict');
const { ckReadWarmStamp, ckApplyWarmStamp, ckAckClockBridge } = require('./vscode-clock-bridge.cjs');
const node = { type: 'Box', props: { key: 'cache-keeper-warm:chat-a:1000:1h', display: 'none' }, children: [] };
assert.deepEqual(ckReadWarmStamp({ type: 'Box', children: [node] }, ['cache-keeper']), { sessionId: 'chat-a', at: 1000, ttl: '1h' });
assert.equal(ckReadWarmStamp(node, ['another-plugin']), null);
assert.equal(ckReadWarmStamp({ type: 'Box', props: { key: 'cache-keeper-warm:NaN:1h' } }, ['cache-keeper']), null);
const original = { anchorAt: 500, ttl: '1h', recacheTokens: 50000, messageId: 'main' };
const updated = ckApplyWarmStamp(original, { at: 1000, ttl: '1h' }, 2000);
assert.equal(updated.anchorAt, 1000);
assert.equal(updated.ttl, '1h');
assert.equal(updated.recacheTokens, 50000);
assert.equal(ckApplyWarmStamp(updated, { at: 1000, ttl: '1h' }, 2000), updated);
assert.equal(ckApplyWarmStamp(original, { at: 10000, ttl: '1h' }, 2000), original);
assert.equal(ckApplyWarmStamp(original, { at: 1000, ttl: 'bad' }, 2000), original);
const compacted = { ...original, compactedAt: 1500 };
assert.equal(ckApplyWarmStamp(compacted, { at: 1000, ttl: '1h' }, 2000), compacted);
const newer = { ...original, anchorAt: 1500 };
assert.equal(ckApplyWarmStamp(newer, { at: 1000, ttl: '1h' }, 2000), newer);
const rebuilt = ckApplyWarmStamp(compacted, { at: 1800, ttl: '1h' }, 2000);
assert.equal(rebuilt.compactedAt, undefined);
console.log('Clock bridge: verified stamp only; newer main request, compaction, future timestamps and repeated renders preserved.');

if (!process.argv[2]) {
  const ackNode = { type: 'Button', key: 'cache-keeper-clock-ready:chat-a:1000', press: { plugin: 'cache-keeper', handle: 7 } };
  let presses = 0;
  const handlers = { onPress: () => presses++ };
  const store = { host: { noteCacheKeeperWarm: stamp => stamp.sessionId === 'chat-a' } };
  ckAckClockBridge({ type: 'Box', children: [ackNode] }, ['cache-keeper'], handlers, store);
  assert.equal(presses, 1, 'loaded bridge acknowledges its own session');
  ckAckClockBridge(ackNode, ['cache-keeper'], handlers, store);
  assert.equal(presses, 1, 'render loop must not send the same acknowledgement repeatedly');
  const otherNode = { ...ackNode, key: 'cache-keeper-clock-ready:chat-b:1000' };
  ckAckClockBridge(otherNode, ['cache-keeper'], handlers, store);
  assert.equal(presses, 1, 'a stale tree cannot acknowledge a different session');
}

// Exercise the installed webview's actual host callback, effect and footer calculation.
if (process.argv[2]) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const bundle = fs.readFileSync(process.argv[2], 'utf8');
  const clock = bundle.slice(bundle.indexOf('function Mm('), bundle.indexOf('function xh1('));
  assert.ok(clock.startsWith('function Mm('));
  const callback = bundle.match(/noteCacheKeeperWarm:(\((?:Q|ckStamp)\)=>\{.*?\}),isHoldingCards:/);
  assert.ok(callback, 'native session host callback installed');
  const effect = bundle.match(/r\(\(\)=>\{let (?:V|ckStamp)=ckReadWarmStamp\(Q,z\);if\((?:V|ckStamp)\)\$\.host\.noteCacheKeeperWarm\?\.\((?:V|ckStamp)\)(?:;ckAckClockBridge\(Q,z,G,\$\);)?\},\[Q,\$,z(?:,G)?\]\);/);
  assert.ok(effect, 'AbovePrompt effect installed');
  const now = 181000;
  const record = { value: { anchorAt: 0, ttl: '1h', recacheTokens: 40000 }, peek() { return this.value; } };
  const session = { promptCacheRecord: record, sessionId: { peek: () => 'chat-a' } };
  const context = vm.createContext({ ckReadWarmStamp, ckApplyWarmStamp, ckAckClockBridge, G: {}, Date: { now: () => now }, uy0: { '1h': 3600000, '5m': 300000 }, session });
  vm.runInContext(clock, context);
  assert.equal(vm.runInContext('Mm(session.promptCacheRecord.value, 181000).minutesLeft', context), 57);
  const host = { noteCacheKeeperWarm: vm.runInContext(`(function(){return ${callback[1]}}).call(session)`, context) };
  Object.assign(context, { Q: { ...node, props: { key: 'cache-keeper-warm:chat-a:180000:1h' } }, z: ['cache-keeper'], $: { host }, r: fn => fn() });
  vm.runInContext(effect[0], context);
  assert.equal(record.value.anchorAt, 180000);
  assert.equal(vm.runInContext('Mm(session.promptCacheRecord.value, 181000).minutesLeft', context), 60);
  if (bundle.includes('/* cache-keeper-native-clock-v2 */')) {
    let acknowledgements = 0;
    context.Q = { type: 'Box', children: [{ type: 'Button', key: 'cache-keeper-clock-ready:chat-a:180000', press: { plugin: 'cache-keeper', handle: 9 } }] };
    context.G = { onPress: () => acknowledgements++ };
    vm.runInContext(effect[0], context);
    assert.equal(acknowledgements, 1, 'real native callback/effect confirms a loaded bridge');
    context.Q = { ...node, props: { key: 'cache-keeper-warm:chat-a:180000:1h' } };
  }
  const otherRecord = { anchorAt: 100000, ttl: '1h' };
  record.value = otherRecord;
  session.sessionId.peek = () => 'chat-b';
  vm.runInContext(effect[0], context);
  assert.equal(record.value, otherRecord, 'stale AbovePrompt tree must not update another conversation');
  console.log('Installed webview: real AbovePrompt effect -> session record -> native footer clock changes 57m to 60m.');
}
