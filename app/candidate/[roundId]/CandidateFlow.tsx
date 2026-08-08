'use client'

/**
 * Guest flow for a hire AI-interview round — magic-link model: the emailed
 * link is the authentication; the only step between the candidate and the
 * interview is the recording + AI-analysis consent gate.
 *
 * "I agree — start" calls POST /begin, which records consent server-side,
 * mints the round's synthetic guest identity, and returns a 60-second
 * single-use ticket; signIn('invite-otp') commits the session cookie and we
 * land on /candidate/[roundId]/prepare, which hands off into the engine's
 * own lobby → interview flow.
 */

import { useState, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'

interface Props {
  roundId: string
  token: string
  consentAlreadyGiven: boolean
  workspaceName: string
}

export default function CandidateFlow({
  roundId,
  token,
  consentAlreadyGiven,
  workspaceName,
}: Props) {
  const [agreed, setAgreed] = useState(consentAlreadyGiven)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)

  async function begin(e: FormEvent) {
    e.preventDefault()
    if (!agreed) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/begin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        ticket?: string
        error?: string
      }
      if (!res.ok || !data.ok || !data.ticket) {
        if (res.status === 410) {
          setError(
            'This interview link is no longer valid. Please contact the company that invited you.'
          )
        } else if (res.status === 429) {
          setError('Too many attempts. Please wait a few minutes and try again.')
        } else {
          setError(data.error || 'Something went wrong. Please try again.')
        }
        return
      }

      setSigningIn(true)
      // redirect:false so a failed sign-in (e.g. the 60s ticket expired)
      // surfaces here with a retry, instead of stranding the candidate on
      // the generic B2C /signin page.
      const result = await signIn('invite-otp', {
        ticket: data.ticket,
        redirect: false,
      })
      if (!result?.ok) {
        setSigningIn(false)
        setError('Sign-in took too long — please try again.')
        return
      }
      window.location.href = `/candidate/${encodeURIComponent(roundId)}/prepare`
    } catch {
      setSigningIn(false)
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (signingIn) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
        <p className="text-sm text-[#536471]">Setting things up…</p>
      </div>
    )
  }

  return (
    <form onSubmit={begin} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
      <h2 className="text-base font-semibold text-[#0f1419]">
        Before you start: recording &amp; consent
      </h2>
      <div className="text-sm text-[#536471] space-y-2 leading-relaxed">
        <p>This interview is conducted by an AI interviewer. During it:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Your <strong>camera and microphone are recorded</strong>, and what you say
            is transcribed.
          </li>
          <li>
            Your answers are <strong>evaluated by AI</strong> to produce scores and a
            written assessment.
          </li>
          <li>
            The recording, transcript, and assessment are shared with the hiring team
            at <strong>{workspaceName}</strong> to inform their decision — a human
            makes every hiring decision, not the AI.
          </li>
        </ul>
        <p>
          This link is personal to you — please don&apos;t forward the invite email.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-[#0f1419] cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I consent to being recorded and to my responses being analyzed by AI and
          shared with {workspaceName}.
        </span>
      </label>
      {error && <p className="text-xs text-[#f4212e]">{error}</p>}
      <button
        type="submit"
        disabled={busy || !agreed}
        className="w-full py-2.5 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 disabled:bg-[#e1e8ed] disabled:text-[#8b98a5] disabled:cursor-not-allowed transition-colors"
      >
        {busy ? 'Starting…' : consentAlreadyGiven ? 'Continue to your interview' : 'I agree — start my interview'}
      </button>
    </form>
  )
}
