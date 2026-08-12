'use client'

import { useId, useState, type FormEvent } from 'react'

interface CandidatePrivacyRequestProps {
  roundId: string
  capability: string
}

type Phase = 'ready' | 'requesting' | 'verify' | 'verifying' | 'processing'

interface ApiPayload {
  requestCapability?: string
  emailHint?: string
  accepted?: boolean
  status?: string
  error?: string
  code?: string
}

export default function CandidatePrivacyRequest({
  roundId,
  capability,
}: CandidatePrivacyRequestProps) {
  const codeInputId = useId()
  const [phase, setPhase] = useState<Phase>('ready')
  const [requestCapability, setRequestCapability] = useState<string | null>(null)
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const busy = phase === 'requesting' || phase === 'verifying'

  async function requestDeletion() {
    setError(null)
    setPhase('requesting')
    try {
      const response = await fetch(`/api/candidate/${roundId}/privacy/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability }),
        cache: 'no-store',
      })
      const payload = (await response.json().catch(() => ({}))) as ApiPayload
      if (response.status === 409 && payload.code === 'PRIVACY_REQUEST_CONFLICT') {
        setPhase('processing')
        return
      }
      if (!response.ok || !payload.requestCapability || !payload.emailHint) {
        setError(requestMessage(response.status, payload.code))
        setPhase('ready')
        return
      }
      setRequestCapability(payload.requestCapability)
      setEmailHint(payload.emailHint)
      setCode('')
      setPhase('verify')
    } catch {
      setError('Please check your connection and try again.')
      setPhase('ready')
    }
  }

  async function verifyDeletion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!requestCapability || code.length !== 6) return
    setError(null)
    setPhase('verifying')
    try {
      const response = await fetch('/api/candidate/privacy/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestCapability, code }),
        cache: 'no-store',
      })
      const payload = (await response.json().catch(() => ({}))) as ApiPayload
      if (!response.ok || !payload.accepted) {
        setError(verificationMessage(response.status, payload.code))
        setPhase('verify')
        return
      }
      setCode('')
      setPhase('processing')
    } catch {
      setError('Please check your connection and try again.')
      setPhase('verify')
    }
  }

  return (
    <section
      aria-labelledby={`${codeInputId}-heading`}
      className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6 text-left"
    >
      <div>
        <h2
          id={`${codeInputId}-heading`}
          className="text-base font-semibold text-[#0f1419]"
        >
          Your data and privacy
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-[#536471]">
          You can request deletion of your candidate data at any time, even if this
          interview link has expired or was revoked. We verify the request using the
          email address on your application.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-[#71767b]">
          Identifying details and interview media are removed; de-identified numeric
          scores and hiring-decision audit records may be retained.
        </p>
      </div>

      {phase === 'processing' ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <p className="text-sm font-semibold text-emerald-900">
            Your deletion request is being processed
          </p>
          <p className="mt-1 text-xs leading-relaxed text-emerald-800">
            Interview access has been revoked. Associated photos, recordings, and
            candidate details are queued for deletion under the retention policy.
          </p>
        </div>
      ) : phase === 'verify' || phase === 'verifying' ? (
        <form onSubmit={verifyDeletion} className="space-y-3">
          <div>
            <label
              htmlFor={codeInputId}
              className="block text-sm font-medium text-[#0f1419]"
            >
              Enter the 6-digit deletion code
            </label>
            <p className="mt-1 text-xs text-[#71767b]">
              We sent it to <strong>{emailHint}</strong>. The code expires in 10 minutes.
            </p>
          </div>
          <input
            id={codeInputId}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
            className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-center font-mono text-lg tracking-[8px] focus:border-[#2563eb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30"
            placeholder="000000"
          />
          <p className="text-xs leading-relaxed text-[#536471]">
            Verification starts an irreversible deletion request and ends access to
            this interview.
          </p>
          {error ? (
            <p className="text-xs text-[#f4212e]" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="w-full rounded-xl bg-[#b42318] px-4 py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
          >
            {phase === 'verifying' ? 'Verifying…' : 'Verify and delete my candidate data'}
          </button>
          <button
            type="button"
            onClick={() => void requestDeletion()}
            disabled={busy}
            className="w-full text-xs font-medium text-[#536471] underline disabled:opacity-50"
          >
            Send a new code
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-[#71767b]">
            We will email a one-time code before anything is deleted. The hiring team
            cannot submit this request on your behalf.
          </p>
          {error ? (
            <p className="text-xs text-[#f4212e]" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void requestDeletion()}
            disabled={busy}
            className="w-full rounded-xl border border-[#cfd9de] px-4 py-2.5 text-sm font-semibold text-[#0f1419] disabled:opacity-50"
          >
            {phase === 'requesting' ? 'Sending verification code…' : 'Request data deletion'}
          </button>
        </div>
      )}
    </section>
  )
}

function requestMessage(status: number, code?: string): string {
  if (status === 429) return 'Too many requests. Wait a few minutes and try again.'
  if (status === 503) return 'Verification email is temporarily unavailable. Try again later.'
  if (status === 400 || status === 410 || code === 'PRIVACY_LINK_INVALID') {
    return 'We could not verify this invite. Use the original link from your email or contact the hiring team.'
  }
  return 'The deletion request could not be started. Please try again.'
}

function verificationMessage(status: number, code?: string): string {
  if (status === 429) return 'Too many incorrect attempts. Wait before trying again.'
  if (status === 503) return 'Verification is temporarily unavailable. Try again later.'
  if (status === 400 || code === 'OTP_INVALID') {
    return 'That code is incorrect or expired. Request a new deletion code and try again.'
  }
  return 'The deletion request could not be verified. Please try again.'
}
