import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ModelForkResult, ProcessRunResult } from 'claude-code'

const MIN = 60_000
const commandInput = { command: 'cache-keeper', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const good = { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 3 }
const props = { title: 'Cache Keeper', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 12 }, view: {} }

function setup(on: On, result: ModelForkResult | (() => Promise<ModelForkResult>) = { isAnswered: true, text: '.', usage: good }, repair: () => ProcessRunResult | Promise<ProcessRunResult> = () => ({ exitCode: 0, stdout: '{"status":"ok","reloadRequired":false,"extensions":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }), mainUsage = good) {
  const clock = mock.clock(on)
  const env: Record<string, string | undefined> = { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }
  let calls = 0
  let forkTtl: string | undefined
  let mainTtl: string | undefined
  let panesOpened = 0
  const notifications: string[] = []
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('env.set', ($, e) => { env[e.name] = e.value; return { value: undefined } })
  on('model.fork', async () => { calls++; forkTtl = env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL; return { value: typeof result === 'function' ? await result() : result } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'test-session' }))
  on('process.run', async () => ({ value: await repair() }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('classic.PostModelSwitch', () => ({}))
  on('config.set', ($, e) => ({ value: e.value }))
  on('ui.open', () => { panesOpened++; return { value: { isPlaced: true } } })
  on('ui.toast', ($, e) => { notifications.push(e.text); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other plugin'] }))
  on('turn.step', async function* ($, e) {
    mainTtl = env.CLAUDE_CODE_PROMPT_CACHE_TTL
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...mainUsage, model: e.model } }
  })
  return { clock, env, notifications, panesOpened: () => panesOpened, calls: () => calls, forkTtl: () => forkTtl, mainTtl: () => mainTtl }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'vscode', isInteractive: false })
}

async function turn($: Engine, id = 'main', submit = true) {
  if (submit) await $.prompt.submit({ text: 'real user task', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'real user task', turnId: id })
  const stream = $.turn.step({ turnId: id, index: 0, model: 'claude-test', messageCount: 2 })
  let part = await stream.next()
  while (!part.done) part = await stream.next()
  await $.turn.complete({ turnId: id, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: { ...good, model: 'claude-test' } })
}

test('GUI commands without arguments enable, report status, and disable without opening a pane', async ($, on) => {
  const h = setup(on)
  await start($)
  expect((await $.command.run({ ...commandInput, command: 'cache-status', args: '' })).text).toContain('включён')
  const enabled = await $.command.run({ ...commandInput, command: 'cache-on', args: '' })
  expect(enabled.text).toContain('включён')
  expect(enabled.text).toContain('обычного сообщения')
  expect((await $.command.run({ ...commandInput, command: 'cache-off', args: '' })).text).toContain('выключен')
  expect(h.panesOpened()).toBe(0)
})

test('the original bare command reports status instead of opening a large pane', async ($, on) => {
  const h = setup(on)
  await start($)
  expect((await $.command.run({ ...commandInput, args: '' })).text).toContain('включён')
  expect(h.panesOpened()).toBe(0)
})

test('ordinary replies and automatic refreshes do not create popup notifications', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($)
  expect(h.notifications.length).toBe(0)
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.notifications.length).toBe(0)
})

test('a real turn establishes an explicit TTL and restores the main environment', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  expect(h.mainTtl()).toBe('1h')
  expect(h.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe(undefined)
  await h.clock.advance(54 * MIN)
  expect(h.calls()).toBe(0)
  await h.clock.advance(MIN)
  expect(h.calls()).toBe(1)
  expect(h.forkTtl()).toBe('1h')
  expect(h.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('5m')
})

test('five-minute mode refreshes once at four minutes and cannot overlap', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on 5m' })
  await turn($)
  await h.clock.advance(4 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.forkTtl()).toBe('5m')
  await h.clock.advance(30_000)
  expect(h.calls()).toBe(1)
})

