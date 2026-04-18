/**
 * /invite/[sessionId]?token=xxx — candidate-facing landing page for a
 * recruiter-issued interview invite.
 *
 * Server component: validates the token against the stored hash, fetches
 * the candidate-facing metadata (role, org name, candidate name), and
 * renders the OTP flow. We do the validation server-side so an invalid
 * token never renders the OTP form in the first place — that's better UX
 * than letting the candidate type their email before we tell them the
 * link is bad.
 *
 * Security: the `token` and `sessionId` are the only gates. No NextAuth
 * session required (the candidate is not yet signed in). Everything
 * leaked into the page body is public-by-design (role label, org name,
 * first name) — no session tokens, no recruiter notes.
 */

import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { connectDB } from '@shared/db/connection'
import { InterviewSession, Organization } from '@shared/db/models'
import { verifyInviteToken } from '@b2b/services/hireService'
import OtpFlow from './OtpFlow'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your interview invite',
  description: 'Start your invited interview.',
  robots: { index: false, follow: false },
}

interface InviteData {
  role: string
  interviewType: string
  duration: number
  candidateFirstName: string | null
  orgName: string | null
  emailHint: string
}

async function loadInvite(
  sessionId: string,
  token: string,
): Promise<InviteData | null> {
  if (!sessionId || !token) return null

  // Token validity is the gate — a leaked invite link without the token
  // must not even reveal that the session exists.
  const ok = await verifyInviteToken(sessionId, token).catch(() => false)
  if (!ok) return null

  await connectDB()
  const session = await InterviewSession.findById(sessionId)
    .select(
      'candidateEmail candidateName config.role config.interviewType config.duration organizationId status',
    )
    .lean()

  if (!session || !session.candidateEmail) return null
  if (session.status !== 'created') return null

  const orgDoc = session.organizationId
    ? await Organization.findById(session.organizationId).select('name').lean()
    : null

  const candidateFirstName = session.candidateName?.trim().split(/\s+/)[0] || null
  const emailHint = obfuscateEmail(session.candidateEmail)

  return {
    role: session.config?.role ?? 'Interview',
    interviewType: session.config?.interviewType ?? '',
    duration: Number(session.config?.duration ?? 30),
    candidateFirstName,
    orgName: orgDoc?.name ?? null,
    emailHint,
  }
}

/** `j***@example.com` — enough to confirm the right invitee, not enough to enumerate. */
function obfuscateEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return 'your email'
  const first = local[0] ?? ''
  return `${first}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: { sessionId: string }
  searchParams: { token?: string }
}) {
  const token = searchParams.token ?? ''
  const invite = await loadInvite(params.sessionId, token)

  if (!invite) {
    // Either the link is bad, expired, already consumed, or the session
    // has moved past `created`. Render a generic "link invalid" page
    // rather than distinguishing reasons — avoids enumeration and keeps
    // the UX simple.
    return (
      <main className="min-h-screen flex items-center justify-center px-4 bg-white">
        <div className="max-w-md w-full text-center space-y-3">
          <h1 className="text-xl font-semibold text-[#0f1419]">
            This invite link is no longer valid
          </h1>
          <p className="text-sm text-[#536471]">
            It may have expired, been used already, or the URL is incomplete.
            Please contact the recruiter who sent you the invite for a new link.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10 bg-white">
      <div className="w-full max-w-md space-y-6">
        <header className="text-center space-y-1.5">
          <h1 className="text-xl font-semibold text-[#0f1419]">
            {invite.candidateFirstName ? `Hi ${invite.candidateFirstName},` : 'Welcome'}
          </h1>
          <p className="text-sm text-[#536471]">
            You&apos;ve been invited to a{' '}
            <strong>{invite.role}</strong>
            {invite.interviewType ? ` ${formatType(invite.interviewType)}` : ''} interview
            {invite.orgName ? ` with ${invite.orgName}` : ''}.
          </p>
          <p className="text-xs text-[#71767b]">
            Expected duration: {invite.duration} minutes.
          </p>
        </header>

        <OtpFlow
          sessionId={params.sessionId}
          token={token}
          expectedEmailHint={invite.emailHint}
        />

        <p className="text-center text-xs text-[#71767b]">
          This link is single-use. After verification you&apos;ll be taken to
          the interview room.
        </p>
      </div>
    </main>
  )
}

function formatType(type: string): string {
  return type
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
