import type { InterviewConfig } from '@shared/types'
import { fetchWithRetry } from '@shared/fetchWithRetry'

export interface CreateDbSessionResult {
  sessionId: string | null
  limitReached?: boolean
}

/**
 * Fire-and-forget warm-up of Atlas connection + Redis JD/resume/session caches
 * for THIS sessionId. Triggered the moment the sessionId is known so the work
 * runs in parallel with the avatar's intro speech — the user-perceived window
 * before Q0 evaluation. Never thrown, never awaited; warming is purely additive.
 *
 * Pre-condition for Q0 not timing out at 10s: the doc-context cache LLM parses
 * (jd:ctx, resume:ctx) finish before the candidate finishes their first answer.
 * Intro speech is 3-8s, candidate answer is 10-30s, so a single warm fetch
 * here gives both caches 13-38s to populate — well beyond the 1-3s their
 * cold parses typically take.
 */
function fireWarmup(sessionId: string): void {
  try {
    fetch('/api/eval-warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => { /* warming is best-effort; do not surface */ })
  } catch {
    /* fetch threw synchronously (rare) — also best-effort */
  }
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
    if (!res.ok) return { sessionId: null }
    const data = await res.json()
    if (data.sessionId) fireWarmup(data.sessionId)
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
