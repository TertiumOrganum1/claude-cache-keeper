export type CacheTtl = '5m' | '1h'
export type Usage = {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
}
export type Reason = 'off' | 'waiting' | 'unknown-ttl' | 'busy' | 'fresh' | 'due' | 'expired' | 'cache-miss' | 'error' | 'ttl-conflict'

function isUsage(value: unknown): value is Usage {
  if (value === null || typeof value !== 'object') return false
  const u = value as Usage
  const counts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens]
  return counts.every(x => Number.isSafeInteger(x) && x >= 0) &&
    Number.isSafeInteger(u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens)
}

export function classifyUsage(value: unknown, previous: unknown = null): value is Usage {
  if (!isUsage(value) || value.cache_read_input_tokens < 1024) return false
  // A fork appends the last assistant reply and tool results to the main input.
  // Those newly cached tokens do not make reuse of the original prefix a miss.
  const prefix = isUsage(previous) ? previous.input_tokens + previous.cache_creation_input_tokens + previous.cache_read_input_tokens : 0
  const expected = prefix >= 1024 ? prefix : value.input_tokens + value.cache_creation_input_tokens + value.cache_read_input_tokens
  return value.cache_read_input_tokens / expected >= 0.95
}

export class CacheKeeper {
  private enabled = false
  private busy = false
  private inFlight = false
  private generation = 0
  private turnId: string | null = null
  private lastAt: number | null = null
  private lastHumanAt: number | null = null
  private ttl: CacheTtl | null = null
  private successful = false
  private pings = 0
  private lastWarmAt: number | null = null
  private lastWarmTtl: CacheTtl | null = null
  private blocked: Reason | null = null
  private usage: Usage | null = null
  private mainUsage: Usage | null = null
  private lastRefreshUsage: Usage | null = null

  enable() { if (!this.enabled) { this.enabled = true; this.generation++ } }
  disable() { this.enabled = false; this.generation++ }

  noteHuman(now: number) {
    this.generation++
    this.lastHumanAt = now
    this.pings = 0
  }

  startTurn(turnId: string, now: number, human = true) {
    this.generation++
    this.turnId = turnId
    this.busy = true
    this.successful = false
    this.lastAt = null
    if (human) { this.lastHumanAt = now; this.pings = 0 }
    this.blocked = null
    this.lastRefreshUsage = null
    this.mainUsage = null
  }

  request(turnId: string, now: number, ttl: CacheTtl | null) {
    if (turnId !== this.turnId) return
    this.lastAt = now
    this.ttl = ttl
  }

  finishTurn(turnId: string, successful: boolean) {
    if (turnId !== this.turnId) return
    this.busy = false
    this.successful = successful
    if (!successful) this.lastAt = null
  }

  reason(now: number): Reason {
    if (!this.enabled) return 'off'
    if (this.busy || this.inFlight) return 'busy'
    if (this.blocked !== null) return this.blocked
    if (!this.successful || this.lastAt === null) return 'waiting'
    if (this.ttl === null) return 'unknown-ttl'
    const age = now - this.lastAt
    if (age < 0 || age >= this.ttlMs()) return 'expired'
    return age >= this.ttlMs() - this.leadMs() ? 'due' : 'fresh'
  }

  ttlMs() { return this.ttl === '1h' ? 3600_000 : 300_000 }
  leadMs() { return this.ttl === '1h' ? 300_000 : 60_000 }

  begin(now: number): number | null {
    if (this.reason(now) !== 'due') return null
    this.inFlight = true
    return this.generation
  }

  canSend(token: number, now: number) {
    return token === this.generation && this.enabled && !this.busy && this.inFlight &&
      this.lastAt !== null && this.ttl !== null &&
      now >= this.lastAt && now - this.lastAt < this.ttlMs()
  }

  beginNow(now: number, ttl: CacheTtl): number | null {
    if (!this.enabled || this.busy || this.inFlight) return null
    this.generation++
    this.lastAt = now
    this.lastHumanAt ??= now
    this.ttl = ttl
    this.blocked = null
    this.inFlight = true
    return this.generation
  }

