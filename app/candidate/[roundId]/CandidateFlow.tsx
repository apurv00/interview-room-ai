'use client'

/**
 * Guest flow for a hire AI-interview round. The company chose the
 * verification mode when the round was sent (round.authMode):
 *
 *   magic_link — consent → /begin returns the ticket → sign-in → interview.
 *   otp        — consent → /begin emails a 6-digit code to the address on
 *                record → code step → /verify returns the ticket.
 *
 * Either way, the consent gate comes first and the server refuses to mint a
 * ticket without the recorded consent.
 */

import { useState, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'

interface Props {
  roundId: string
  token: string
  authMode: 'magic_link' | 'otp'
  consentAlreadyGiven: boolean
  /** Obfuscated candidate email (j***@example.com) — shown on the code step. */
  emailHint: string
  workspaceName: string
}

type Step = 'consent' | 'code' | 'signing-in'

export default function CandidateFlow({
  roundId,
  token,
  authMode,
  consentAlreadyGiven,
  emailHint,
  workspaceName,
}: Props) {
  const [step, setStep] = useState<Step>('consent')
  const [agreed, setAgreed] = useState(consentAlreadyGiven)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codeResent, setCodeResent] = useState(false)

  async function signInWithTicket(ticket: string) {
    setStep('signing-in')
    // redirect:false so a failed sign-in (e.g. the 60s ticket expired)
    // surfaces here with a retry, instead of stranding the candidate on the
    // generic B2C /signin page.
    const result = await signIn('invite-otp', { ticket, redirect: false })
    if (!result?.ok) {
      setStep(authMode === 'otp' ? 'code' : 'consent')
      setError('Sign-in took too long — please try again.')
      return
    }
    window.location.href = `/candidate/${encodeURIComponent(roundId)}/prepare`
  }

  async function begin(e?: FormEvent) {
    e?.preventDefault()
    if (!agreed) return
    setError(null)
    setCodeResent(false)
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
        otpRequired?: boolean
        error?: string
      }
      if (!res.ok || !data.ok) {
        setError(messageForStatus(res.status, data.error))
        return
      }
      if (data.otpRequired) {
        if (step === 'code') setCodeResent(true)
        setStep('code')
        return
      }
      if (data.ticket) {
        await signInWithTicket(data.ticket)
        return
      }
      setError('Something went wrong. Please try again.')
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: code.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        ticket?: string
        reason?: string
      }
      if (!res.ok || !data.ok || !data.ticket) {
        setError(messageForReason(data.reason, res.status))
        return
      }
      await signInWithTicket(data.ticket)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'signing-in') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
        <p className="text-sm text-[#536471]">Setting things up…</p>
      </div>
    )
  }

  if (step === 'code') {
    return (
      <form onSubmit={verifyCode} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="cand-code" className="text-sm font-medium text-[#0f1419] block">
            Enter your 6-digit code
          </label>
          <p className="text-xs text-[#71767b]">
            We sent a code to <strong>{emailHint}</strong>. It expires in 10 minutes.
          </p>
          <input
            id="cand-code"
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-center text-lg tracking-[8px] font-mono focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30 focus:border-[#2563eb] transition-colors"
          />
        </div>
        {error && <p className="text-xs text-[#f4212e]">{error}</p>}
        {codeResent && !error && (
          <p className="text-xs text-emerald-600">New code sent — check your email.</p>
        )}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="w-full py-2.5 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 disabled:bg-[#e1e8ed] disabled:text-[#8b98a5] disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Verifying…' : 'Verify and start'}
        </button>
        <div className="text-right text-xs text-[#71767b]">
          <button
            type="button"
            onClick={() => void begin()}
            disabled={busy}
            className="hover:text-[#2563eb] transition-colors disabled:opacity-50"
          >
            Resend code
          </button>
        </div>
      </form>
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
          {authMode === 'otp' &&
            ` After you agree, we'll email a 6-digit code to ${emailHint} to confirm it's you.`}
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
        {busy
          ? 'Starting…'
          : consentAlreadyGiven
            ? 'Continue to your interview'
            : authMode === 'otp'
              ? 'I agree — send my code'
              : 'I agree — start my interview'}
      </button>
    </form>
  )
}

function messageForStatus(status: number, serverError?: string): string {
  if (status === 410)
    return 'This interview link is no longer valid. Please contact the company that invited you.'
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.'
  if (status === 503) return 'The service is temporarily unavailable. Please try again in a moment.'
  return serverError || 'Something went wrong. Please try again.'
}

function messageForReason(reason: string | undefined, status: number): string {
  switch (reason) {
    case 'locked':
      return 'Too many incorrect attempts. Please wait 30 minutes and request a new code.'
    case 'service_unavailable':
      return 'The service is temporarily unavailable. Please try again in a moment.'
    case 'invalid_code':
      return 'That code is incorrect or has expired. Check your email or resend the code.'
    default:
      return messageForStatus(status)
  }
}
