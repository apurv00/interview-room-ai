'use client'

import { useEffect, useState } from 'react'
import CandidateFlow from './CandidateFlow'
import CandidatePrivacyRequest from './CandidatePrivacyRequest'

const INVITE_CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{64}$/i

interface CandidateBootstrap {
  state: 'ok' | 'expired' | 'completed' | 'revoked'
  privacyAvailable: boolean
  workspaceName?: string
  jobTitle?: string
  duration?: number
  authMode?: 'magic_link' | 'otp'
  consentAlreadyGiven?: boolean
  emailHint?: string
}

export default function CandidateEntry({ roundId }: { roundId: string }) {
  const [capability, setCapability] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<CandidateBootstrap | null>(null)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const invite = fragment.get('invite')?.trim() ?? ''

    // Fragments are never sent in the page request. Scrub the secret from
    // history before the first client-initiated request as well.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )

    if (!INVITE_CAPABILITY.test(invite)) {
      setInvalid(true)
      return
    }
    setCapability(invite)

    let cancelled = false
    void fetch(`/api/candidate/${encodeURIComponent(roundId)}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: invite }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as CandidateBootstrap
        if (cancelled) return
        if (!response.ok || !payload.state) {
          setInvalid(true)
          return
        }
        setBootstrap(payload)
      })
      .catch(() => {
        if (!cancelled) setInvalid(true)
      })

    return () => {
      cancelled = true
    }
  }, [roundId])

  if (!invalid && !bootstrap) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening your secure interview…
        </p>
      </main>
    )
  }

  if (invalid || !bootstrap || !capability) {
    return <InvalidInvite />
  }

  if (bootstrap.state !== 'ok') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-4 py-8">
          <div className="space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
            <div className="text-3xl">{bootstrap.state === 'completed' ? '✅' : '🔗'}</div>
            <h1 className="text-lg font-semibold text-[#0f1419]">
              {bootstrap.state === 'completed'
                ? 'Interview completed'
                : 'This interview link is no longer valid'}
            </h1>
            <p className="text-sm text-[#536471]">
              {bootstrap.state === 'completed'
                ? 'You already finished this interview. The hiring team has your results.'
                : 'The link may have expired or been replaced. Contact the company that invited you for a new one.'}
            </p>
          </div>
          {bootstrap.privacyAvailable ? (
            <CandidatePrivacyRequest roundId={roundId} capability={capability} />
          ) : null}
        </div>
      </main>
    )
  }

  if (
    !bootstrap.workspaceName ||
    !bootstrap.jobTitle ||
    !bootstrap.duration ||
    !bootstrap.authMode ||
    !bootstrap.emailHint
  ) {
    return <InvalidInvite />
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="mx-auto max-w-lg space-y-6">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            {bootstrap.workspaceName} · AI interview
          </p>
          <h1 className="text-xl font-bold text-[#0f1419]">{bootstrap.jobTitle}</h1>
          <p className="text-sm text-[#536471]">
            About {bootstrap.duration} minutes · do it whenever you&apos;re ready
          </p>
        </header>
        <CandidateFlow
          roundId={roundId}
          capability={capability}
          authMode={bootstrap.authMode}
          consentAlreadyGiven={Boolean(bootstrap.consentAlreadyGiven)}
          emailHint={bootstrap.emailHint}
          workspaceName={bootstrap.workspaceName}
        />
        <CandidatePrivacyRequest roundId={roundId} capability={capability} />
      </div>
    </main>
  )
}

function InvalidInvite() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This interview link is no longer valid
        </h1>
        <p className="text-sm text-[#536471]">
          The link may have expired or been replaced. Please contact the company
          that invited you for a new one.
        </p>
      </div>
    </main>
  )
}
