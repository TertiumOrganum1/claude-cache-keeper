import { expect, test } from 'claude-code/testing'
import { CacheKeeper, classifyUsage } from './policy'

const MIN = 60_000
const good = { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 3 }

test('starts off and never warms before a successful real turn', async () => {
  const k = new CacheKeeper()
  expect(k.reason(0)).toBe('off')
  k.enable()
  expect(k.reason(0)).toBe('waiting')
})

test('accepts an epoch-zero request and warms only before expiry', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('one', 0)
  k.request('one', 0, '1h')
  k.finishTurn('one', true)
  expect(k.reason(54 * MIN)).toBe('fresh')
  expect(k.reason(55 * MIN)).toBe('due')
  expect(k.reason(60 * MIN)).toBe('expired')
})

test('counts response time against TTL and refuses expired or failed requests', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('one', 0)
  k.request('one', 0, '5m')
  expect(k.reason(4 * MIN)).toBe('busy')
  k.finishTurn('one', true)
  expect(k.reason(5 * MIN)).toBe('expired')
  k.startTurn('two', 6 * MIN)
  k.request('two', 6 * MIN, '5m')
  k.finishTurn('two', false)
  expect(k.reason(7 * MIN)).toBe('waiting')
})

test('keeps warming beyond three pings and three idle hours', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('one', 0)
  k.request('one', 0, '1h')
  k.finishTurn('one', true)
  for (let i = 1; i <= 12; i++) {
    const now = i * 55 * MIN
    const token = k.begin(now)
    expect(typeof token).toBe('number')
    k.complete(token!, now, good)
  }
  expect(k.snapshot().pings).toBe(12)
  expect(k.reason(12 * 55 * MIN + MIN)).toBe('fresh')
})

test('a new real turn and off invalidate stale in-flight success', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('one', 0)
  k.request('one', 0, '5m')
  k.finishTurn('one', true)
  const token = k.begin(4 * MIN)!
  expect(k.reason(4 * MIN)).toBe('busy')
  k.startTurn('two', 4 * MIN + 1)
  k.request('two', 4 * MIN + 2, '5m')
  k.finishTurn('two', true)
  k.complete(token, 4 * MIN, good)
  expect(k.snapshot().pings).toBe(0)
  expect(k.snapshot().lastAt).toBe(4 * MIN + 2)
  const newer = k.begin(8 * MIN + 2)!
  k.disable()
  k.complete(newer, 8 * MIN + 2, good)
  expect(k.snapshot().pings).toBe(0)
  expect(k.reason(9 * MIN)).toBe('off')
})

test('bad or absent accounting stops warming until a new real turn', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('one', 0)
  k.request('one', 0, '5m')
  k.finishTurn('one', true)
  k.complete(k.begin(4 * MIN)!, 4 * MIN, { ...good, cache_read_input_tokens: 0 })
  expect(k.reason(4 * MIN)).toBe('cache-miss')
  k.disable()
  k.enable()
  expect(k.reason(4 * MIN)).toBe('cache-miss')
  k.startTurn('two', 5 * MIN)
  k.request('two', 5 * MIN, '5m')
  k.finishTurn('two', true)
  expect(k.reason(9 * MIN)).toBe('due')
})

test('accounting rejects invalid numbers, short hits, and large rewritten prefixes', async () => {
  expect(classifyUsage(good)).toBe(true)
  expect(classifyUsage(undefined)).toBe(false)
  expect(classifyUsage({ ...good, input_tokens: NaN })).toBe(false)
  expect(classifyUsage({ ...good, cache_read_input_tokens: -1 })).toBe(false)
  expect(classifyUsage({ ...good, cache_read_input_tokens: 100 })).toBe(false)
  expect(classifyUsage({ ...good, cache_creation_input_tokens: 40000 })).toBe(false)
  expect(classifyUsage({ ...good, cache_creation_input_tokens: 20000, input_tokens: 1000 })).toBe(false)
})

test('restores a session timer without extending its lifetime', async () => {
  const first = new CacheKeeper()
  first.enable()
  first.startTurn('one', 0)
  first.request('one', 0, '1h')
  first.finishTurn('one', true)
  const restored = new CacheKeeper()
  restored.restore(JSON.parse(JSON.stringify(first.save())))
  expect(restored.reason(55 * MIN)).toBe('due')
  expect(restored.reason(60 * MIN)).toBe('expired')
})

