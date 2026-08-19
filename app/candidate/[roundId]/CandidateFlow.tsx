'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { HIRE_AI_INTERVIEW_DISCLOSURES } from '@shared/contracts/hireAiInterviewConsentDisclosure'

interface Props {
  roundId: string
  capability: string
  authMode: 'magic_link' | 'otp'
  consentAlreadyGiven: boolean
  legacyConsentAttempt?: boolean
  emailHint: string
  workspaceName: string
}

type ConsentKey =
  | 'recording'
  | 'identityPhoto'
  | 'attentionMonitoring'
  | 'aiEvaluation'

type Step = 'consent' | 'legacy_resume' | 'code' | 'camera' | 'resume' | 'starting'
type CandidateNextStep = 'identity_photo' | 'resume'

const EMPTY_CONSENT: Record<ConsentKey, boolean> = {
  recording: false,
  identityPhoto: false,
  attentionMonitoring: false,
  aiEvaluation: false,
}

// This only tells the server that the candidate wants to continue an
// already-consented attempt. The server still verifies the immutable receipt
// and its exact version+digest before issuing a guest session.
const EXISTING_CONSENT_ACKNOWLEDGEMENTS: Record<ConsentKey, true> = {
  recording: true,
  identityPhoto: true,
  attentionMonitoring: true,
  aiEvaluation: true,
}

