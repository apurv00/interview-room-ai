'use client'

/**
 * Guest flow for a hire AI-interview round: consent → email → OTP → sign-in.
 *
 * Step 0 (consent) — the recording + AI-analysis disclosure. Nothing else is
 *   reachable until POST /consent succeeds; the server enforces the same gate
 *   on OTP issuance and verification, so this is UX, not the security boundary.
 * Steps 1–2 mirror the v1 OtpFlow (constant-shape request-otp, specific
 *   verify errors). On success, signIn('invite-otp') commits the session
 *   cookie and lands on /candidate/[roundId]/prepare, which hands off into
 *   the engine's own lobby → interview flow.
 */

import { useState, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'

interface Props {
  roundId: string
  token: string
  consentAlreadyGiven: boolean
  expectedEmailHint: string
  workspaceName: string
}

type Step = 'consent' | 'email' | 'otp' | 'signing-in'

export default function CandidateFlow({
  roundId,
  token,
  consentAlreadyGiven,
  expectedEmailHint,
  workspaceName,
}: Props) {
  const [step, setStep] = useState<Step>(consentAlreadyGiven ? 'email' : 'consent')
  const [agreed, setAgreed] = useState(false)
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [otpResent, setOtpResent] = useState(false)

  async function submitConsent(e: FormEvent) {
    e.preventDefault()
    if (!agreed) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        setError(
          res.status === 410
            ? 'This interview link is no longer valid. Please contact the company that invited you.'
            : 'Something went wrong. Please try again.'
        )
        return
      }
      setStep('email')
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function requestOtp(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email: email.trim().toLowerCase() }),
      })
      if (res.status === 503) {
        setError('The service is temporarily unavailable. Please try again in a moment.')
        return
      }
      if (res.status === 429) {
        setError('Too many attempts. Please wait a few minutes and try again.')
        return
      }
      // Advance regardless — the endpoint gives no signal on whether the
      // email matched (anti-enumeration). A wrong email surfaces as
      // invalid_code at the next step.
      setStep('otp')
    } catch {
      setError('Something went wrong. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          email: email.trim().toLowerCase(),
          code: otp.trim(),
        }),
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
      setStep('signing-in')
      // redirect:false so a failed sign-in (e.g. the 60s ticket expired
      // because the user waited) surfaces HERE with a retry path, instead
      // of stranding the guest on the generic B2C /signin page.
      const result = await signIn('invite-otp', {
        ticket: data.ticket,
        redirect: false,
      })
      if (!result?.ok) {
        setError('Sign-in took too long — request a new code and try again.')
        setStep('email')
        setOtp('')
        return
      }
      window.location.href = `/candidate/${encodeURIComponent(roundId)}/prepare`
    } catch {
      setError('Something went wrong. Please try again.')
      setStep('otp')
    } finally {
      setBusy(false)
    }
  }

  async function resendOtp() {
    setError(null)
    setOtpResent(false)
    setBusy(true)
    try {
      const res = await fetch(`/api/candidate/${roundId}/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email: email.trim().toLowerCase() }),
      })
      if (res.status === 429) {
        setError('Please wait before requesting another code.')
        return
      }
      if (res.status === 503) {
        setError('The service is temporarily unavailable. Please try again in a moment.')
        return
      }
      setOtpResent(true)
    } catch {
      setError('Could not resend the code. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'signing-in') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
        <p className="text-sm text-[#536471]">Signing you in…</p>
      </div>
    )
  }

  if (step === 'consent') {
    return (
      <form
        onSubmit={submitConsent}
        className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4"
      >
        <h2 className="text-base font-semibold text-[#0f1419]">
          Before you start: recording &amp; consent
        </h2>
        <div className="text-sm text-[#536471] space-y-2 leading-relaxed">
          <p>This interview is conducted by an AI interviewer. During it:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Your <strong>camera and microphone are recorded</strong>, and what you
              say is transcribed.
            </li>
            <li>
              Your answers are <strong>evaluated by AI</strong> to produce scores and
              a written assessment.
            </li>
            <li>
              The recording, transcript, and assessment are shared with the hiring
              team at <strong>{workspaceName}</strong> to inform their decision — a
              human makes every hiring decision, not the AI.
            </li>
          </ul>
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
          {busy ? 'Saving…' : 'I agree — continue'}
        </button>
      </form>
    )
  }

  return (
    <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
      {step === 'email' ? (
        <form onSubmit={requestOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="cand-email" className="text-sm font-medium text-[#0f1419] block">
              Confirm your email
            </label>
            <p className="text-xs text-[#71767b]">
              Enter the address your invite was sent to ({expectedEmailHint}). We&apos;ll
              send you a 6-digit code.
            </p>
            <input
              id="cand-email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30 focus:border-[#2563eb] transition-colors"
            />
          </div>
          {error && <p className="text-xs text-[#f4212e]">{error}</p>}
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="w-full py-2.5 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 disabled:bg-[#e1e8ed] disabled:text-[#8b98a5] disabled:cursor-not-allowed transition-colors"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="cand-otp" className="text-sm font-medium text-[#0f1419] block">
              Enter your 6-digit code
            </label>
            <p className="text-xs text-[#71767b]">
              We sent a code to <strong>{email}</strong>. It expires in 10 minutes.
            </p>
            <input
              id="cand-otp"
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-center text-lg tracking-[8px] font-mono focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30 focus:border-[#2563eb] transition-colors"
            />
          </div>
          {error && <p className="text-xs text-[#f4212e]">{error}</p>}
          {otpResent && !error && (
            <p className="text-xs text-emerald-600">New code sent — check your email.</p>
          )}
          <button
            type="submit"
            disabled={busy || otp.length !== 6}
            className="w-full py-2.5 rounded-xl bg-[#2563eb] text-white text-sm font-semibold hover:bg-blue-500 disabled:bg-[#e1e8ed] disabled:text-[#8b98a5] disabled:cursor-not-allowed transition-colors"
          >
            {busy ? 'Verifying…' : 'Verify and continue'}
          </button>
          <div className="flex items-center justify-between text-xs text-[#71767b]">
            <button
              type="button"
              onClick={() => {
                setStep('email')
                setOtp('')
                setError(null)
                setOtpResent(false)
              }}
              className="hover:text-[#2563eb] transition-colors"
            >
              ← Use a different email
            </button>
            <button
              type="button"
              onClick={resendOtp}
              disabled={busy}
              className="hover:text-[#2563eb] transition-colors disabled:opacity-50"
            >
              Resend code
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function messageForReason(reason: string | undefined, status: number): string {
  switch (reason) {
    case 'locked':
      return 'Too many incorrect attempts. Please wait 30 minutes and request a new code.'
    case 'service_unavailable':
      return 'The service is temporarily unavailable. Please try again in a moment.'
    case 'invalid_code':
      return 'That code is incorrect or has expired. Check your email or request a new one.'
    default:
      if (status === 429) return 'Too many attempts. Please wait a few minutes.'
      if (status === 503) return 'The service is temporarily unavailable. Please try again.'
      return 'Something went wrong. Please try again.'
  }
}
