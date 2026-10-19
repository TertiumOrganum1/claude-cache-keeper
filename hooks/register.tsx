import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'
import { CacheKeeper } from './policy'
import type { CacheTtl, Reason } from './policy'
import { createClockBridge } from './clock-bridge'

const LABELS: Record<Reason, string> = {
  off: 'выключен', waiting: 'жду обычного сообщения для запуска отсчёта', 'unknown-ttl': 'жду обычного сообщения для запуска отсчёта',
  busy: 'Claude работает', fresh: 'кэш ещё свежий', due: 'пора прогреть', expired: 'кэш истёк; нужен ответ или ручной прогрев',
  'cache-miss': 'промах кэша; автоматический прогрев остановлен', error: 'ошибка прогрева; нажми Прогреть для повтора',
  'ttl-conflict': 'TTL изменился; жду нового ответа',
}
const STATE = { plugin: 'cache-keeper', key: 'session' } as const
const keeper = new CacheKeeper()
let selectedTtl: CacheTtl = '1h'
let started: Promise<void> | undefined
let bootAttempted = false
let lastError = ''
let model = ''
let effort = ''
let surfaceWorking = false
let restoredBusy = false
let periodic: Timer | undefined
let bootstrap: Timer | undefined
let conversationEpoch = 0
let clockBridge: ReturnType<typeof createClockBridge> | undefined

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const persist = async ($: EngineInterface) => {
  await $.state.set(STATE, { policy: keeper.save(), selectedTtl, lastError, model, effort })
  redraw($)
}