test('a cache miss stops further pings and reports the reason', async ($, on) => {
  const h = setup(on, { isAnswered: true, text: '.', usage: { ...good, cache_read_input_tokens: 0 } })
  await start($)
  await $.command.run({ ...commandInput, args: 'on 5m' })
  await turn($)
  await h.clock.advance(10 * MIN)
  expect(h.calls()).toBe(1)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('промах')
  expect(h.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('5m')
})

test('API errors restore the temporary TTL and stop automatic retries', async ($, on) => {
  const h = setup(on, { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: good })
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  await h.clock.advance(120 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('5m')
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('ошибка')
})

test('unrelated pane content passes through and survey or other mods remain intact', async ($, on) => {
  setup(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'Pane', requestId: 'another-pane', props })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('other plugin')
})

test('pause disables both automatic bootstrap and future requests', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, command: 'cache-off', args: '' })
  await turn($)
  await h.clock.advance(120 * MIN)
  expect(h.calls()).toBe(0)
  expect(h.mainTtl()).toBe(undefined)
})

test('a thrown fork restores TTL and stops subsequent pings', async ($, on) => {
  const h = setup(on, async () => { throw new Error('network') })
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  await h.clock.advance(60 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('5m')
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('ошибка')
})

test('a forced five-minute TTL is respected on both main and maintenance requests', async ($, on) => {
  const h = setup(on)
  h.env.FORCE_PROMPT_CACHING_5M = '1'
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  expect(h.mainTtl()).toBe('5m')
  await h.clock.advance(4 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.forkTtl()).toBe('5m')
})

test('changing forced TTL after a real turn prevents a mismatched ping', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  h.env.FORCE_PROMPT_CACHING_5M = '1'
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(0)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('TTL изменился')
})

test('late success cannot overwrite a real turn and no second fork overlaps it', async ($, on) => {
  const h = setup(on, async () => {
    await h.clock.sleep(2 * MIN)
    return { isAnswered: true, text: '.', usage: good }
  })
  await start($)
  await $.command.run({ ...commandInput, args: 'on 5m' })
  await turn($)
  await h.clock.advance(4 * MIN)
  expect(h.calls()).toBe(1)
  await turn($, 'second')
  await h.clock.advance(2 * MIN)
  expect(h.calls()).toBe(1)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('прогревов 0')
})

test('GUI model-picker changes invalidate the old snapshot before any paid fork', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  await $.classic.PostModelSwitch({
    from_model: 'claude-test', to_model: 'another-model', requested_model: 'another-model', source: 'picker',
    context_tokens: 50_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1, pricing: 'catalog',
  })
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(0)
})

test('GUI effort changes invalidate the old snapshot before any paid fork', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await turn($)
  await $.config.set({ key: 'effortLevel', value: 'high', previous: 'low', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(0)
})

test('a queued human message does not impose a three-hour cutoff', async ($, on) => {
  const h = setup(on)
  await start($)
  await $.command.run({ ...commandInput, args: 'on' })
  await $.prompt.submit({ text: 'real user task', origin: { kind: 'composer' }, wait: true })
  await h.clock.advance(20 * MIN)
  await turn($, 'queued', false)
  await h.clock.advance(165 * MIN)
  expect(h.calls()).toBe(3)
})

const bandProps = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }

test('AbovePrompt renders inline controls and a countdown, with no pane', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'band', props: bandProps })
  expect((await ui.find({ key: 'toggle' }))?.text).toContain('вкл')
  expect((await ui.find({ key: 'refresh' }))?.text).toContain('Прогреть')
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('55м')
  await ui.press({ key: 'toggle' })
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('выключен')
  expect(h.panesOpened()).toBe(0)
})

test('enabling in an existing chat tries its cached request immediately', async ($, on) => {
  const h = setup(on)
  await start($)
  await h.clock.advance(1000)
  expect(h.calls()).toBe(1)
  const report = await $.command.run({ ...commandInput, args: 'status' })
  expect(report.text).toContain('через 55 мин')
})

