import { TASK_SLOT_DEFAULTS, type TaskSlot } from '@shared/services/taskSlots'
import { aiLogger } from '@shared/logger'

// ─── Slot config (inlined to avoid pulling mongoose into client bundles) ────

interface SlotConfig {
  taskSlot: string
  model: string
  fallbackModel?: string
  fallbackProvider?: string
  maxTokens: number
  provider: string
  temperature?: number
  isActive: boolean
  useToonInput?: boolean
}

// ─── In-memory cache ────────────────────────────────────────────────────────

interface CachedConfig {
  routingEnabled: boolean
  slots: Map<TaskSlot, SlotConfig>
  loadedAt: number
}

const CACHE_TTL_MS = 60_000
let _cache: CachedConfig | null = null
let _loadPromise: Promise<void> | null = null

async function loadConfig(): Promise<void> {
  if (typeof window !== 'undefined') {
    _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
    return
  }
  try {
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
      _cache = { routingEnabled: doc.routingEnabled, slots: slotMap, loadedAt: Date.now() }
    } else {
      _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
    }
  } catch (err) {
    aiLogger.warn({ err }, 'ModelRouter: failed to load config from DB, using hardcoded defaults')
    if (!_cache) {
      _cache = { routingEnabled: false, slots: new Map(), loadedAt: Date.now() }
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

export function invalidateModelConfigCache(): void {
  _cache = null
}

// ─── Resolve model for a task slot ──────────────────────────────────────────

export interface ResolvedModel {
  model: string
  maxTokens: number
  provider: string
  temperature?: number
  fallbackModel?: string
  fallbackProvider?: string
  useToonInput: boolean
}

export async function resolveModel(taskSlot: TaskSlot): Promise<ResolvedModel> {
  const config = await ensureConfig()
  const defaults = TASK_SLOT_DEFAULTS[taskSlot]

  if (!config.routingEnabled) {
    return { model: defaults.model, maxTokens: defaults.maxTokens, provider: defaults.provider, useToonInput: false }
  }

  const slotConfig = config.slots.get(taskSlot)
  if (slotConfig) {
    return {
      model: slotConfig.model,
      maxTokens: slotConfig.maxTokens,
      provider: slotConfig.provider,
      temperature: slotConfig.temperature,
      fallbackModel: slotConfig.fallbackModel,
      fallbackProvider: slotConfig.fallbackProvider ?? 'anthropic',
      useToonInput: slotConfig.useToonInput ?? false,
    }
  }

  return { model: defaults.model, maxTokens: defaults.maxTokens, provider: 'anthropic', useToonInput: false }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CompletionOptions {
  taskSlot: TaskSlot
  system: string | Array<{ type: 'text'; text: string; cache_control?: { type: string } }>
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  contextData?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
}

export interface CompletionResult {
  text: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  usedFallback: boolean
}

async function prepareMessages(
  opts: CompletionOptions,
  resolved: ResolvedModel,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
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
  return messages
}

async function callProvider(
  providerName: string,
  model: string,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  temperature?: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // Dynamic import to avoid pulling all provider SDKs into client bundles
  const { getProvider } = await import('./providers/index')
  const provider = getProvider(providerName)
  if (!provider) {
    throw new Error(`Provider "${providerName}" not registered`)
  }
  if (!provider.isConfigured()) {
    throw new Error(`Provider "${providerName}" not configured (missing API key)`)
  }
  return provider.complete({ model, system, messages, maxTokens, temperature })
}

/**
 * Run a completion against the CMS-configured model for this task slot.
 *
 * Fallback chain:
 *   1. Primary model via configured provider
 *   2. Fallback model via fallback provider (can differ from primary)
 *   3. Hardcoded Anthropic default for this slot
 */
export async function completion(opts: CompletionOptions): Promise<CompletionResult> {
  const resolved = await resolveModel(opts.taskSlot)
  const maxTokens = opts.maxTokens ?? resolved.maxTokens
  const temperature = opts.temperature ?? resolved.temperature
  const system = typeof opts.system === 'string' ? opts.system : opts.system.map(b => b.text).join('\n\n')
  const messages = await prepareMessages(opts, resolved)

  // Attempt 1: primary model via configured provider
  try {
    const result = await callProvider(resolved.provider, resolved.model, system, messages, maxTokens, temperature)
    return { ...result, model: resolved.model, provider: resolved.provider, usedFallback: false }
  } catch (primaryErr) {
    aiLogger.warn({ err: primaryErr, taskSlot: opts.taskSlot, model: resolved.model, provider: resolved.provider },
      'ModelRouter: primary failed, trying fallback')
  }

  // Attempt 2: fallback model via fallback provider (may differ from primary)
  if (resolved.fallbackModel) {
    const fbProvider = resolved.fallbackProvider ?? 'anthropic'
    try {
      const result = await callProvider(fbProvider, resolved.fallbackModel, system, messages, maxTokens, temperature)
      return { ...result, model: resolved.fallbackModel, provider: fbProvider, usedFallback: true }
    } catch (fallbackErr) {
      aiLogger.warn({ err: fallbackErr, taskSlot: opts.taskSlot, fallbackModel: resolved.fallbackModel, fallbackProvider: fbProvider },
        'ModelRouter: fallback failed, trying hardcoded Anthropic default')
    }
  }

  // Attempt 3: task slot default (may be any provider — not always Anthropic)
  const defaults = TASK_SLOT_DEFAULTS[opts.taskSlot]
  const defaultProvider = defaults.provider ?? 'anthropic'
  if (resolved.model === defaults.model && resolved.provider === defaultProvider) {
    throw new Error(`ModelRouter: all attempts failed for ${opts.taskSlot}`)
  }

  const result = await callProvider(defaultProvider, defaults.model, system, messages, defaults.maxTokens, temperature)
  return { ...result, model: defaults.model, provider: defaultProvider, usedFallback: true }
}

/**
 * Streaming version of completion. Same fallback chain.
 */
export async function completionStream(opts: CompletionOptions): Promise<CompletionResult> {
  // For non-Anthropic providers, streaming uses the same path as completion
  // since the provider adapter handles the full request/response cycle.
  // For Anthropic specifically, we could use the streaming SDK, but
  // the adapter pattern abstracts this — callers get the same interface.
  return completion(opts)
}

// ─── Re-exports for backward compatibility ──────────────────────────────────

export { getAnthropicClient } from './providers/anthropic'
export { parseClaudeJSON } from './llmClient'
