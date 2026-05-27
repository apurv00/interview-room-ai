/**
 * Composer SDK client with Anthropic fallback for QA agents.
 * Prefers CURSOR_API_KEY + @cursor/sdk; falls back to ANTHROPIC_API_KEY.
 */
import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_CURSOR_MODEL = 'composer-2.5-fast'
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-latest'

/**
 * @param {string} text
 */
export function parseJsonFromText(text) {
  const trimmed = String(text ?? '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('No JSON object in model response')
  }
  return JSON.parse(trimmed.slice(start, end + 1))
}

/**
 * @returns {'cursor' | 'anthropic' | null}
 */
export function resolveSdkBackend() {
  if (process.env.CURSOR_API_KEY) return 'cursor'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return null
}

/**
 * One-shot JSON prompt via Cursor SDK or Anthropic.
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {boolean} [opts.allowFallback]
 * @param {number} [opts.maxTokens]
 */
export async function promptJson(prompt, opts = {}) {
  const allowFallback = opts.allowFallback !== false
  const maxTokens = opts.maxTokens ?? 4096
  const backend = resolveSdkBackend()

  if (backend === 'cursor') {
    try {
      const { Agent } = await import('@cursor/sdk')
      const result = await Agent.prompt(prompt, {
        apiKey: process.env.CURSOR_API_KEY,
        model: { id: opts.model ?? DEFAULT_CURSOR_MODEL },
        local: { cwd: process.cwd(), settingSources: [] },
      })
      if (result.status === 'error') {
        throw new Error(`Cursor agent run failed: ${result.id ?? 'unknown'}`)
      }
      return {
        data: parseJsonFromText(result.result ?? ''),
        backend: 'cursor',
        model: opts.model ?? DEFAULT_CURSOR_MODEL,
      }
    } catch (err) {
      if (!allowFallback || !process.env.ANTHROPIC_API_KEY) throw err
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const model = opts.model ?? process.env.QA_SDK_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = res.content.find((b) => b.type === 'text')?.text ?? ''
    return {
      data: parseJsonFromText(text),
      backend: 'anthropic',
      model,
    }
  }

  throw new Error('Set CURSOR_API_KEY or ANTHROPIC_API_KEY for SDK QA agents')
}

/**
 * @param {string} name
 * @param {object} [opts]
 */
export async function createQaAgent(name, opts = {}) {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error(`createQaAgent(${name}): CURSOR_API_KEY not set — use promptJson() for fallback`)
  }
  const { Agent } = await import('@cursor/sdk')
  return Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: opts.model ?? DEFAULT_CURSOR_MODEL },
    local: { cwd: process.cwd(), settingSources: [] },
  })
}