test('an empty chat waits for the first reply instead of pretending a cache exists', async ($, on) => {
  const h = setup(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($)
  await h.clock.advance(1000)
  expect(h.calls()).toBe(1)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('обычного сообщения')
  await h.clock.advance(120 * MIN)
  expect(h.calls()).toBe(1)
})

test('the survey is passed through without drawing the band', async ($, on) => {
  setup(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'survey', props: { ...bandProps, hasSurvey: true } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('other plugin')
})

test('session replacement through a picker stops the old conversation timer', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($)
  await $.session.end({ reason: 'resume', sessionId: 'old-chat', resume: { id: 'old-chat' } })
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(0)
})

test('an active GUI blocks startup and manual forks even if no turn-start hook was observed', async ($, on) => {
  const h = setup(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'busy-band', props: { ...bandProps, isWorking: true } })
  await h.clock.advance(1000)
  await ui.press({ key: 'refresh' })
  expect(h.calls()).toBe(0)
})

test('an old conversation fork cannot unlock a replacement conversation fork', async ($, on) => {
  let sent = 0
  const h = setup(on, async () => {
    const number = ++sent
    await h.clock.sleep((number === 1 ? 2 : 10) * MIN)
    return { isAnswered: true, text: '.', usage: good }
  })
  await start($)
  await h.clock.advance(1000)
  expect(h.calls()).toBe(1)
  await $.session.end({ reason: 'resume', sessionId: 'old-chat', resume: { id: 'old-chat' } })
  await start($)
  await h.clock.advance(1000)
  expect(h.calls()).toBe(2)
  await h.clock.advance(2 * MIN)
  const retry = $.command.run({ ...commandInput, args: 'now' })
  await h.clock.advance(1)
  expect(h.calls()).toBe(2)
  await h.clock.advance(11 * MIN)
  await retry
})

test('idle reconciliation of restored state cannot cancel a newly observed turn', async ($, on) => {
  const h = setup(on)
  on('state.get', () => ({ value: { value: {
    policy: { enabled: true, busy: true, refreshing: false, lastAt: 0, lastHumanAt: 0, ttl: '1h', pings: 0, usage: good, successful: false, turnId: 'restored', blocked: null },
    selectedTtl: '1h', lastError: '', model: 'claude-test', effort: '',
  }, version: 1 } }))
  await start($)
  await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'restored-band', props: bandProps })
  await $.turn.start({ text: 'new task', turnId: 'new-turn' })
  await h.clock.advance(1)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('Claude работает')
})

test('an API failure is visible in the inline row without a separate status window', async ($, on) => {
  const h = setup(on, { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: good })
  await start($)
  await turn($)
  await h.clock.advance(55 * MIN)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'error-band', props: bandProps })
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('429')
})

test('a completed turn clears a stale working flag even when its GUI stops rendering', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($)
  const hidden = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'hidden-band', props: { ...bandProps, isWorking: true } })
  await hidden.unmount()
  await turn($, 'completed-while-hidden')
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(1)
})

test('the GUI countdown and refresh work when prompt.submit is not marked as human input', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($, 'gui-without-human-marker', false)
  const report = await $.command.run({ ...commandInput, args: 'status' })
  expect(report.text).toContain('через 55 мин')
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'sdk-band', props: bandProps })
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('55м')
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(1)
  expect(h.notifications.length).toBe(0)
})

test('a press before the first request in a reopened process explains why no API call can run', async ($, on) => {
  const h = setup(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await start($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'no-parent', props: bandProps })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('после запуска VS Code')
  expect(h.notifications.length).toBe(0)
})

test('a repeated press shows progress and preserves the pending refresh', async ($, on) => {
  const h = setup(on, async () => { await h.clock.sleep(2 * MIN); return { isAnswered: true, text: '.', usage: good } })
  await start($)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'pending', props: bandProps })
  const first = ui.press({ key: 'refresh' })
  await h.clock.advance(1000)
  expect((await ui.find({ key: 'refresh' }))?.text).toContain('Прогреваю')
  await ui.press({ key: 'refresh' })
  await h.clock.advance(2 * MIN)
  await first
  expect(h.calls()).toBe(1)
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('прогревов 1')
})

test('only a verified refresh exports its timestamp for the native cache clock', async ($, on) => {
  const h = setup(on)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'clock-metadata', props: bandProps })
  expect(JSON.stringify(await ui.drawn())).not.toContain('cache-keeper-warm:')
  await h.clock.advance(1000)
  await ui.press({ key: 'refresh' })
  expect(JSON.stringify(await ui.drawn())).toContain('cache-keeper-warm:test-session:1000:1h')
})

