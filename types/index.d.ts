// Native mod contracts must be self-contained: no imports from runtime files.
export type SessionState = {
  policy: {
    enabled: boolean
    busy: boolean
    refreshing: boolean
    lastAt: number | null
    lastHumanAt: number | null
    ttl: '1h' | '5m' | null
    lastWarmAt?: number | null
    lastWarmTtl?: '1h' | '5m' | null
    pings: number
    usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number } | null
    mainUsage?: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number } | null
    lastRefreshUsage?: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number } | null
    successful: boolean
    turnId: string | null
    blocked: string | null
  }
  selectedTtl: '1h' | '5m'
  lastError: string
  model: string
  effort: string
}
declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { session: SessionState }
  }
}
