'use client'

/**
 * Two-step OTP form for candidate invite authentication.
 *
 *   Step 1 (email)  → POST /api/invite/[sessionId]/request-otp
 *                     Always returns 200 (constant-shape response — the
 *                     API deliberately doesn't confirm whether the email
 *                     matches the invited candidate). We advance to step 2
 *                     unconditionally on non-503.
 *
 *   Step 2 (code)   → POST /api/invite/[sessionId]/verify-otp
 *                     Returns { ok: true, ticket } on success, or an
 *                     error reason. We call `signIn('invite-otp', ...)`
 *                     with the ticket to have NextAuth issue the session
 *                     cookie and redirect to the interview room.
 *
 * Error UX:
 *   - Specific messages for invalid_code / locked / service_unavailable.
 *   - Generic for invalid_token (should be caught server-side, but guard).
 *
 * Accessibility:
 *   - inputMode="numeric" + pattern="\d*" opens the numeric keypad on mobile.
 *   - autoComplete="one-time-code" lets browsers / password managers
 *     auto-fill the SMS-style code from the email if the user has the
 *     email client on the same device.
 */

import { useState, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'

interface Props {
  sessionId: string
  token: string
  expectedEmailHint: string
}

type Step = 'email' | 'otp' | 'signing-in'

export default function OtpFlow({ sessionId, token, expectedEmailHint }: Props) {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [otpResent, setOtpResent] = useState(false)

  async function requestOtp(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/invite/${sessionId}/request-otp`, {
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
      // Advance regardless of whether the email matched — the endpoint
      // deliberately gives no signal to prevent enumeration. If the email
      // was wrong, the OTP step will return invalid_code.
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
      const res = await fetch(`/api/invite/${sessionId}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          email: email.trim().toLowerCase(),
          otp: otp.trim(),
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
      // Hand the ticket to NextAuth. callbackUrl routes the authenticated
      // candidate into the pre-interview lobby, which hydrates the
      // interview config from the server-authoritative session doc
      // (the candidate has no self-serve localStorage to fall back to).
      // `redirect: true` lets NextAuth own the navigation so session
      // cookies are committed before the page changes.
      await signIn('invite-otp', {
        ticket: data.ticket,
        callbackUrl: `/lobby?sessionId=${encodeURIComponent(sessionId)}`,
      })
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
      const res = await fetch(`/api/invite/${sessionId}/request-otp`, {
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

  return (
    <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
      {step === 'email' ? (
        <form onSubmit={requestOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="invite-email" className="text-sm font-medium text-[#0f1419] block">
              Confirm your email
            </label>
            <p className="text-xs text-[#71767b]">
              Enter the address the invite was sent to ({expectedEmailHint}). We&apos;ll send you a 6-digit code.
            </p>
            <input
              id="invite-email"
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
            <label htmlFor="invite-otp" className="text-sm font-medium text-[#0f1419] block">
              Enter your 6-digit code
            </label>
            <p className="text-xs text-[#71767b]">
              We sent a code to <strong>{email}</strong>. It expires in 10 minutes.
            </p>
            <input
              id="invite-otp"
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
              onClick={() => { setStep('email'); setOtp(''); setError(null); setOtpResent(false) }}
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
    case 'invalid_token':
      return 'This invite link is no longer valid. Please contact your recruiter.'
    case 'invalid_code':
      return 'That code is incorrect or has expired. Check your email or request a new one.'
    default:
      if (status === 429) return 'Too many attempts. Please wait a few minutes.'
      if (status === 503) return 'The service is temporarily unavailable. Please try again.'
      return 'Something went wrong. Please try again.'
  }
}
