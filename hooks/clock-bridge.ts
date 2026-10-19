import type { EngineInterface } from 'claude-code'

// File repairs must never block a model turn or share its cache/error state.
export function createClockBridge($: EngineInterface) {
  let notice = ''
  let detail = ''
  let nativeReady = false
  let checked = false
  let ticket = ''
  let active = true
  let running = false

  const check = async () => {
    if (!active || running) return
    running = true
    try {
      ticket ||= String(await $.clock.now())
      const result = await $.process.run(['python3', `${$.plugin.root}/scripts/install-clock-bridge.py`, '--auto'], { timeoutMs: 20_000 })
      if (!active) return
      const report = JSON.parse(result.stdout) as { status?: string; reloadRequired?: boolean; detail?: string; extensions?: { version?: string; detail?: string }[] }
      detail = report.detail ?? report.extensions?.filter(e => e.detail).map(e => `${e.version ?? ''} ${e.detail}`).join('; ') ?? ''
      checked = report.status === 'ok' && result.exitCode === 0
      if (checked) notice = ''
      else if (report.status === 'unsupported') notice = 'Таймер Claude: несовместимая версия'
      else if (report.status === 'missing') notice = 'Таймер Claude: расширение не найдено'
      else notice = 'Таймер Claude: ошибка восстановления'
    } catch (error) {
      if (!active) return
      notice = 'Таймер Claude: ошибка проверки'
      detail = error instanceof Error ? error.message : String(error)
    } finally {
      running = false
      if (active) $.ui.invalidate('ui.render')
    }
  }
  // One check per plugin start: the installer skips versions it has already patched.
  const bootstrap = $.clock.after(0, async () => { await check() })
  const status = () => notice || (checked && !nativeReady ? 'Таймер Claude: перезагрузи окно' : '')
  return {
    status,
    report: () => [status(), detail].filter(Boolean).join(': '),
    ticket: () => nativeReady ? '' : ticket,
    acknowledge: () => { if (active && !nativeReady) { nativeReady = true; $.ui.invalidate('ui.render') } },
    cancel: () => { active = false; bootstrap.cancel() },
  }
}
