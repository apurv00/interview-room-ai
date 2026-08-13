'use client'

/**
 * Read-only talent-pool suggestions for a duplicated/open requisition.
 * Nothing is added to the job until a member presses the second, explicit
 * confirmation button. The panel has no query-string or persistent client
 * storage: retry identity lives only in this rendered component state.
 */

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

type JobStatus = 'open' | 'on_hold' | 'closed'

interface PoolSuggestion {
  candidate: {
    id: string
    name: string
    email: string
  }
  matchScore: number
  matchedRequirements: string[]
  previouslySeenIn: Array<{
    jobId: string
    jobTitle: string
    stage: string
  }>
}

interface PoolSuggestionsResponse {
  suggestions?: unknown
  error?: unknown
}

interface AddPoolCandidateResponse {
  status?: unknown
  error?: unknown
}

interface Confirmation {
  suggestion: PoolSuggestion
  /** Kept only in-memory so a transient retry remains idempotent. */
  operationId: string
}

export interface PoolSuggestionPanelProps {
  jobId: string
  jobStatus: JobStatus
}

function endpoint(jobId: string): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/pool-suggestions`
}

function candidateEndpoint(jobId: string): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidates`
}

function responseError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string') {
    return (value as { error: string }).error
  }
  return fallback
}

function isSuggestion(value: unknown): value is PoolSuggestion {
  if (!value || typeof value !== 'object') return false
  const suggestion = value as Partial<PoolSuggestion>
  return Boolean(
    suggestion.candidate &&
      typeof suggestion.candidate.id === 'string' &&
      typeof suggestion.candidate.name === 'string' &&
      typeof suggestion.candidate.email === 'string' &&
      typeof suggestion.matchScore === 'number' &&
      Array.isArray(suggestion.matchedRequirements) &&
      Array.isArray(suggestion.previouslySeenIn),
  )
}

