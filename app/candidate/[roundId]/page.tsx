/**
 * Guest landing for a hire AI-interview round: /candidate/[roundId]?token=…
 *
 * Server component — the invite token is verified server-side before anything
 * renders (v1 invite-page posture): every failure mode gets the same generic
 * "no longer valid" page so the URL can't be probed for state, and the page
 * is noindex. A valid link renders the consent + recording disclosure gate
 * (CandidateFlow); the link itself is the authentication (magic-link model)
 * and /begin refuses to mint a session ticket until consent is recorded.
 */

import type { Metadata } from 'next'
import { verifyRoundToken, HireJob, HireWorkspace } from '@hire'
import CandidateFlow from './CandidateFlow'
import GuestSignOut from './GuestSignOut'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your interview — IPG Hire',
  robots: { index: false, follow: false },
}

function obfuscateEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return '***'
  return `${local[0]}***@${domain}`
}

function InvalidLink({ roundId }: { roundId: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      {/* Terminal state: a lingering synthetic-guest session ends here —
          scoped to THIS round so an old link never ends a newer round's
          live session (multi-invite bug, 2026-08-09). */}
      <GuestSignOut roundId={roundId} />
      <div className="max-w-md w-full bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-3">
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

function AlreadyCompleted({ roundId }: { roundId: string }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      {/* Terminal state: a lingering synthetic-guest session ends here —
          revisiting a finished invite must leave the candidate logged out.
          Scoped to THIS round only (multi-invite bug, 2026-08-09). */}
      <GuestSignOut roundId={roundId} />
      <div className="max-w-md w-full bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-3">
        <div className="text-3xl">✅</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">Interview completed</h1>
        <p className="text-sm text-[#536471]">
          You already finished this interview — nothing else is needed from you.
          The hiring team has your results.
        </p>
      </div>
    </main>
  )
}

export default async function CandidateLandingPage({
  params,
  searchParams,
}: {
  params: { roundId: string }
  searchParams: { token?: string }
}) {
  const token = searchParams.token
  if (!token) return <InvalidLink roundId={params.roundId} />

  const verified = await verifyRoundToken(params.roundId, token).catch(() => null)
  if (!verified) return <InvalidLink roundId={params.roundId} />
  if (verified.state === 'completed') return <AlreadyCompleted roundId={params.roundId} />
  if (verified.state !== 'ok') return <InvalidLink roundId={params.roundId} />

  const { round } = verified
  const [job, workspace] = await Promise.all([
    HireJob.findOne({ _id: round.jobId, workspaceId: round.workspaceId })
      .select('title')
      .lean(),
    HireWorkspace.findById(round.workspaceId).select('name').lean(),
  ])
  if (!job || !workspace) return <InvalidLink roundId={params.roundId} />

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="max-w-lg mx-auto space-y-6">
        <header className="text-center space-y-1">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            {workspace.name} · AI interview
          </p>
          <h1 className="text-xl font-bold text-[#0f1419]">{job.title}</h1>
          <p className="text-sm text-[#536471]">
            About {round.config.duration} minutes · do it whenever you&apos;re ready
          </p>
        </header>
        <CandidateFlow
          roundId={params.roundId}
          token={token}
          authMode={round.authMode === 'otp' ? 'otp' : 'magic_link'}
          consentAlreadyGiven={!!round.consentAt}
          emailHint={obfuscateEmail(round.candidateEmail)}
          workspaceName={workspace.name}
        />
      </div>
    </main>
  )
}
