import Anthropic from '@anthropic-ai/sdk'
import { z, type ZodSchema } from 'zod'

let _client: Anthropic | null = null

/**
 * Returns a shared Anthropic client singleton.
 * The SDK automatically reads ANTHROPIC_API_KEY from the environment.
 */
export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic()
  }
  return _client
}

/**
 * Extract and parse JSON from a Claude text response, validating against a Zod schema.
 *
 * Handles common response formats:
 * - Raw JSON
 * - JSON wrapped in ```json ... ``` code blocks
 * - JSON embedded in surrounding text
 */
export function parseClaudeJSON<T>(text: string, schema: ZodSchema<T>): T {
  // Try to extract JSON from code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim()

  // Try parsing the extracted text
  try {
    const parsed = JSON.parse(jsonText)
    return schema.parse(parsed)
  } catch {
    // Fall back: find first { or [ and try from there
    const firstBrace = text.indexOf('{')
    const firstBracket = text.indexOf('[')
    const start = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)
      ? firstBrace
      : firstBracket

    if (start >= 0) {
      const isArray = text[start] === '['
      const closeChar = isArray ? ']' : '}'

      // Find matching close brace/bracket
      let depth = 0
      for (let i = start; i < text.length; i++) {
        if (text[i] === text[start]) depth++
        else if (text[i] === closeChar) depth--
        if (depth === 0) {
          const candidate = text.slice(start, i + 1)
          const parsed = JSON.parse(candidate)
          return schema.parse(parsed)
        }
      }
    }

    throw new Error(`Failed to parse Claude JSON response: ${text.slice(0, 200)}`)
  }
}
