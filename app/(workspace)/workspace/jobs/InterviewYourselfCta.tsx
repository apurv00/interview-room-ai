'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

interface TestDriveView {
  id: string
  label: 'Interview yourself'
  state: 'provisioning' | 'ready' | 'removed'
  jobId: string
  candidateId: string
  applicationId: string
  roundId: string | null
  issuedAt: string
  cleanupAfter: string
  removedAt: string | null
}

type TestDriveResponse = {
  testDrive?: TestDriveView | null
  inviteUrl?: unknown
  created?: unknown
  emailSent?: unknown
  error?: string
}

function isSafeInviteUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function operationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('Your browser cannot create a secure practice-interview request.')
  }
  return randomUUID.call(globalThis.crypto)
}

/**
 * Member-only onboarding CTA. It never writes an invite capability to browser
 * storage and removes the raw URL from React state after a successful copy or
 * open. A page reload uses only the safe status endpoint.
 */
export default function InterviewYourselfCta({ priority = false }: { priority?: boolean }) {
  const [testDrive, setTestDrive] = useState<TestDriveView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [starting, setStarting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualCopy, setManualCopy] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/workspace/onboarding/test-drive', {
          cache: 'no-store',
        })
        const body = (await response.json()) as TestDriveResponse
        if (!response.ok) throw new Error(body.error || 'Could not load the practice interview.')
        if (active) setTestDrive(body.testDrive ?? null)
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Could not load the practice interview.')
        }
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  async function start() {
    setStarting(true)
    setError(null)
    setNotice(null)
    setManualCopy(false)
    setInviteUrl(null)
    try {
      const response = await fetch('/api/workspace/onboarding/test-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: operationId() }),
      })
      const body = (await response.json()) as TestDriveResponse
      if (!response.ok) throw new Error(body.error || 'Could not start the practice interview.')
      setTestDrive(body.testDrive ?? null)

      // The server contract permits the raw URL only once. Treat malformed or
      // retry responses as opaque state even if an intermediary returns one.
      const rawInvite = body.created === true && isSafeInviteUrl(body.inviteUrl)
        ? body.inviteUrl
        : null
      setInviteUrl(rawInvite)
      if (rawInvite) {
        setNotice(
          body.emailSent === false
            ? 'The practice link is ready. Email delivery failed, so copy or open this one-time link now.'
            : 'The practice link was emailed only to your current member email. You can also copy or open it now.',
        )
      } else {
        setNotice('Your practice interview is ready. Use the email sent to your current member address.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the practice interview.')
    } finally {
      setStarting(false)
    }
  }

  function forgetRawInvite(message: string) {
    setInviteUrl(null)
    setManualCopy(false)
    setNotice(message)
  }

  async function copyInvite() {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      forgetRawInvite('Practice link copied. The raw link is no longer shown.')
    } catch {
      setManualCopy(true)
      setError('Clipboard access was blocked. Copy the link manually, then confirm to remove it here.')
    }
  }

  function openInvite() {
    if (!inviteUrl) return
    const opened = window.open(inviteUrl, '_blank', 'noopener,noreferrer')
    // With noopener, browsers may return null even after accepting the new
    // tab. Either way, erase the credential after this explicit user gesture.
    forgetRawInvite(
      opened
        ? 'Practice interview opened. The raw link is no longer shown.'
        : 'Opening the practice interview was requested. The raw link is no longer shown.',
    )
  }

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      const response = await fetch('/api/workspace/onboarding/test-drive', { method: 'DELETE' })
      const body = (await response.json()) as TestDriveResponse
      if (!response.ok) throw new Error(body.error || 'Could not remove the practice interview.')
      setTestDrive(null)
      setInviteUrl(null)
      setManualCopy(false)
      setNotice('Practice interview removed. Its invitation was revoked when it was still active.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the practice interview.')
    } finally {
      setRemoving(false)
    }
  }

  if (!loaded) {
    return (
      <section
        aria-label="Interview yourself"
        className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5"
      >
        <p className="text-sm text-[#536471]">Loading practice interview…</p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="interview-yourself-title"
      className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-indigo-700">
            {priority ? 'Start here' : 'Practice'}
          </p>
          <h2 id="interview-yourself-title" className="mt-1 text-lg font-semibold text-[#0f1419]">
            Interview yourself
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[#536471]">
            Try the real AI interview flow as a candidate. We create a clearly labelled practice
            job, candidate, and application, send the normal invite only to your current member
            email, and keep the normal consent and recording disclosure.
          </p>
        </div>
        {!testDrive && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            className="inline-flex shrink-0 items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {starting ? 'Setting up…' : 'Start practice interview'}
          </button>
        )}
      </div>

      {testDrive && (
        <div className="mt-4 rounded-xl border border-indigo-100 bg-white p-4">
          <p className="text-sm font-medium text-[#0f1419]">
            {testDrive.state === 'ready' ? 'Practice interview ready' : 'Practice interview is being prepared'}
          </p>
          <p className="mt-1 text-sm text-[#536471]">
            This synthetic record stays out of hiring operations and reporting totals.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/workspace/applications/${testDrive.applicationId}`}
              className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
            >
              Open practice application
            </Link>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={removing}
              className="inline-flex items-center rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {removing ? 'Removing…' : 'Remove practice interview'}
            </button>
          </div>
        </div>
      )}

      {inviteUrl && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-[#0f1419]">
            Copy or open this one-time practice link now
          </p>
          <textarea
            aria-label="One-time practice interview link"
            readOnly
            value={inviteUrl}
            className="mt-3 min-h-20 w-full rounded-lg border border-amber-200 bg-white p-2 text-xs text-[#0f1419]"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyInvite()}
              className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Copy practice link
            </button>
            <button
              type="button"
              onClick={openInvite}
              className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
            >
              Open practice interview
            </button>
            {manualCopy && (
              <button
                type="button"
                onClick={() => forgetRawInvite('Practice link removed from this page.')}
                className="inline-flex items-center rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-medium text-[#0f1419] hover:bg-slate-50"
              >
                I copied it
              </button>
            )}
          </div>
        </div>
      )}

      {notice && <p className="mt-3 text-sm text-emerald-700" role="status">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    </section>
  )
}
