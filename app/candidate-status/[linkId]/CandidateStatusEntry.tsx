'use client'

import { useEffect, useMemo, useState } from 'react'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const STATUS_CAPABILITY = /^(?:[a-f0-9]{24}\.){5}[a-f0-9]{64}$/i
const STATUS_STORAGE_PREFIX = 'hire:candidate-status:v1:'

type CandidateStatusPhase = 'received' | 'under_review' | 'interviewing' | 'decision' | 'concluded'

interface CandidateStatusView {
  phase: CandidateStatusPhase
  progress: { current: number; total: 3 }
}

interface CandidateStatusBootstrap {
  state: 'ok'
  status: CandidateStatusView
}

const STATUS_COPY: Record<CandidateStatusPhase, string> = {
  received: 'We received your application.',
  under_review: 'The hiring team is reviewing your application.',
  interviewing: 'Your application is in the interview stage.',
  decision: 'The hiring team is preparing next steps.',
  concluded: 'The hiring team has concluded this application.',
}

function isStatusCapabilityForId(raw: string, linkId: string): boolean {
  if (!OBJECT_ID.test(linkId) || !STATUS_CAPABILITY.test(raw)) return false
  const [, , , , capabilityLinkId] = raw.split('.')
  return capabilityLinkId?.toLowerCase() === linkId.toLowerCase()
}

function isCandidateStatusView(value: unknown): value is CandidateStatusView {
  if (!value || typeof value !== 'object') return false
  const view = value as {
    phase?: unknown
    progress?: { current?: unknown; total?: unknown }
  }
  const progress = view.progress
  return (
    typeof view.phase === 'string' &&
    Object.hasOwn(STATUS_COPY, view.phase) &&
    typeof progress?.current === 'number' &&
    Number.isInteger(progress.current) &&
    progress.current >= 1 &&
    progress.current <= 3 &&
    progress.total === 3
  )
}

function inactiveStatusLink() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This application status link is no longer active
        </h1>
        <p className="text-sm leading-relaxed text-[#536471]">
          Please contact the hiring team if you need an updated link.
        </p>
      </div>
    </main>
  )
}

/**
 * Sessionless public capability entry. The browser retains a fragment secret
 * only in sessionStorage for a same-tab reload, removes it from history before
 * any request, and sends it only to the fixed no-store bootstrap endpoint.
 */
export default function CandidateStatusEntry({ linkId }: { linkId: string }) {
  const [capability, setCapability] = useState<string | null>(null)
  const [status, setStatus] = useState<CandidateStatusView | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  const storageKey = useMemo(() => `${STATUS_STORAGE_PREFIX}${linkId}`, [linkId])

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const fragmentCapability = fragment.get('status')?.trim() ?? ''
    let storedCapability = ''

    try {
      storedCapability = window.sessionStorage.getItem(storageKey)?.trim() ?? ''
      if (isStatusCapabilityForId(fragmentCapability, linkId)) {
        window.sessionStorage.setItem(storageKey, fragmentCapability)
      }
    } catch {
      // Storage is only reload convenience. The original fragment suffices
      // when a browser disables it.
    }

    const resolvedCapability = isStatusCapabilityForId(fragmentCapability, linkId)
      ? fragmentCapability
      : isStatusCapabilityForId(storedCapability, linkId)
        ? storedCapability
        : ''

    // The fragment never reaches HTTP, but remove the raw possession secret
    // from history before any request or subsequent browser navigation.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )

    if (!resolvedCapability) {
      setInvalid(true)
      return
    }
    setCapability(resolvedCapability)
  }, [linkId, storageKey])

  useEffect(() => {
    if (!capability || invalid) return
    let cancelled = false
    setLoadError(null)

    void fetch(`/api/candidate-status/${encodeURIComponent(linkId)}/bootstrap`, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => ({}))) as Partial<CandidateStatusBootstrap>
        if (cancelled) return
        if (response.status === 410) {
          setInvalid(true)
          return
        }
        if (!response.ok || payload.state !== 'ok' || !isCandidateStatusView(payload.status)) {
          setLoadError('We could not load your application status. Please try again.')
          return
        }
        setStatus(payload.status)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('We could not load your application status. Please try again.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [capability, invalid, linkId, loadAttempt])

  if (invalid) return inactiveStatusLink()

  if (loadError && capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <div role="alert">
            <h1 className="text-lg font-semibold text-[#0f1419]">
              We could not load your application status
            </h1>
            <p className="mt-2 text-sm text-[#536471]">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className="rounded-lg bg-[#2563eb] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/40"
          >
            Try again
          </button>
        </div>
      </main>
    )
  }

  if (!status || !capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening your application status…
        </p>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <section className="w-full max-w-md space-y-6 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">Application status</p>
          <h1 className="text-xl font-semibold text-[#0f1419]">{STATUS_COPY[status.phase]}</h1>
          <p className="text-sm leading-relaxed text-[#536471]">
            We will contact you directly if there is an update that needs your response.
          </p>
        </header>
        <div
          aria-label={`Application progress: step ${status.progress.current} of ${status.progress.total}`}
        >
          <div className="flex justify-between text-xs text-[#71767b]">
            <span>Progress</span>
            <span>
              Step {status.progress.current} of {status.progress.total}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e5e7eb]">
            <div
              className="h-full rounded-full bg-[#2563eb] transition-[width]"
              style={{
                width: `${(status.progress.current / status.progress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      </section>
    </main>
  )
}
