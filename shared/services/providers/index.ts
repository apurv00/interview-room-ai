// ─── Provider Registry ──────────────────────────────────────────────────────
// Extensible adapter pattern for LLM providers. Each provider implements
// the ProviderAdapter interface and registers itself. The model router
// dispatches to whatever provider is configured for each task slot.
//
// To add a new provider:
//   1. Create shared/services/providers/{name}.ts implementing ProviderAdapter
//   2. Import and register it in the providers array below
//   That's it — no changes to modelRouter, types, or CMS needed.

export interface CompletionParams {
  model: string
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
  temperature?: number
}

export interface CompletionResponse {
  text: string
  inputTokens: number
  outputTokens: number
}

export interface ProviderAdapter {
  /** Unique identifier used in config (e.g. 'anthropic', 'openai') */
  name: string
  /** Human-readable label for CMS dropdown */
  label: string
  /** Returns true if the required API key is set in environment */
  isConfigured: () => boolean
  /** Run a completion against this provider */
  complete: (params: CompletionParams) => Promise<CompletionResponse>
}

// ─── Registry ───────────────────────────────────────────────────────────────

const _registry = new Map<string, ProviderAdapter>()

export function registerProvider(adapter: ProviderAdapter): void {
  _registry.set(adapter.name, adapter)
}

// ─── Auto-register built-in providers ───────────────────────────────────────
// Lazy registration: providers only register when the registry is first accessed.

let _initialized = false

function ensureInitialized() {
  if (_initialized) return
  _initialized = true
  // Import providers — each calls registerProvider() on import
  require('./anthropic')
  require('./openrouter')
  require('./openai')
  require('./google')
  require('./groq')
}

export function getProvider(name: string): ProviderAdapter | undefined {
  ensureInitialized()
  return _registry.get(name)
}

export function getConfiguredProviders(): ProviderAdapter[] {
  ensureInitialized()
  return Array.from(_registry.values()).filter((p) => p.isConfigured())
}

export function getAllProviders(): Array<{ name: string; label: string; configured: boolean }> {
  ensureInitialized()
  return Array.from(_registry.values()).map((p) => ({
    name: p.name,
    label: p.label,
    configured: p.isConfigured(),
  }))
}
