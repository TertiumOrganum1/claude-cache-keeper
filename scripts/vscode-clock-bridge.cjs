// Embedded verbatim into the supported VS Code webview by install-clock-bridge.py.
function ckReadWarmStamp(tree, owners) {
  if (!Array.isArray(owners) || !owners.includes('cache-keeper')) return null;
  const queue = [tree];
  for (let visited = 0; queue.length && visited < 2048; visited++) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const key = node.props?.key ?? node.key;
    const match = node.type === 'Box' && typeof key === 'string' && /^cache-keeper-warm:([^:]{1,512}):(\d{1,16}):(1h|5m)$/.exec(key);
    if (match) {
      const at = Number(match[2]);
      if (Number.isSafeInteger(at) && at >= 0) {
        try { return { sessionId: decodeURIComponent(match[1]), at, ttl: match[3] }; } catch { /* Invalid marker. */ }
      }
    }
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return null;
}
function ckApplyWarmStamp(current, stamp, now) {
  if (!stamp || !Number.isSafeInteger(stamp.at) || stamp.at < 0 ||
      stamp.at > now + 5000 || !['1h', '5m'].includes(stamp.ttl)) return current;
  if (current?.anchorAt >= stamp.at || current?.compactedAt >= stamp.at) return current;
  return { messageId: current?.messageId, anchorAt: stamp.at, ttl: stamp.ttl, recacheTokens: current?.recacheTokens };
}
const ckClockAcks = new WeakMap();
function ckAckClockBridge(tree, owners, handlers, store) {
  if (!Array.isArray(owners) || !owners.includes('cache-keeper') || typeof handlers?.onPress !== 'function') return;
  const queue = [tree];
  for (let visited = 0; queue.length && visited < 2048; visited++) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const key = node.key ?? node.props?.key;
    const match = node.type === 'Button' && node.press?.plugin === 'cache-keeper' && typeof key === 'string' && /^cache-keeper-clock-ready:([^:]{1,512}):(\d+)(?::\d+)?$/.exec(key);
    if (match) {
      let sessionId;
      try { sessionId = decodeURIComponent(match[1]); } catch { return; }
      // Host validates the session even when an old tree survives a channel switch.
      if (store.host.noteCacheKeeperWarm?.({ sessionId }) !== true) return;
      const now = Date.now(), previous = ckClockAcks.get(store);
      if (previous?.key === key && now - previous.at < 5000) return;
      ckClockAcks.set(store, { key, at: now });
      handlers.onPress({ ...node.press, key });
      return;
    }
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
}
module.exports = { ckReadWarmStamp, ckApplyWarmStamp, ckAckClockBridge };