const status = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const s = keeper.snapshot()
  const reason = keeper.reason(now)
  const left = s.lastAt !== null && s.ttl !== null ? Math.max(0, Math.ceil((s.lastAt + keeper.ttlMs() - now) / 60_000)) : null
  const accounting = reason === 'cache-miss' ? s.lastRefreshUsage : s.lastRefreshUsage ?? s.usage
  const count = accounting ? `; cache read ${accounting.cache_read_input_tokens}, write ${accounting.cache_creation_input_tokens}` : ''
  const next = s.lastAt !== null && (reason === 'fresh' || reason === 'due')
    ? `; следующий прогрев через ${Math.max(0, Math.ceil((s.lastAt + keeper.ttlMs() - keeper.leadMs() - now) / 60_000))} мин` : ''
  return `Cache Keeper: ${s.enabled ? `включён; ${LABELS[reason]}` : 'выключен'}${next}; TTL ${s.ttl ?? selectedTtl}; прогревов ${s.pings}${left !== null ? `; кэш примерно на ${left} мин` : ''}${count}${lastError ? `; ${lastError}` : ''}${clockBridge?.report() ? `; ${clockBridge.report()}` : ''}`
}
const tick = async ($: EngineInterface, manual = false) => {
  if (surfaceWorking) {
    if (manual) { lastError = 'Claude отвечает; прогрев доступен после ответа'; await persist($) }
    return
  }
  const epoch = conversationEpoch
  let token: number | null = null
  let changed = false
  let previous: string | undefined
  let ttl: CacheTtl = selectedTtl
  try {
    const now = await $.clock.now()
    const forced = await $.env.get('FORCE_PROMPT_CACHING_5M')
    if (epoch !== conversationEpoch) return
    if (manual && forced === '1') ttl = '5m'
    token = manual ? keeper.beginNow(now, ttl) : keeper.begin(now)
    if (token === null) {
      if (manual) {
        if (keeper.snapshot().refreshing) lastError = 'Прогрев уже выполняется'
        else if (keeper.snapshot().busy) lastError = 'Claude отвечает; прогрев доступен после ответа'
        await persist($)
      }
      return
    }
    ttl = keeper.snapshot().ttl!
    lastError = ''
    await persist($)
    const disabled = await $.env.get('DISABLE_PROMPT_CACHING')
    if (epoch !== conversationEpoch) return
    if ((forced === '1' && ttl !== '5m') || disabled === '1' || disabled === 'true') {
      keeper.fail(token, 'ttl-conflict')
      lastError = 'Настройки Claude запрещают выбранный TTL'
      return
    }
    previous = await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
    if (epoch !== conversationEpoch) return
    await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', ttl)
    changed = true
    const sentAt = await $.clock.now()
    if (epoch !== conversationEpoch) return
    if (!keeper.canSend(token, sentAt)) { keeper.cancel(); return }
    const result = await $.model.fork({ prompt: 'Reply with one character: .' })
    if (epoch !== conversationEpoch) return
    if (!keeper.isCurrent(token)) { keeper.cancel(); return }
    if (result.isAnswered) {
      keeper.complete(token, sentAt, result.usage)
      lastError = keeper.reason(sentAt) === 'cache-miss' ? 'Прогрев: чтение исходного контекста не подтверждено' : ''
    } else if (result.reason === 'nothing-to-fork') {
      keeper.noSource(token)
      lastError = 'Нужен ответ Claude после запуска VS Code'
    }
    else {
      keeper.fail(token)
      lastError = result.reason === 'api-error' ? `API ${result.status}: ${result.error}` : result.reason
    }
  } catch (error) {
    if (token !== null && epoch === conversationEpoch && keeper.isCurrent(token)) { keeper.fail(token); lastError = error instanceof Error ? error.message : String(error) }
  } finally {
    if (changed) {
      try {
        if (await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL') === ttl)
          await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', previous)
      } catch { if (token !== null && epoch === conversationEpoch && keeper.isCurrent(token)) keeper.fail(token) }
    }
    if (token !== null && epoch === conversationEpoch) { await persist($) }
  }
}

const ensureStarted = ($: EngineInterface) => started ??= (async () => {
  const { value } = await $.state.get(STATE)
  const saved = value as { policy?: unknown; selectedTtl?: CacheTtl; lastError?: string; model?: string; effort?: string } | undefined
  if (!keeper.restore(saved?.policy)) keeper.enable()
  restoredBusy = keeper.snapshot().busy
  if (saved?.selectedTtl === '1h' || saved?.selectedTtl === '5m') selectedTtl = saved.selectedTtl
  lastError = saved?.lastError ?? ''
  model = saved?.model ?? ''
  effort = saved?.effort ?? ''
  // Return the async work to the timer; do not abandon its promise.
  periodic = $.clock.every(15_000, async () => { await tick($); redraw($) })
  bootstrap = $.clock.after(250, async () => {
    if (bootAttempted) return
    bootAttempted = true
    const reason = keeper.reason(await $.clock.now())
    if (reason === 'waiting' || reason === 'unknown-ttl') await tick($, true)
  })
})()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensureStarted($)
    if (e.surface === 'vscode') clockBridge ??= createClockBridge($)
    await $.command.register({ name: 'cache-keeper', description: 'Прогрев кэша текущего чата', argumentHint: '[on [1h|5m]|off|status|now]', immediate: true })
    await $.command.register({ name: 'cache-on', description: 'Включить прогрев кэша текущего чата', immediate: true })
    await $.command.register({ name: 'cache-off', description: 'Выключить прогрев кэша текущего чата', immediate: true })
    await $.command.register({ name: 'cache-status', description: 'Показать состояние и время следующего прогрева', immediate: true })
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (!['cache-keeper', 'cache-on', 'cache-off', 'cache-status'].includes(e.command)) {
      if (['model', 'effort', 'fast', 'mcp', 'plugins', 'reload-plugins', 'clear', 'compact', 'resume', 'rewind', 'fork'].includes(e.command)) {
        // A reload retains a valid timestamp in host state; context changes do not.
        if (e.command !== 'reload-plugins') { keeper.invalidate(); await persist($) }
      }
      return next(e)
    }
    await ensureStarted($)
    const words = e.command === 'cache-on' ? ['on'] : e.command === 'cache-off' ? ['off'] : e.command === 'cache-status' ? ['status'] : e.args.trim().split(/\s+/)
    if (words[0] === 'off') keeper.disable()
    else if (words[0] === 'on') {
      if (words[1] !== undefined && words[1] !== '1h' && words[1] !== '5m') return { text: 'Используй /cache-keeper on 1h или /cache-keeper on 5m' }
      if (words[1] !== undefined && words[1] !== selectedTtl) { selectedTtl = words[1]; keeper.invalidate() }
      keeper.enable()
    } else if (words[0] === 'now') { keeper.enable(); await tick($, true) }
    else if (words[0] !== '' && words[0] !== 'status') return { text: '/cache-keeper [on [1h|5m]|off|status|now]' }
    await persist($)
    return { text: await status($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await ensureStarted($)
    if (e.surface === 'vscode') clockBridge ??= createClockBridge($)
    surfaceWorking = e.props.isWorking
    if (restoredBusy && !surfaceWorking) {
      restoredBusy = false
      const epoch = conversationEpoch
      const revision = keeper.revision()
      $.clock.after(0, async () => {
        if (epoch === conversationEpoch && keeper.isCurrent(revision) && !surfaceWorking && keeper.snapshot().busy) { keeper.abandonTurn(); await persist($) }
      })
    }
    await $.state.get(STATE)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const s = keeper.snapshot()
    const bridge = clockBridge
    const warmSessionId = s.lastWarmAt !== null || bridge?.ticket() ? await $.session.id() : ''
    const reason = keeper.reason(now)
    const nextMin = s.lastAt !== null && (reason === 'fresh' || reason === 'due')
      ? Math.max(0, Math.ceil((s.lastAt + keeper.ttlMs() - keeper.leadMs() - now) / 60_000)) : null
    let text = s.refreshing ? 'прогреваю...' : reason === 'busy' || surfaceWorking ? 'Claude работает' : nextMin !== null ? `через ${nextMin}м` :
      reason === 'waiting' || reason === 'unknown-ttl' ? 'жду первого ответа' : LABELS[reason]
    const failed = ['cache-miss', 'error', 'ttl-conflict', 'expired'].includes(reason)
    if (lastError && (failed || reason === 'waiting' || reason === 'unknown-ttl' || reason === 'busy' || surfaceWorking)) text = lastError
    let usage: SessionUsage | undefined
    try { usage = await $.session.usage() } catch { /* Keep controls when metrics are unavailable. */ }
    const accounting = reason === 'cache-miss' ? s.lastRefreshUsage : s.lastRefreshUsage ?? s.usage
    const total = accounting ? accounting.input_tokens + accounting.cache_read_input_tokens + accounting.cache_creation_input_tokens : 0
    const cachePct = total && accounting ? Math.round(accounting.cache_read_input_tokens / total * 100) : null
    const percent = usage?.context.percent
    const sep = <Text dimColor> · </Text>
    const shortModel = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ')
    return (
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={0}>
      <Box flexDirection="row" flexWrap="nowrap" flexShrink={0} alignItems="center" gap={0}>
        {percent !== undefined ? [<Text dimColor>ctx </Text>, <Text color={percent >= 85 ? 'warning' : 'success'}>{Math.round(percent)}%</Text>, sep] : []}
        <Box key="cache-ratio" flexDirection="row" flexWrap="nowrap" flexShrink={0}><Text dimColor>cache </Text><Text color={cachePct !== null && cachePct >= 95 ? 'success' : 'warning'}>{cachePct === null ? '?' : `${cachePct}%`}</Text></Box>
        {(['five_hour', 'seven_day'] as const).map(kind => {
          const limit = usage?.rateLimits.find(l => l.kind === kind)
          return [sep, <Box key={`limit-${kind}`} flexDirection="row" flexWrap="nowrap" flexShrink={0}>
            <Text dimColor>{kind === 'five_hour' ? '5h ' : '7d '}</Text>
            <Text color={limit && limit.percentUsed >= 80 ? 'warning' : undefined}>{limit ? `${Math.round(limit.percentUsed)}%` : '?'}</Text>
          </Box>]
        })}
        {shortModel ? [sep, <Text color="claude">{shortModel}{effort ? ` ${effort}` : ''}</Text>] : []}
        {sep}
        <Button key="toggle" plain onPress={async () => {
          if (keeper.snapshot().enabled) keeper.disable()
          else { keeper.enable(); await persist($); await tick($, true) }
          await persist($)
        }}>{s.enabled ? 'Кэш: вкл' : 'Кэш: выкл'}</Button>
        {sep}<Box key="schedule" flexDirection="row" flexWrap="nowrap" flexShrink={0}><Text color={failed ? 'error' : undefined}>{text}{s.pings ? `; OK ${s.pings}` : ''}</Text></Box>
        {sep}<Button key="refresh" plain onPress={async () => { keeper.enable(); await tick($, true) }}>{s.refreshing ? 'Прогреваю...' : 'Прогреть'}</Button>
        {clockBridge?.status() ? [sep, <Text color="warning">{clockBridge.status()}</Text>] : []}
      </Box>
      {s.lastWarmAt !== null && s.lastWarmTtl !== null
        ? <Box key={`cache-keeper-warm:${encodeURIComponent(warmSessionId)}:${s.lastWarmAt}:${s.lastWarmTtl}`} display="none" /> : null}
      {bridge?.ticket() ? <Box display="none"><Button key={`cache-keeper-clock-ready:${encodeURIComponent(warmSessionId)}:${bridge.ticket()}:${Math.floor(now / 15_000)}`} onPress={() => bridge.acknowledge()}>clock ready</Button></Box> : null}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    await ensureStarted($)
    if (!e.isMeta && !e.command && ['composer', 'bridge', 'sdk', 'channel', 'unclassified'].includes(e.origin.kind)) { bootAttempted = true; keeper.noteHuman(await $.clock.now()) }
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    await ensureStarted($)
    if (!e.agentId) { bootAttempted = true; restoredBusy = false; keeper.startTurn(e.turnId, await $.clock.now(), false); lastError = ''; await persist($) }
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    await ensureStarted($)
    let previous: string | undefined
    let applied: CacheTtl | null = null
    let changed = false
    model = e.model
    effort = e.effort === undefined ? effort : String(e.effort)
    try {
      if (keeper.snapshot().enabled) {
        const forced = await $.env.get('FORCE_PROMPT_CACHING_5M')
        const disabled = await $.env.get('DISABLE_PROMPT_CACHING')
        if (disabled !== '1' && disabled !== 'true') {
          applied = forced === '1' ? '5m' : selectedTtl
          previous = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
          await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', applied)
          changed = true
        }
      }
    } catch { applied = null }
    keeper.request(e.turnId, await $.clock.now(), applied)
    await persist($)
    try {
      const result = yield* next(e)
      if (result.usage) keeper.observe(result.usage)
      return result
    } finally {
      if (changed) {
        try {
          if (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL') === applied) await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', previous)
        } catch { keeper.invalidate() }
      }
    }
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      surfaceWorking = false
      restoredBusy = false
      keeper.finishTurn(e.turnId, e.reason === 'answer' && !!e.usage)
      await persist($)
    }
    return result
  })
  on('session.compact', async ($, e, next) => { if (!e.agentId) { keeper.invalidate(); await persist($) }; return next(e) })
  on('session.end', async ($, e, next) => {
    await persist($)
    periodic?.cancel()
    bootstrap?.cancel()
    clockBridge?.cancel()
    clockBridge = undefined
    conversationEpoch++
    keeper.reset()
    started = undefined
    bootAttempted = false
    surfaceWorking = restoredBusy = false
    model = effort = lastError = ''
    return next(e)
  })
  on('classic.PostModelSwitch', async ($, e, next) => { keeper.invalidate(); await persist($); return next(e) })
  on('classic.ConfigChange', async ($, e, next) => { keeper.invalidate(); await persist($); return next(e) })
  on('config.set', async ($, e, next) => {
    if (/(model|effort|fast|mcp|plugin|cache)/i.test(e.key)) { keeper.invalidate(); await persist($) }
    return next(e)
  })
}