function operationId(): string {
  // All supported browsers provide randomUUID. This fallback maintains the
  // UUID shape for an older embedded browser without persisting any state.
  const random = globalThis.crypto?.randomUUID?.()
  if (random) return random
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else {
    // This is only an idempotency coordinate, never a capability or secret.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function statusMessage(status: unknown): string {
  if (status === 'already_considered') return 'This candidate is already being considered for this job.'
  if (status === 'already_decided') return 'This candidate already has a final decision for this job.'
  return 'This candidate could not be added to this job.'
}

export default function PoolSuggestionPanel({ jobId, jobStatus }: PoolSuggestionPanelProps) {
  const [suggestions, setSuggestions] = useState<PoolSuggestion[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null)
    try {
      const response = await fetch(endpoint(jobId), {
        cache: 'no-store',
        signal,
      })
      const data = (await response.json().catch(() => null)) as PoolSuggestionsResponse | null
      if (!response.ok) {
        if (!signal?.aborted) setLoadError(responseError(data, 'Could not load past-candidate suggestions.'))
        return
      }
      const raw = data?.suggestions
      if (!Array.isArray(raw) || !raw.every(isSuggestion)) {
        if (!signal?.aborted) setLoadError('The suggestion response was invalid. Refresh and try again.')
        return
      }
      if (!signal?.aborted) setSuggestions(raw)
    } catch {
      if (!signal?.aborted) setLoadError('Could not load past-candidate suggestions. Try again.')
    }
  }, [jobId])

  useEffect(() => {
    if (jobStatus !== 'open') {
      setSuggestions([])
      setLoadError(null)
      setConfirmation(null)
      return
    }
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [jobStatus, load])

  async function confirmAddToJob() {
    if (!confirmation || sending) return
    setSending(true)
    setNotice(null)
    try {
      const response = await fetch(
        candidateEndpoint(jobId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateId: confirmation.suggestion.candidate.id,
            operationId: confirmation.operationId,
          }),
        },
      )
      const data = (await response.json().catch(() => null)) as AddPoolCandidateResponse | null
      if (response.ok && (data?.status === 'created' || data?.status === 'reapplied')) {
        setSuggestions((current) =>
          current?.filter((item) => item.candidate.id !== confirmation.suggestion.candidate.id) ?? current,
        )
        setConfirmation(null)
        setNotice(`Added ${confirmation.suggestion.candidate.name} to this job.`)
        return
      }
      setNotice(responseError(data, statusMessage(data?.status)))
      // Keep confirmation + operationId available to make only a network
      // retry idempotent; explicit cancellation discards it.
    } catch {
      setNotice('Network error — no confirmation was received. You can retry safely.')
    } finally {
      setSending(false)
    }
  }

  if (jobStatus !== 'open') {
    return (
      <section className="rounded-2xl border border-[#e6ecf0] bg-white p-5" aria-labelledby="pool-suggestions-heading">
        <h2 id="pool-suggestions-heading" className="text-base font-semibold text-[#0f1419]">Past candidates</h2>
        <p className="mt-2 text-sm text-[#536471]">Suggestions are available only while this job is open.</p>
      </section>
    )
  }

  return (
    <section className="rounded-2xl border border-[#e6ecf0] bg-white p-5" aria-labelledby="pool-suggestions-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pool-suggestions-heading" className="text-base font-semibold text-[#0f1419]">Past candidates who match this job</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#536471]">
            These are read-only, deterministic requirement-overlap suggestions from this workspace’s past candidates. Reviewing them does not add anyone or contact a candidate.
          </p>
        </div>
        <Button type="button" variant="secondary" onClick={() => void load()} disabled={suggestions === null && !loadError}>
          Refresh
        </Button>
      </div>

      {notice ? <p className="mt-4 text-sm text-[#2563eb]" role="status">{notice}</p> : null}
      {loadError ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          <p>{loadError}</p>
          <Button type="button" variant="secondary" className="mt-3" onClick={() => void load()}>Try again</Button>
        </div>
      ) : null}
      {suggestions === null && !loadError ? <p className="mt-4 text-sm text-[#536471]">Loading suggestions…</p> : null}
      {suggestions?.length === 0 ? <p className="mt-4 text-sm text-[#536471]">No past candidates currently match the active requirements.</p> : null}

      {suggestions && suggestions.length > 0 ? (
        <ul className="mt-4 space-y-3" aria-label="Past candidate suggestions">
          {suggestions.map((suggestion) => (
            <li key={suggestion.candidate.id} className="rounded-xl border border-[#e6ecf0] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-[#0f1419]">{suggestion.candidate.name}</h3>
                    <Badge variant="success">{suggestion.matchScore}% requirement overlap</Badge>
                  </div>
                  <p className="mt-1 text-sm text-[#536471]">{suggestion.candidate.email}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setNotice(null)
                    setConfirmation({ suggestion, operationId: operationId() })
                  }}
                >
                  Add to job
                </Button>
              </div>
              {suggestion.matchedRequirements.length > 0 ? (
                <p className="mt-3 text-sm text-[#536471]">
                  Matches: {suggestion.matchedRequirements.join(' · ')}
                </p>
              ) : null}
              {suggestion.previouslySeenIn.length > 0 ? (
                <p className="mt-2 text-sm text-[#536471]">
                  Previously seen in: {suggestion.previouslySeenIn.map((item) => `${item.jobTitle} (${item.stage})`).join(' · ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {confirmation ? (
        <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4" role="alertdialog" aria-modal="false" aria-labelledby="pool-confirm-heading">
          <h3 id="pool-confirm-heading" className="font-semibold text-[#0f1419]">Confirm candidate addition</h3>
          <p className="mt-2 text-sm leading-6 text-[#334155]">
            Add {confirmation.suggestion.candidate.name} to this job? This is an HR action; it does not happen until you confirm and does not contact the candidate.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button type="button" onClick={() => void confirmAddToJob()} disabled={sending}>
              {sending ? 'Adding…' : 'Confirm add to job'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirmation(null)} disabled={sending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
