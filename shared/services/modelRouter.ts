import Anthropic from '@anthropic-ai/sdk'
import { TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'

// Inline the slot config interface to avoid importing ModelConfig (which pulls mongoose into client bundles)
interface SlotConfig {
  taskSlot: string
  model: string
  fallbackModel?: string
  maxTokens: number
  provider: 'anthropic' | 'openrouter'
  temperature?: number
  isActive: boolean
  useToonInput?: boolean
}
import { aiLogger } from '@shared/logger'

// ─── In-memory cache ────────────────────────────────────────────────────────
// Reloaded from DB every 60s. Falls back to hardcoded defaults if DB is down.

interface CachedConfig {
  openRouterEnabled: boolean
  slots: Map<TaskSlot, SlotConfig>
  loadedAt: number
}

const CACHE_TTL_MS = 60_000
let _cache: CachedConfig | null = null
let _loadPromise: Promise<void> | null = null

async function loadConfig(): Promise<void> {
  // Skip DB access entirely on the client — only server-side loads config
  if (typeof window !== 'undefined') {
    _cache = { openRouterEnabled: false, slots: new Map(), loadedAt: Date.now() }
    return
  }
  try {
    // Use eval('require') to prevent webpack from statically analyzing
    // and bundling mongoose into client-side chunks. This code only runs
    // server-side (guarded by the typeof window check above).
    const _require = eval('require') as NodeRequire
    const { connectDB } = _require('@shared/db/connection') as typeof import('@shared/db/connection')
    const { ModelConfig } = _require('@shared/db/models/ModelConfig') as typeof import('@shared/db/models/ModelConfig')
    await connectDB()
    const doc = await ModelConfig.getConfig()
    if (doc) {
      const slotMap = new Map<TaskSlot, SlotConfig>()
      for (const slot of doc.slots) {
        if (slot.isActive) {
          slotMap.set(slot.taskSlot, slot)
        }
      }
      _cache = { openRouterEnabled: doc.openRouterEnabled, slots: slotMap, loadedAt: Date.now() }
    } else {
      // No config in DB — use defaults via Anthropic
      _cache = { openRouterEnabled: false, slots: new Map(), loadedAt: Date.now() }
    }
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: failed to load config from DB, using hardcoded defaults')
    if (!_cache) {
      _cache = { openRouterEnabled: false, slots: new Map(), loadedAt: Date.now() }
    }
  }
}

async function ensureConfig(): Promise<CachedConfig> {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache
  }
  if (!_loadPromise) {
    _loadPromise = loadConfig().finally(() => { _loadPromise = null })
  }
  await _loadPromise
  return _cache!
}

/** Force-refresh the cached config (e.g. after CMS update). */
export function invalidateModelConfigCache(): void {
  _cache = null
}

// ─── Resolve model for a task slot ──────────────────────────────────────────

export interface ResolvedModel {
  model: string
  maxTokens: number
  provider: 'anthropic' | 'openrouter'
  temperature?: number
  fallbackModel?: string
  useToonInput: boolean
}

export async function resolveModel(taskSlot: TaskSlot): Promise<ResolvedModel> {
  const config = await ensureConfig()
  const defaults = TASK_SLOT_DEFAULTS[taskSlot]

  // If OpenRouter is disabled globally, use Anthropic defaults
  if (!config.openRouterEnabled) {
    return { model: defaults.model, maxTokens: defaults.maxTokens, provider: 'anthropic', useToonInput: false }
  }

  // Check if there's a CMS-configured slot override
  const slotConfig = config.slots.get(taskSlot)
  if (slotConfig) {
    return {
      model: slotConfig.model,
      maxTokens: slotConfig.maxTokens,
      provider: slotConfig.provider,
      temperature: slotConfig.temperature,
      fallbackModel: slotConfig.fallbackModel,
      useToonInput: slotConfig.useToonInput ?? false,
    }
  }

  // No override — use hardcoded default via Anthropic
  return { model: defaults.model, maxTokens: defaults.maxTokens, provider: 'anthropic', useToonInput: false }
}

// ─── OpenRouter client ──────────────────────────────────────────────────────
// OpenRouter is API-compatible with the Anthropic SDK — we just point it at
// a different base URL and use OPENROUTER_API_KEY instead.

let _anthropicClient: Anthropic | null = null
let _openRouterClient: Anthropic | null = null

function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic()
  }
  return _anthropicClient
}

