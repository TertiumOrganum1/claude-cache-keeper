import type { EngineInterface } from 'claude-code'

// File repairs must never block a model turn or share its cache/error state.
export function createClockBridge($: EngineInterface) {
  let notice = ''
  let detail = ''
  let nativeReady = false
  let checked = false
  let enabled = false
  let ticket = ''
  let active = true
  let running = false

  // mode: 'auto' re-applies a patch the user opted into; 'enable'/'disable' change that choice.
  const run = async (mode: 'auto' | 'enable' | 'disable') => {
    if (!active || running) return null
    running = true
    try {
      ticket ||= String(await $.clock.now())
      const result = await $.process.run(['python3', `${$.plugin.root}/scripts/install-clock-bridge.py`, `--${mode}`], { timeoutMs: 20_000 })
      if (!active) return null
      const report = JSON.parse(result.stdout) as { status?: string; reloadRequired?: boolean; detail?: string; extensions?: { version?: string; detail?: string }[] }
      detail = report.detail ?? report.extensions?.filter(e => e.detail).map(e => `${e.version ?? ''} ${e.detail}`).join('; ') ?? ''
      enabled = mode !== 'disable' && report.status !== 'disabled'
      checked = enabled && report.status === 'ok' && result.exitCode === 0
      if (checked || !enabled) notice = mode === 'disable' && report.status === 'ok' && report.reloadRequired ? 'Таймер Claude: перезагрузи окно' : ''
      else if (report.status === 'unsupported') notice = 'Таймер Claude: несовместимая версия'
      else if (report.status === 'missing') notice = 'Таймер Claude: расширение не найдено'
      else notice = 'Таймер Claude: ошибка восстановления'
      return report
    } catch (error) {
      if (!active) return null
      notice = 'Таймер Claude: ошибка проверки'
      detail = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      running = false
      if (active) $.ui.invalidate('ui.render')
    }
  }
  // One check per plugin start: the installer skips versions it has already patched.
  const bootstrap = $.clock.after(0, async () => { await run('auto') })
  const status = () => notice || (checked && !nativeReady ? 'Таймер Claude: перезагрузи окно' : '')
  return {
    status,
    report: () => [status(), detail].filter(Boolean).join(': '),
    ticket: () => enabled && !nativeReady ? ticket : '',
    acknowledge: () => { if (active && !nativeReady) { nativeReady = true; $.ui.invalidate('ui.render') } },
    enable: () => run('enable'),
    disable: async () => { const report = await run('disable'); nativeReady = false; return report },
    cancel: () => { active = false; bootstrap.cancel() },
  }
}