test('startup repair is visible inline and survives a later unchanged check', async ($, on) => {
  let attempt = 0
  const h = setup(on, undefined, () => ({ exitCode: 0, stdout: JSON.stringify({ status: 'ok', reloadRequired: ++attempt === 1, extensions: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  await start($)
  await h.clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'repair', props: bandProps })
  expect(JSON.stringify(await ui.drawn())).toContain('перезагрузи окно')
  await h.clock.advance(5 * MIN)
  expect(JSON.stringify(await ui.drawn())).toContain('перезагрузи окно')
  expect(h.notifications.length).toBe(0)
})

test('an incompatible new extension is reported without stopping cache warming', async ($, on) => {
  const h = setup(on, undefined, () => ({ exitCode: 1, stdout: '{"status":"unsupported","reloadRequired":false,"extensions":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  await start($)
  await h.clock.advance(1)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'incompatible', props: bandProps })
  expect(JSON.stringify(await ui.drawn())).toContain('несовместим')
  await ui.press({ key: 'refresh' })
  expect((await $.command.run({ ...commandInput, args: 'status' })).text).toContain('прогревов 1')
})

test('a repair finishing after session replacement cannot add its notice to the next chat', async ($, on) => {
  const h = setup(on, undefined, async () => {
    await h.clock.sleep(2 * MIN)
    return { exitCode: 0, stdout: '{"status":"ok","reloadRequired":true,"extensions":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  })
  await start($)
  await h.clock.advance(1)
  await $.session.end({ reason: 'clear', sessionId: 'old-chat', resume: { id: 'old-chat' } })
  // No new session.start here: only old monitor's pending callback can arrive.
  await h.clock.advance(2 * MIN)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'next-chat', props: bandProps })
  expect(JSON.stringify(await ui.drawn())).not.toContain('перезагрузи окно')
})

test('disk readiness still requires runtime confirmation in every new chat', async ($, on) => {
  const h = setup(on)
  await start($)
  await h.clock.advance(1)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'runtime-check', props: bandProps })
  expect(JSON.stringify(await ui.drawn())).toContain('перезагрузи окно')
  // A dropped first acknowledgement must be retried on a later idle render.
  await h.clock.advance(15_000)
  await ui.press({ key: 'cache-keeper-clock-ready:test-session:0:1' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('перезагрузи окно')
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  const nextUi = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'runtime-check-next', props: bandProps })
  await h.clock.advance(1)
  expect(JSON.stringify(await nextUi.drawn())).toContain('перезагрузи окно')
})

test('real log accounting warms again on the next hour and exports a native clock stamp', async ($, on) => {
  const main = { input_tokens: 2, cache_read_input_tokens: 356681, cache_creation_input_tokens: 521, output_tokens: 1626 }
  const fork = { input_tokens: 14, cache_read_input_tokens: 357202, cache_creation_input_tokens: 1626, output_tokens: 3 }
  const h = setup(on, { isAnswered: true, text: '.', usage: fork }, undefined, main)
  await start($)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'actual-accounting', props: bandProps })
  await h.clock.advance(55 * MIN)
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('OK 1')
  expect(JSON.stringify(await ui.drawn())).toContain('cache-keeper-warm:test-session:3300000:1h')
  await h.clock.advance(55 * MIN)
  expect(h.calls()).toBe(2)
  expect((await ui.find({ key: 'schedule' }))?.text).toContain('OK 2')
})

test('a cache miss shows the failed refresh accounting instead of the previous main hit', async ($, on) => {
  const miss = { ...good, cache_read_input_tokens: 0, cache_creation_input_tokens: 50000 }
  const h = setup(on, { isAnswered: true, text: '.', usage: miss })
  await start($)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'cache-keeper', surface: 'vscode', component: 'AbovePrompt', requestId: 'miss-accounting', props: bandProps })
  await h.clock.advance(55 * MIN)
  const report = await $.command.run({ ...commandInput, args: 'status' })
  expect(report.text).toContain('cache read 0, write 50000')
  expect((await ui.find({ key: 'cache-ratio' }))?.text).toContain('0%')
})