  noSource(token: number) {
    this.inFlight = false
    if (token !== this.generation) return
    this.lastAt = null
    this.successful = false
    this.blocked = null
  }

  observe(usage: Usage) { this.usage = { ...usage }; this.mainUsage = isUsage(usage) ? { ...usage } : null }

  save() {
    return { ...this.snapshot(), successful: this.successful, turnId: this.turnId, blocked: this.blocked }
  }

  restore(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false
    const v = value as ReturnType<CacheKeeper['save']>
    if (typeof v.enabled !== 'boolean' || typeof v.successful !== 'boolean' ||
        ![null, '1h', '5m'].includes(v.ttl) ||
        ![v.lastAt, v.lastHumanAt].every(t => t === null || (Number.isSafeInteger(t) && t >= 0)) ||
        !Number.isSafeInteger(v.pings) || v.pings < 0) return false
    this.enabled = v.enabled
    this.lastAt = v.lastAt
    this.lastHumanAt = v.lastHumanAt
    this.ttl = v.ttl
    this.pings = v.pings
    this.lastWarmAt = Number.isSafeInteger(v.lastWarmAt) && v.lastWarmAt! >= 0 ? v.lastWarmAt! : null
    this.lastWarmTtl = v.lastWarmTtl === '1h' || v.lastWarmTtl === '5m' ? v.lastWarmTtl : null
    this.successful = v.successful && !v.busy
    this.turnId = typeof v.turnId === 'string' ? v.turnId : null
    this.blocked = ['cache-miss', 'error', 'ttl-conflict'].includes(v.blocked ?? '') ? v.blocked : null
    this.usage = v.usage && typeof v.usage === 'object' ? { ...v.usage } : null
    this.mainUsage = isUsage(v.mainUsage) ? { ...v.mainUsage }
      : v.mainUsage === undefined && v.pings === 0 && isUsage(v.usage) ? { ...v.usage } : null
    this.lastRefreshUsage = isUsage(v.lastRefreshUsage) ? { ...v.lastRefreshUsage } : null
    this.busy = v.busy === true
    this.inFlight = false
    this.generation++
    return true
  }

  revision() { return this.generation }

  isCurrent(token: number) { return token === this.generation }

  abandonTurn() { this.busy = false; this.invalidate() }

  cancel() { this.inFlight = false }

  invalidate() { this.generation++; this.lastAt = null; this.successful = false; this.lastWarmAt = null; this.lastWarmTtl = null; this.lastRefreshUsage = null; this.mainUsage = null }

  reset() {
    this.disable()
    this.invalidate()
    this.busy = false
    this.turnId = null
    this.lastHumanAt = null
    this.pings = 0
    this.usage = null
    this.blocked = null
  }

  complete(token: number, startedAt: number, usage: unknown) {
    this.inFlight = false
    if (token !== this.generation) return
    this.lastRefreshUsage = isUsage(usage) ? { ...usage } : null
    if (!classifyUsage(usage, this.mainUsage)) { this.blocked = 'cache-miss'; return }
    this.usage = { ...usage }
    this.lastAt = startedAt
    this.lastWarmAt = startedAt
    this.lastWarmTtl = this.ttl
    this.successful = true
    this.pings++
  }

  fail(token: number, reason: 'error' | 'ttl-conflict' = 'error') {
    this.inFlight = false
    if (token === this.generation) this.blocked = reason
  }

  snapshot() {
    return { enabled: this.enabled, busy: this.busy, refreshing: this.inFlight, lastAt: this.lastAt,
      lastHumanAt: this.lastHumanAt, ttl: this.ttl, lastWarmAt: this.lastWarmAt, lastWarmTtl: this.lastWarmTtl, pings: this.pings, usage: this.usage && { ...this.usage }, mainUsage: this.mainUsage && { ...this.mainUsage }, lastRefreshUsage: this.lastRefreshUsage && { ...this.lastRefreshUsage } }
  }
}
