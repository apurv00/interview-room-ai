import { aiLogger } from '@/lib/logger'

interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

/**
 * Fetch with exponential backoff retry. Resolves true on success, false if all retries fail.
 * Does NOT throw — callers should handle the boolean result.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<boolean> {
  const { maxRetries = 3, baseDelayMs = 1000 } = options

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return true
    } catch {
      // Network error — retry
    }
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)))
    }
  }

  aiLogger.warn({ url, method: init.method }, 'All fetch retries exhausted')
  return false
}
