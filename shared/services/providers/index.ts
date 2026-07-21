// ─── Provider Registry ──────────────────────────────────────────────────────
// Extensible adapter pattern for LLM providers. Each provider implements
// the ProviderAdapter interface and registers itself. The model router
// dispatches to whatever provider is configured for each task slot.
//
// To add a new provider:
//   1. Create shared/services/providers/{name}.ts implementing ProviderAdapter
//   2. Import and register it in the providers array below
//   That's it — no changes to modelRouter, types, or CMS needed.

/**
 * Reasoning-effort levels accepted by GPT-5.6-family models.
 *
 * Why 'max' is deliberately absent (Codex review on PR #500): OpenAI's
 * Chat Completions REFERENCE lists 'max' in the parameter's generic enum,
 * but the live API rejects it for EVERY GPT-5.6 tier — sol, terra, and
 * luna each return 400 "Unsupported value: 'reasoning_effort' does not
 * support 'max' with this model. Supported values are: 'none', 'low',
 * 'medium', 'high', and 'xhigh'." (probed per-model 2026-07-11; the
 * GPT-5.0-era 'minimal' is likewise rejected). Exposing 'max' in the CMS
 * would let an admin configure a value that 400s every call on that slot,
 * silently pushing it onto the fallback chain. If OpenAI enables 'max'
 * for a model we route to: re-run the live probe, then widen this union,
 * the Zod enum in modules/cms/validators/cms.ts, the Mongoose enum in
 * shared/db/models/ModelConfig.ts, and REASONING_EFFORT_OPTIONS in
 * app/(cms)/cms/model-config/page.tsx — all four reference this comment.
 *
 * Reasoning tokens are generated BEFORE the first output token and bill
 * against max_completion_tokens, so slots that opt in need budget headroom.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export interface CompletionParams {
  model: string
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  responseFormat?: CompletionResponseFormat
  /** Disable retries hidden inside a provider SDK. Legal/source-authority
   * gates are evaluated by the router per adapter attempt, so an SDK retry
   * after that gate would otherwise outlive the authority snapshot. */
  disableSdkRetries?: boolean
}

export type JsonSchema = Record<string, unknown>

export type CompletionResponseFormat =
  | {
      type: 'json_schema'
      name: string
      schema: JsonSchema
      strict?: boolean
    }
  | {
      type: 'json_object'
    }

export interface CompletionResponse {
  text: string
  inputTokens: number
  outputTokens: number
  /**
   * True when the model hit max_tokens mid-generation (OpenAI
   * finish_reason === 'length', Anthropic stop_reason === 'max_tokens').
   * Callers should treat the text as potentially truncated and decide
   * whether to retry with a larger budget or fall back.
   * Undefined when the underlying provider doesn't surface the signal.
   */
  truncated?: boolean
}

/**
 * Streaming event emitted by ProviderAdapter.stream (when implemented).
 * The modelRouter consumes this stream and may re-emit it to SSE
 * endpoints. Phase 1 (OpenAI only) only uses `delta` + `done` events;
 * `json_delta` is reserved for Phase 2 (Anthropic tool_use) and OpenAI
 * json_schema strict-mode futures — kept on the type union now so the
 * contract doesn't need to change later.
 */
export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'json_delta'; partialJson: string }
  | {
      kind: 'done'
      inputTokens: number
      outputTokens: number
      truncated: boolean
    }

export interface ProviderAdapter {
  /** Unique identifier used in config (e.g. 'anthropic', 'openai') */
  name: string
  /** Human-readable label for CMS dropdown */
  label: string
  /** Returns true if the required API key is set in environment */
  isConfigured: () => boolean
  /**
   * Run a completion against this provider.
   * `signal` is optional and propagated to the SDK so a route handler
   * can abort the upstream call when the client disconnects (Next.js
   * Route Handlers expose `req.signal` for this).
   */
  complete: (params: CompletionParams, signal?: AbortSignal) => Promise<CompletionResponse>
  /**
   * Optional: provider supports native streaming. When present,
   * modelRouter.streamCompletion delegates to this. When absent,
   * modelRouter polyfills via `complete()` so callers never have to
   * branch on capability.
   *
   * Implementations MUST:
   *   - Skip empty deltas (e.g. OpenAI's first chunk that carries only
   *     `{role:'assistant'}` with no content). The modelRouter relies
   *     on "first non-empty delta" as the boundary for its provider
   *     fallback chain.
   *   - Yield exactly one `kind:'done'` event as the terminal element.
   *   - Propagate `signal` aborts; throw on abort so the consumer's
   *     for-await loop tears down cleanly.
   */
  stream?: (params: CompletionParams, signal?: AbortSignal) => AsyncIterable<StreamEvent>
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
