import type { InterviewConfig } from '@shared/types'
import { fetchWithRetry } from '@shared/fetchWithRetry'

export interface CreateDbSessionResult {
  sessionId: string | null
  limitReached?: boolean
  /** Server rejected the depth for this experience band (403, e.g. academics at 3-6/7+). */
  forbidden?: boolean
}

export async function createDbSession(
  config: InterviewConfig,
  parentSessionId?: string
): Promise<CreateDbSessionResult> {
  try {
    const res = await fetch('/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config,
        ...(parentSessionId ? { parentSessionId } : {}),
      }),
    })
    if (res.status === 402) return { sessionId: null, limitReached: true }
    if (res.status === 403) return { sessionId: null, forbidden: true }
    if (!res.ok) return { sessionId: null }
    const data = await res.json()
    return { sessionId: data.sessionId }
  } catch {
    return { sessionId: null }
  }
}

export async function persistSession(sessionId: string, payload: Record<string, unknown>) {
  await fetchWithRetry(`/api/interviews/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
