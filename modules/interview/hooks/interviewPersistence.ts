import type { InterviewConfig } from '@shared/types'
import { fetchWithRetry } from '@shared/fetchWithRetry'

export interface CreateDbSessionResult {
  sessionId: string | null
  limitReached?: boolean
}

export async function createDbSession(config: InterviewConfig): Promise<CreateDbSessionResult> {
  try {
    const res = await fetch('/api/interviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (res.status === 402) return { sessionId: null, limitReached: true }
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