function getOpenRouterClient(): Anthropic {
  if (!_openRouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      aiLogger.warn('OPENROUTER_API_KEY not set — falling back to Anthropic')
      return getAnthropicClient()
    }
    _openRouterClient = new Anthropic({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }
  return _openRouterClient
}

function getClient(provider: 'anthropic' | 'openrouter'): Anthropic {
  return provider === 'openrouter' ? getOpenRouterClient() : getAnthropicClient()
}

// ─── Public API: create a completion with automatic fallback ────────────────

export interface CompletionOptions {
  taskSlot: TaskSlot
  system: string | Array<{ type: 'text'; text: string; cache_control?: { type: string } }>
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Structured data to TOON-encode and append to the last user message.
   *  Only encoded as TOON when the slot has useToonInput=true in CMS config;
   *  otherwise JSON.stringify'd. Falls back to JSON on any encoding error. */
  contextData?: Record<string, unknown>
  /** Override max_tokens from the resolved model config */
  maxTokens?: number
  /** Override temperature */
  temperature?: number
}

export interface CompletionResult {
  text: string
  model: string
  provider: 'anthropic' | 'openrouter'
  inputTokens: number
  outputTokens: number
  /** Whether this used the fallback model */
  usedFallback: boolean
}

/**
 * Run a completion against the CMS-configured model for this task slot.
 *
 * Fallback chain:
 *   1. Primary model via configured provider
 *   2. Fallback model (if configured) via same provider
 *   3. Hardcoded Anthropic default for this slot
 *
 * If all three fail, the error propagates to the caller.
 */
export async function completion(opts: CompletionOptions): Promise<CompletionResult> {
  const resolved = await resolveModel(opts.taskSlot)
  const maxTokens = opts.maxTokens ?? resolved.maxTokens
  const temperature = opts.temperature ?? resolved.temperature

  // If contextData provided, encode and append to last user message
  let messages = opts.messages
  if (opts.contextData && Object.keys(opts.contextData).length > 0) {
    const { encodeContextData } = await import('./toonEncoder')
    const suffix = resolved.useToonInput
      ? encodeContextData(opts.contextData)
      : '\n\n' + Object.entries(opts.contextData)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}:\n${JSON.stringify(v, null, 0)}`)
          .join('\n\n')

    messages = [...opts.messages]
    const lastIdx = messages.length - 1
    if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
      messages[lastIdx] = { ...messages[lastIdx], content: messages[lastIdx].content + suffix }
    }
  }

  const params = {
    max_tokens: maxTokens,
    system: opts.system as string,
    messages,
    ...(temperature !== undefined && { temperature }),
  }

  // Attempt 1: primary model
  try {
    const client = getClient(resolved.provider)
    const message = await client.messages.create({
      ...params,
      model: resolved.model,
    })
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return {
      text,
      model: resolved.model,
      provider: resolved.provider,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      usedFallback: false,
    }
  } catch (primaryErr) {
    aiLogger.warn({ err: primaryErr, taskSlot: opts.taskSlot, model: resolved.model },
      'ModelRouter: primary model failed, trying fallback')
  }

  // Attempt 2: fallback model (if configured)
  if (resolved.fallbackModel) {
    try {
      const client = getClient(resolved.provider)
      const message = await client.messages.create({
        ...params,
        model: resolved.fallbackModel,
      })
      const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
      return {
        text,
        model: resolved.fallbackModel,
        provider: resolved.provider,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        usedFallback: true,
      }
    } catch (fallbackErr) {
      aiLogger.warn({ err: fallbackErr, taskSlot: opts.taskSlot, fallbackModel: resolved.fallbackModel },
        'ModelRouter: fallback model failed, trying hardcoded Anthropic default')
    }
  }

  // Attempt 3: hardcoded Anthropic default (always available)
  const defaults = TASK_SLOT_DEFAULTS[opts.taskSlot]
  if (resolved.model === defaults.model && resolved.provider === 'anthropic') {
    // Already tried this exact model — don't retry, just throw
    throw new Error(`ModelRouter: all attempts failed for ${opts.taskSlot}`)
  }

  const anthropicClient = getAnthropicClient()
  const message = await anthropicClient.messages.create({
    ...params,
    model: defaults.model,
    max_tokens: defaults.maxTokens,
  })
  const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  return {
    text,
    model: defaults.model,
    provider: 'anthropic',
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    usedFallback: true,
  }
}

/**
 * Streaming version of completion. Same fallback chain.
 * Returns a stream that yields the final message.
 */
export async function completionStream(opts: CompletionOptions): Promise<CompletionResult> {
  const resolved = await resolveModel(opts.taskSlot)
  const maxTokens = opts.maxTokens ?? resolved.maxTokens
  const temperature = opts.temperature ?? resolved.temperature

  // If contextData provided, encode and append to last user message
  let messages = opts.messages
  if (opts.contextData && Object.keys(opts.contextData).length > 0) {
    const { encodeContextData } = await import('./toonEncoder')
    const suffix = resolved.useToonInput
      ? encodeContextData(opts.contextData)
      : '\n\n' + Object.entries(opts.contextData)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}:\n${JSON.stringify(v, null, 0)}`)
          .join('\n\n')

    messages = [...opts.messages]
    const lastIdx = messages.length - 1
    if (lastIdx >= 0 && messages[lastIdx].role === 'user') {
      messages[lastIdx] = { ...messages[lastIdx], content: messages[lastIdx].content + suffix }
    }
  }

  const params = {
    max_tokens: maxTokens,
    system: opts.system as string,
    messages,
    ...(temperature !== undefined && { temperature }),
  }

  // Attempt 1: primary
  try {
    const client = getClient(resolved.provider)
    const stream = client.messages.stream({ ...params, model: resolved.model })
    const message = await stream.finalMessage()
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return {
      text,
      model: resolved.model,
      provider: resolved.provider,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      usedFallback: false,
    }
  } catch (primaryErr) {
    aiLogger.warn({ err: primaryErr, taskSlot: opts.taskSlot, model: resolved.model },
      'ModelRouter: stream primary failed, trying fallback')
  }

  // Attempt 2: fallback
  if (resolved.fallbackModel) {
    try {
      const client = getClient(resolved.provider)
      const stream = client.messages.stream({ ...params, model: resolved.fallbackModel })
      const message = await stream.finalMessage()
      const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
      return {
        text,
        model: resolved.fallbackModel,
        provider: resolved.provider,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        usedFallback: true,
      }
    } catch {
      // fall through
    }
  }

  // Attempt 3: hardcoded default
  const defaults = TASK_SLOT_DEFAULTS[opts.taskSlot]
  const anthropicClient = getAnthropicClient()
  const stream = anthropicClient.messages.stream({ ...params, model: defaults.model, max_tokens: defaults.maxTokens })
  const message = await stream.finalMessage()
  const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  return {
    text,
    model: defaults.model,
    provider: 'anthropic',
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    usedFallback: true,
  }
}

// Re-export for backward compat — existing code that imports getAnthropicClient still works
export { getAnthropicClient }
export { parseClaudeJSON } from './llmClient'