test('a manual bootstrap accepts a real cache hit and can recover after failure', async () => {
  const k = new CacheKeeper()
  k.enable()
  const token = k.beginNow(0, '1h')!
  expect(k.canSend(token, 0)).toBe(true)
  k.complete(token, 0, good)
  expect(k.reason(MIN)).toBe('fresh')
  k.fail(k.begin(55 * MIN)!)
  expect(k.reason(55 * MIN)).toBe('error')
  const retry = k.beginNow(56 * MIN, '1h')!
  k.complete(retry, 56 * MIN, good)
  expect(k.reason(57 * MIN)).toBe('fresh')
})

test('reload preserves the busy guard until the same turn completes', async () => {
  const first = new CacheKeeper()
  first.enable()
  first.startTurn('running', 0)
  first.request('running', 0, '1h')
  const restored = new CacheKeeper()
  restored.restore(first.save())
  expect(restored.reason(MIN)).toBe('busy')
  expect(restored.beginNow(MIN, '1h')).toBe(null)
  restored.finishTurn('running', true)
  expect(restored.reason(MIN)).toBe('fresh')
})

test('a completed SDK turn is eligible without a separate human-input marker', async () => {
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('sdk', 0, false)
  k.request('sdk', 0, '1h')
  k.finishTurn('sdk', true)
  expect(k.snapshot().lastHumanAt).toBe(null)
  expect(k.reason(MIN)).toBe('fresh')
  const token = k.begin(55 * MIN)!
  expect(typeof token).toBe('number')
  expect(k.canSend(token, 55 * MIN)).toBe(true)
})

test('reload recovers an already completed GUI request with no human-input marker', async () => {
  const first = new CacheKeeper()
  first.enable()
  first.startTurn('gui', 0, false)
  first.request('gui', 0, '1h')
  first.finishTurn('gui', true)
  const restored = new CacheKeeper()
  restored.restore(first.save())
  expect(restored.reason(55 * MIN)).toBe('due')
})

test('enabling an already enabled keeper does not cancel its current refresh', async () => {
  const k = new CacheKeeper()
  k.enable()
  const token = k.beginNow(0, '1h')!
  k.enable()
  expect(k.isCurrent(token)).toBe(true)
  k.complete(token, 0, good)
  expect(k.snapshot().pings).toBe(1)
})

test('the real 357202-token hit with a 1626-token assistant tail remains scheduled', async () => {
  const k = new CacheKeeper()
  const main = { input_tokens: 2, cache_read_input_tokens: 356681, cache_creation_input_tokens: 521, output_tokens: 1626 }
  const fork = { input_tokens: 14, cache_read_input_tokens: 357202, cache_creation_input_tokens: 1626, output_tokens: 3 }
  k.enable()
  k.startTurn('real-log', 0)
  k.request('real-log', 0, '1h')
  k.observe(main)
  k.finishTurn('real-log', true)
  k.complete(k.begin(55 * MIN)!, 55 * MIN, fork)
  expect(k.reason(55 * MIN)).toBe('fresh')
  expect(k.snapshot().pings).toBe(1)
  expect(k.snapshot().usage).toEqual(fork)
  expect(typeof k.begin(110 * MIN)).toBe('number')
})

test('a long new assistant tail does not hide reuse of the whole known main prefix', async () => {
  const main = { ...good, cache_read_input_tokens: 20000, output_tokens: 30000 }
  const fork = { input_tokens: 14, cache_read_input_tokens: 20010, cache_creation_input_tokens: 30000, output_tokens: 3 }
  const k = new CacheKeeper()
  k.enable()
  k.startTurn('long-answer', 0)
  k.request('long-answer', 0, '1h')
  k.observe(main)
  k.finishTurn('long-answer', true)
  k.complete(k.begin(55 * MIN)!, 55 * MIN, fork)
  expect(k.reason(55 * MIN)).toBe('fresh')
  const restored = new CacheKeeper()
  expect(restored.restore(k.save())).toBe(true)
  restored.complete(restored.begin(110 * MIN)!, 110 * MIN, fork)
  expect(restored.reason(110 * MIN)).toBe('fresh')
  expect(restored.snapshot().pings).toBe(2)
})

test('a mostly cached shorter fork cannot claim reuse of a larger known main prefix', async () => {
  const source = { ...good, cache_read_input_tokens: 20000 }
  expect(classifyUsage({ ...good, cache_read_input_tokens: 5000 }, source)).toBe(false)
  expect(classifyUsage({ ...good, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 }, source)).toBe(false)
})
