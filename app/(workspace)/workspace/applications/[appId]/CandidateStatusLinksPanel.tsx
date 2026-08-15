'use client'

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

interface CandidateStatusLinkView {
  id: string
  applicationId: string
  active: boolean
  expiresAt: string
  revokedAt: string | null
}

function memberLinkView(value: unknown): CandidateStatusLinkView | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.applicationId !== 'string' ||
    typeof record.active !== 'boolean' ||
    typeof record.expiresAt !== 'string' ||
    (record.revokedAt !== null && typeof record.revokedAt !== 'string')
  ) {
    return null
  }
  // Copy only the intentionally bounded member DTO. A wider or hostile API
  // response must not live in React state, even if it is never rendered.
  return {
    id: record.id,
    applicationId: record.applicationId,
    active: record.active,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  }
}

function statusBadge(link: CandidateStatusLinkView): {
  label: string
  variant: 'default' | 'primary' | 'caution'
} {
  if (link.revokedAt || !link.active) return { label: 'revoked', variant: 'default' }
  if (new Date(link.expiresAt).getTime() <= Date.now()) {
    return { label: 'expired', variant: 'caution' }
  }
  return { label: 'active', variant: 'primary' }
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString()
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return typeof body.error === 'string' ? body.error : fallback
}

/**
 * Member-only status-link manager. The copy-once capability is held in state
 * only after a successful issue response, never copied from a list/revoke
 * response, and erased as soon as a member confirms a clipboard/manual copy.
 */
export default function CandidateStatusLinksPanel({ applicationId }: { applicationId: string }) {
  const [links, setLinks] = useState<CandidateStatusLinkView[]>([])
  const [opened, setOpened] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showIssue, setShowIssue] = useState(false)
  const [expiresInDays, setExpiresInDays] = useState(30)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [copyUrl, setCopyUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        `/api/workspace/applications/${encodeURIComponent(applicationId)}/candidate-status-links`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        setError(await responseError(response, 'Could not load candidate status links.'))
        return
      }
      const body = await response.json().catch(() => ({}))
      const responseLinks: unknown[] = Array.isArray(body.candidateStatusLinks)
        ? body.candidateStatusLinks
        : []
      const safeLinks = responseLinks
        .map((value) => memberLinkView(value))
        .filter((link): link is CandidateStatusLinkView => link !== null)
        // The server enforces this too. Keep a narrow client boundary so a
        // malformed response cannot display another application's state.
        .filter((link) => link.applicationId === applicationId)
      setLinks(safeLinks)
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setLoading(false)
    }
  }, [applicationId])

  useEffect(() => {
    if (!opened) return
    void load()
  }, [load, opened])

  function toggleManager() {
    if (opened) {
      // Hiding the manager also discards a still-unclaimed capability; it is
      // intentionally not recoverable from the hash-only server record.
      setCopyUrl(null)
      setShowIssue(false)
    }
    setOpened((value) => !value)
  }

  async function issueLink() {
    const commandId = operationId ?? crypto.randomUUID()
    setOperationId(commandId)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(
        `/api/workspace/applications/${encodeURIComponent(applicationId)}/candidate-status-links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: commandId, expiresInDays }),
          cache: 'no-store',
        },
      )
      if (!response.ok) {
        setError(await responseError(response, 'Could not create a candidate status link.'))
        return
      }
      const body = await response.json().catch(() => ({}))
      if (body.created === true && typeof body.statusUrl === 'string') {
        // This is the sole capability-bearing state in the component.
        setCopyUrl(body.statusUrl)
        setNotice('Status link created. Copy it now; it cannot be recovered later.')
      } else {
        setCopyUrl(null)
        setNotice(
          'This request was already completed. The one-time link cannot be recovered; create a new link if needed.',
        )
      }
      setOperationId(null)
      setShowIssue(false)
      await load()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  function discardCopyUrl(message: string) {
    setCopyUrl(null)
    setNotice(message)
  }

  async function copyLink() {
    if (!copyUrl) return
    try {
      await navigator.clipboard.writeText(copyUrl)
      discardCopyUrl('Status link copied. The raw link is no longer shown.')
    } catch {
      setError('Clipboard access was blocked. Copy the link manually, then hide it here.')
    }
  }

  async function revokeLink(link: CandidateStatusLinkView) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(
        `/api/workspace/candidate-status-links/${encodeURIComponent(link.id)}/revoke`,
        { method: 'POST', cache: 'no-store' },
      )
      if (!response.ok) {
        setError(await responseError(response, 'Could not revoke this candidate status link.'))
        return
      }
      setCopyUrl(null)
      setNotice('Candidate status link revoked.')
      await load()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-5"
      aria-labelledby="candidate-status-links-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="candidate-status-links-heading" className="text-sm font-semibold text-[#0f1419]">
            Candidate status links
          </h2>
          <p className="mt-1 text-xs text-[#71767b]">
            Create a private, expiring application-status link for this candidate. No email is sent automatically.
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={busy} onClick={toggleManager}>
          {opened ? 'Hide status-link manager' : 'Manage status links'}
        </Button>
      </div>

      {!opened ? (
        <p className="text-xs text-[#71767b]">
          Open the manager to create, revoke, or review candidate status links.
        </p>
      ) : null}

      {opened ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setShowIssue((value) => !value)}
          >
            {showIssue ? 'Cancel status link' : 'Create candidate status link'}
          </Button>

          {error ? <p className="text-sm text-[#f4212e]" role="alert">{error}</p> : null}
          {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

          {showIssue ? (
            <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div>
                <h3 className="text-sm font-medium text-indigo-950">Create a copy-only status link</h3>
                <p className="mt-1 text-xs text-indigo-900">
                  The candidate sees only a neutral progress state. The raw link is available once and is never sent by this product.
                </p>
              </div>
              <label className="block text-sm text-indigo-950" htmlFor="candidate-status-expiry">
                Link expiry
              </label>
              <select
                id="candidate-status-expiry"
                value={expiresInDays}
                onChange={(event) => {
                  setExpiresInDays(Number(event.target.value))
                  setOperationId(null)
                }}
                className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-[#0f1419]"
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
              <div>
                <Button size="sm" disabled={busy} onClick={() => void issueLink()}>
                  {busy ? 'Creating…' : 'Create copy-only link'}
                </Button>
              </div>
            </div>
          ) : null}

          {copyUrl ? (
            <div className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
              <p className="font-medium text-indigo-950">Copy this one-time candidate status link now.</p>
              <textarea
                aria-label="One-time candidate status link"
                readOnly
                rows={3}
                value={copyUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="block w-full resize-y rounded-lg border border-indigo-200 bg-white p-2 text-xs text-indigo-900"
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
                  Copy candidate status link
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => discardCopyUrl('Status link hidden after your manual copy.')}
                >
                  I copied it — hide link
                </Button>
              </div>
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-[#536471]" role="status">Loading candidate status links…</p>
          ) : links.length === 0 ? (
            <p className="text-sm text-[#536471]">No candidate status links created yet.</p>
          ) : (
            <div className="space-y-3">
              {links.map((link) => {
                const chip = statusBadge(link)
                return (
                  <div key={link.id} className="space-y-3 rounded-xl border border-[#e1e8ed] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-[#0f1419]">Candidate status link</p>
                        <p className="mt-1 text-xs text-[#71767b]">
                          Expires {formatTimestamp(link.expiresAt)}
                          {link.revokedAt ? ` · revoked ${formatTimestamp(link.revokedAt)}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={chip.variant}>{chip.label}</Badge>
                        {link.active && !link.revokedAt ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void revokeLink(link)}
                          >
                            Revoke status link
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