export default function CandidateFlow({
  roundId,
  capability,
  authMode,
  legacyConsentAttempt = false,
  emailHint,
  workspaceName,
}: Props) {
  const [step, setStep] = useState<Step>(() =>
    legacyConsentAttempt ? 'legacy_resume' : 'consent',
  )
  const [accepted, setAccepted] = useState(EMPTY_CONSENT)
  const [code, setCode] = useState('')
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [codeResent, setCodeResent] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const consentComplete = useMemo(
    () => Object.values(accepted).every(Boolean),
    [accepted],
  )

  useEffect(() => {
    if (step !== 'camera' || photo) return
    let cancelled = false
    async function openCamera() {
      setCameraError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setCameraReady(true)
      } catch {
        setCameraError(
          'Camera access is required for the identity photo. Allow camera access in your browser, then try again, or contact the hiring team.',
        )
      }
    }
    void openCamera()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setCameraReady(false)
    }
  }, [step, photo])

  function setConsent(key: ConsentKey, value: boolean) {
    setAccepted((current) => ({ ...current, [key]: value }))
  }

  function completeCandidateSession(data: {
    csrfToken?: string
    next?: CandidateNextStep
  }) {
    if (!data.csrfToken) {
      setError('The interview session could not be created. Please try again.')
      return
    }
    setCsrfToken(data.csrfToken)
    setStep(data.next === 'resume' ? 'resume' : 'camera')
  }

  async function begin(e?: FormEvent) {
    e?.preventDefault()
    if (!legacyConsentAttempt && !consentComplete) return
    setError(null)
    setCodeResent(false)
    setBusy(true)
    try {
      const response = await fetch(`/api/candidate/${roundId}/begin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          accepted: legacyConsentAttempt ? EXISTING_CONSENT_ACKNOWLEDGEMENTS : accepted,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        otpRequired?: boolean
        csrfToken?: string
        next?: CandidateNextStep
        error?: string
      }
      if (!response.ok || !data.ok) {
        setError(messageForStatus(response.status, data.error))
        return
      }
      if (data.otpRequired) {
        if (step === 'code') setCodeResent(true)
        setStep('code')
        return
      }
      completeCandidateSession(data)
    } catch {
      setError('Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const response = await fetch(`/api/candidate/${roundId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          code: code.trim(),
          accepted: legacyConsentAttempt ? EXISTING_CONSENT_ACKNOWLEDGEMENTS : accepted,
        }),
      })
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        csrfToken?: string
        next?: CandidateNextStep
        reason?: string
      }
      if (!response.ok || !data.ok) {
        setError(messageForReason(data.reason, response.status))
        return
      }
      completeCandidateSession(data)
    } catch {
      setError('Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function capturePhoto() {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError('The camera is still starting. Wait a moment and try again.')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) {
      setCameraError('The photo could not be captured. Please try again.')
      return
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const captured = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )
    if (!captured) {
      setCameraError('The photo could not be captured. Please try again.')
      return
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setPreviewUrl(canvas.toDataURL('image/jpeg', 0.9))
    setPhoto(captured)
  }

  function retakePhoto() {
    setPreviewUrl(null)
    setPhoto(null)
    setCameraReady(false)
    setCameraError(null)
  }

  async function openInterview(
    token: string,
    fallbackStep: Extract<Step, 'camera' | 'resume'>,
  ) {
    setBusy(true)
    setError(null)
    setStep('starting')
    try {
      const start = await fetch(`/api/candidate/${roundId}/start`, {
        method: 'POST',
        headers: { 'x-hire-csrf': token },
      })
      const startData = (await start.json().catch(() => ({}))) as {
        handoffUrl?: string
        error?: string
      }
      if (!start.ok || !startData.handoffUrl) {
        setStep(fallbackStep)
        setError(startData.error || 'The interview could not start. Please try again.')
        return
      }
      window.location.assign(startData.handoffUrl)
    } catch {
      setStep(fallbackStep)
      setError('Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmPhoto() {
    if (!photo || !csrfToken) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('photo', photo, 'identity-photo.jpg')
      const upload = await fetch(`/api/candidate/${roundId}/identity-photo`, {
        method: 'POST',
        headers: { 'x-hire-csrf': csrfToken },
        body: form,
      })
      const uploadData = (await upload.json().catch(() => ({}))) as { error?: string }
      if (!upload.ok) {
        setError(uploadData.error || 'The photo could not be saved. Please try again.')
        return
      }

      await openInterview(csrfToken, 'camera')
    } catch {
      setError('Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'legacy_resume') {
    return (
      <section className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6">
        <div>
          <h2 className="text-base font-semibold text-[#0f1419]">Continue your interview</h2>
          <p className="mt-1 text-sm leading-relaxed text-[#536471]">
            You already completed the consent for this interview. Continue with the
            exact consent already recorded for this in-progress interview; no new
            consent or data collection is added.
          </p>
        </div>
        {error && <p className="text-sm text-[#f4212e]" role="alert">{error}</p>}
        <button
          type="button"
          onClick={() => void begin()}
          disabled={busy}
          className="w-full rounded-xl bg-[#2563eb] py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
        >
          {busy
            ? 'Continuing…'
            : authMode === 'otp'
              ? 'Continue to verification'
              : 'Continue your interview'}
        </button>
      </section>
    )
  }

  if (step === 'starting') {
    return (
      <div className="flex flex-col items-center gap-3 py-10" aria-live="polite">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-[#2563eb] border-t-transparent" />
        <p className="text-sm text-[#536471]">Opening your secure interview…</p>
      </div>
    )
  }

  if (step === 'resume') {
    return (
      <section className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6">
        <div>
          <h2 className="text-base font-semibold text-[#0f1419]">
            Your identity photo is saved
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-[#536471]">
            Continue with the secure interview using the photo you already captured.
          </p>
        </div>
        {error && <p className="text-sm text-[#f4212e]" role="alert">{error}</p>}
        <button
          type="button"
          onClick={() => {
            if (csrfToken) void openInterview(csrfToken, 'resume')
          }}
          disabled={busy || !csrfToken}
          className="w-full rounded-xl bg-[#2563eb] py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
        >
          {busy ? 'Opening…' : 'Resume secure interview'}
        </button>
      </section>
    )
  }

  if (step === 'camera') {
    return (
      <section className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6">
        <div>
          <h2 className="text-base font-semibold text-[#0f1419]">Identity photo</h2>
          <p className="mt-1 text-sm leading-relaxed text-[#536471]">
            Take a live selfie for the hiring team to compare visually later. We do
            not accept uploads or government IDs, and no automated face match is used.
          </p>
        </div>
        <div className="overflow-hidden rounded-xl bg-slate-950 aspect-video">
          {photo && previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- ephemeral local camera data URL
            <img src={previewUrl} alt="Captured identity selfie preview" className="h-full w-full object-cover" />
          ) : (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="Live camera preview"
              className="h-full w-full -scale-x-100 object-cover"
            />
          )}
        </div>
        {cameraError && (
          <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">{cameraError}</p>
            <button
              type="button"
              onClick={() => {
                setCameraError(null)
                setStep('consent')
                queueMicrotask(() => setStep('camera'))
              }}
              className="text-sm font-semibold text-amber-900 underline"
            >
              Try camera again
            </button>
          </div>
        )}
        {error && <p className="text-sm text-[#f4212e]" role="alert">{error}</p>}
        {photo ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={retakePhoto}
              disabled={busy}
              className="rounded-xl border border-[#cfd9de] px-4 py-2.5 text-sm font-semibold text-[#0f1419] disabled:opacity-50"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={() => void confirmPhoto()}
              disabled={busy}
              className="rounded-xl bg-[#2563eb] px-4 py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
            >
              {busy ? 'Saving…' : 'Use photo and start'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void capturePhoto()}
            disabled={!cameraReady || Boolean(cameraError)}
            className="w-full rounded-xl bg-[#2563eb] py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
          >
            {cameraReady ? 'Capture photo' : 'Starting camera…'}
          </button>
        )}
      </section>
    )
  }

  if (step === 'code') {
    return (
      <form onSubmit={verifyCode} className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6">
        <div className="space-y-1.5">
          <label htmlFor="cand-code" className="block text-sm font-medium text-[#0f1419]">
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
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-center font-mono text-lg tracking-[8px] focus:border-[#2563eb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30"
          />
        </div>
        {error && <p className="text-xs text-[#f4212e]" role="alert">{error}</p>}
        {codeResent && !error && <p className="text-xs text-emerald-600">New code sent.</p>}
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="w-full rounded-xl bg-[#2563eb] py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
        >
          {busy ? 'Verifying…' : 'Verify and continue'}
        </button>
        <button
          type="button"
          onClick={() => void begin()}
          disabled={busy}
          className="w-full text-xs text-[#536471] underline disabled:opacity-50"
        >
          Resend code
        </button>
      </form>
    )
  }

  const consentItems: Array<{ key: ConsentKey; text: string }> = [
    {
      key: 'recording',
      text: 'I consent to camera and microphone recording, transcription, Hire analysis, and sharing the interview recording and review with the hiring team.',
    },
    {
      key: 'identityPhoto',
      text: 'I consent to a live selfie being shown to the hiring team for later human identity comparison.',
    },
    {
      key: 'attentionMonitoring',
      text: 'I consent to private retention and analysis of structured facial-landmark and browser-window observations for the Hire review.',
    },
    {
      key: 'aiEvaluation',
      text: 'I consent to AI evaluation of this interview and understand that a human makes every hiring decision.',
    },
  ]

  const disclosures = HIRE_AI_INTERVIEW_DISCLOSURES

  return (
    <form onSubmit={begin} className="space-y-5 rounded-2xl border border-[#e1e8ed] bg-white p-6">
      <div>
        <h2 className="text-base font-semibold text-[#0f1419]">Before you start</h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-[#536471]">
          <p>{disclosures.recording}</p>
          <p>{disclosures.identityPhoto}</p>
          <p>{disclosures.attentionMonitoring}</p>
          <p>{disclosures.aiEvaluation}</p>
          <p>{disclosures.retention}</p>
          <p>
            The evidence-linked assessment is prepared for <strong>{workspaceName}</strong>.
          </p>
        </div>
      </div>
      <fieldset className="space-y-3">
        <legend className="sr-only">Required interview consent acknowledgements</legend>
        {consentItems.map((item) => (
          <label key={item.key} className="flex cursor-pointer items-start gap-3 text-sm text-[#0f1419]">
            <input
              type="checkbox"
              checked={accepted[item.key]}
              onChange={(event) => setConsent(item.key, event.target.checked)}
              className="mt-0.5"
            />
            <span>{item.text}</span>
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-[#71767b]">
        Declining stops here; no camera or microphone permission is requested. Contact
        the hiring team if you need an accommodation.
        {authMode === 'otp' && ` After consent, we'll send a code to ${emailHint}.`}
      </p>
      {error && <p className="text-xs text-[#f4212e]" role="alert">{error}</p>}
      <button
        type="submit"
        disabled={busy || !consentComplete}
        className="w-full rounded-xl bg-[#2563eb] py-2.5 text-sm font-semibold text-white disabled:bg-[#e1e8ed] disabled:text-[#8b98a5]"
      >
        {busy ? 'Continuing…' : authMode === 'otp' ? 'Consent and send code' : 'Consent and continue'}
      </button>
    </form>
  )
}

function messageForStatus(status: number, serverError?: string): string {
  if (status === 410) {
    return 'This interview link is no longer valid. Contact the company that invited you.'
  }
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.'
  if (status === 503) return 'The service is temporarily unavailable. Please try again.'
  return serverError || 'Something went wrong. Please try again.'
}

function messageForReason(reason: string | undefined, status: number): string {
  if (reason === 'locked') {
    return 'Too many incorrect attempts. Wait 30 minutes and request a new code.'
  }
  if (reason === 'service_unavailable') {
    return 'The service is temporarily unavailable. Please try again.'
  }
  if (reason === 'invalid_code') {
    return 'That code is incorrect or expired. Check your email or resend the code.'
  }
  return messageForStatus(status)
}
