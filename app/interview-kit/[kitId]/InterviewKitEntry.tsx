'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const KIT_CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{64}$/i
const KIT_STORAGE_PREFIX = 'hire:interview-kit:v1:'

const SCORECARD_DIMENSIONS = [
  {
    key: 'role_capability',
    label: 'Role capability',
    help: 'How well did the candidate demonstrate the skills needed for this role?',
  },
  {
    key: 'problem_solving',
    label: 'Problem solving',
    help: 'How clearly did the candidate reason through relevant problems?',
  },
  {
    key: 'communication',
    label: 'Communication',
    help: 'How clearly and effectively did the candidate communicate?',
  },
  {
    key: 'collaboration',
    label: 'Collaboration',
    help: 'How well would the candidate work with the team and stakeholders?',
  },
] as const

type ScorecardDimensionKey = (typeof SCORECARD_DIMENSIONS)[number]['key']
type Recommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no'

interface InterviewKitBootstrap {
  state: 'ok'
  workspaceName: string
  jobTitle: string
  interviewerName?: string
  brief?: {
    candidateName?: string
    experienceYears?: number
    location?: string
  }
}

function isKitCapabilityForId(raw: string, kitId: string): boolean {
  if (!OBJECT_ID.test(kitId) || !KIT_CAPABILITY.test(raw)) return false
  const [, capabilityKitId] = raw.split('.')
  return capabilityKitId?.toLowerCase() === kitId.toLowerCase()
}

function initialScores(): Record<ScorecardDimensionKey, number> {
  return {
    role_capability: 0,
    problem_solving: 0,
    communication: 0,
    collaboration: 0,
  }
}

function initialEvidence(): Record<ScorecardDimensionKey, string> {
  return {
    role_capability: '',
    problem_solving: '',
    communication: '',
    collaboration: '',
  }
}

function inactiveKit() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This interview kit link is no longer active
        </h1>
        <p className="text-sm leading-relaxed text-[#536471]">
          The link may have expired, been replaced, or already been submitted. Please
          contact the person who invited you for a new interview kit.
        </p>
      </div>
    </main>
  )
}

export default function InterviewKitEntry({ kitId }: { kitId: string }) {
  const [capability, setCapability] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<InterviewKitBootstrap | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [scores, setScores] = useState(initialScores)
  const [evidence, setEvidence] = useState(initialEvidence)
  const [recommendation, setRecommendation] = useState<Recommendation | ''>('')
  const [overallComment, setOverallComment] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const storageKey = useMemo(() => `${KIT_STORAGE_PREFIX}${kitId}`, [kitId])

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const fragmentCapability = fragment.get('kit')?.trim() ?? ''
    let storedCapability = ''

    try {
      storedCapability = window.sessionStorage.getItem(storageKey)?.trim() ?? ''
      if (isKitCapabilityForId(fragmentCapability, kitId)) {
        window.sessionStorage.setItem(storageKey, fragmentCapability)
      }
    } catch {
      // Browser storage is a convenience for reload recovery only. The
      // original fragment remains sufficient when storage is unavailable.
    }

    const resolvedCapability = isKitCapabilityForId(fragmentCapability, kitId)
      ? fragmentCapability
      : isKitCapabilityForId(storedCapability, kitId)
        ? storedCapability
        : ''

    // A fragment never crosses the network, but scrub it before any client
    // request or navigation can accidentally expose it in browser history.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )

    if (!resolvedCapability) {
      setInvalid(true)
      return
    }
    setCapability(resolvedCapability)
  }, [kitId, storageKey])

  useEffect(() => {
    if (!capability || invalid) return
    let cancelled = false
    setLoadError(null)

    void fetch(`/api/interview-kit/${encodeURIComponent(kitId)}/bootstrap`, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as Partial<InterviewKitBootstrap>
        if (cancelled) return
        if (response.status === 410) {
          setInvalid(true)
          return
        }
        if (!response.ok) {
          setLoadError('We could not open this interview kit. Please try again.')
          return
        }
        if (
          payload.state !== 'ok' ||
          typeof payload.workspaceName !== 'string' ||
          typeof payload.jobTitle !== 'string'
        ) {
          setLoadError('We could not open this interview kit. Please try again.')
          return
        }
        setBootstrap(payload as InterviewKitBootstrap)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('We could not open this interview kit. Please try again.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [capability, invalid, kitId, loadAttempt])

  async function submitScorecard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!capability) return
    setSubmitError(null)
    setSubmitting(true)
    try {
      const response = await fetch(
        `/api/interview-kit/${encodeURIComponent(kitId)}/scorecard`,
        {
          method: 'POST',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            capability,
            dimensions: SCORECARD_DIMENSIONS.map((dimension) => ({
              key: dimension.key,
              rating: scores[dimension.key],
              evidence: evidence[dimension.key].trim(),
            })),
            recommendation,
            overallComment: overallComment.trim(),
          }),
          cache: 'no-store',
        },
      )
      if (response.status === 410) {
        setInvalid(true)
        return
      }
      if (!response.ok) {
        setSubmitError('We could not submit your scorecard. Please try again.')
        return
      }
      try {
        window.sessionStorage.removeItem(storageKey)
      } catch {
        // It is safe to leave a tab-scoped recovery value behind after a
        // submitted kit. The server treats a repeated submission as inactive.
      }
      setSubmitted(true)
    } catch {
      setSubmitError('We could not reach the service. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (invalid) return inactiveKit()

  if (loadError && capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <div role="alert">
            <h1 className="text-lg font-semibold text-[#0f1419]">
              We could not open this interview kit
            </h1>
            <p className="mt-2 text-sm text-[#536471]">
              The link may still be valid. Check your connection and try again.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            className="rounded-xl bg-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/40"
          >
            Try again
          </button>
        </div>
      </main>
    )
  }

  if (!bootstrap || !capability) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <p className="text-sm text-[#536471]" role="status">
          Opening your secure interview kit…
        </p>
      </main>
    )
  }

  if (submitted) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
        <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
          <div className="text-3xl">✓</div>
          <h1 className="text-lg font-semibold text-[#0f1419]">Scorecard submitted</h1>
          <p className="text-sm leading-relaxed text-[#536471]">
            Thank you. The hiring team has your feedback. You can safely close this tab.
          </p>
        </div>
      </main>
    )
  }

  const brief = bootstrap.brief
  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">
            {bootstrap.workspaceName} · Interview kit
          </p>
          <h1 className="text-2xl font-bold text-[#0f1419]">{bootstrap.jobTitle}</h1>
          <p className="text-sm text-[#536471]">
            {bootstrap.interviewerName
              ? `Thanks, ${bootstrap.interviewerName}. `
              : ''}
            Use this guide in your usual meeting tool, then submit the scorecard below.
          </p>
        </header>

        <section
          aria-labelledby="interview-brief-heading"
          className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-6"
        >
          <div>
            <h2 id="interview-brief-heading" className="text-lg font-semibold text-[#0f1419]">
              Interview brief
            </h2>
            <p className="mt-1 text-sm text-[#536471]">
              Run the conversation in your usual video-call tool. This page does not
              record the interview.
            </p>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {brief?.candidateName ? (
              <div>
                <dt className="text-[#71767b]">Candidate</dt>
                <dd className="mt-0.5 font-medium text-[#0f1419]">{brief.candidateName}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-[#71767b]">Role</dt>
              <dd className="mt-0.5 font-medium text-[#0f1419]">{bootstrap.jobTitle}</dd>
            </div>
            {brief?.experienceYears !== undefined ? (
              <div>
                <dt className="text-[#71767b]">Experience</dt>
                <dd className="mt-0.5 font-medium text-[#0f1419]">
                  {brief.experienceYears} years
                </dd>
              </div>
            ) : null}
            {brief?.location ? (
              <div>
                <dt className="text-[#71767b]">Location</dt>
                <dd className="mt-0.5 font-medium text-[#0f1419]">{brief.location}</dd>
              </div>
            ) : null}
          </dl>
        </section>

        <form
          onSubmit={submitScorecard}
          className="space-y-6 rounded-2xl border border-[#e1e8ed] bg-white p-6"
        >
          <div>
            <h2 className="text-lg font-semibold text-[#0f1419]">Scorecard</h2>
            <p className="mt-1 text-sm text-[#536471]">
              Rate each area from 1 (not demonstrated) to 5 (exceptional), and include
              specific evidence from the conversation.
            </p>
          </div>

          <div className="space-y-5">
            {SCORECARD_DIMENSIONS.map((dimension) => (
              <fieldset key={dimension.key} className="space-y-2 border-t border-[#eef2f5] pt-5 first:border-t-0 first:pt-0">
                <legend className="font-medium text-[#0f1419]">{dimension.label}</legend>
                <p className="text-sm text-[#536471]">{dimension.help}</p>
                <label className="block text-sm text-[#536471]" htmlFor={`${dimension.key}-score`}>
                  Rating
                </label>
                <select
                  id={`${dimension.key}-score`}
                  required
                  value={scores[dimension.key] || ''}
                  onChange={(event) =>
                    setScores((current) => ({
                      ...current,
                      [dimension.key]: Number(event.target.value),
                    }))
                  }
                  className="h-10 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20"
                >
                  <option value="" disabled>
                    Select a rating
                  </option>
                  {[1, 2, 3, 4, 5].map((score) => (
                    <option key={score} value={score}>
                      {score} — {score === 1 ? 'Not demonstrated' : score === 5 ? 'Exceptional' : 'Observed'}
                    </option>
                  ))}
                </select>
                <label className="block text-sm text-[#536471]" htmlFor={`${dimension.key}-evidence`}>
                  Evidence
                </label>
                <textarea
                  id={`${dimension.key}-evidence`}
                  required
                  minLength={1}
                  maxLength={1200}
                  rows={3}
                  value={evidence[dimension.key]}
                  onChange={(event) =>
                    setEvidence((current) => ({
                      ...current,
                      [dimension.key]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-[#e1e8ed] bg-white px-3 py-2 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20"
                  placeholder="What did the candidate say or do that informed this rating?"
                />
              </fieldset>
            ))}
          </div>

          <div className="space-y-2 border-t border-[#eef2f5] pt-5">
            <label className="block font-medium text-[#0f1419]" htmlFor="recommendation">
              Recommendation
            </label>
            <select
              id="recommendation"
              required
              value={recommendation}
              onChange={(event) => setRecommendation(event.target.value as Recommendation | '')}
              className="h-10 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20"
            >
              <option value="" disabled>
                Select a recommendation
              </option>
              <option value="strong_yes">Strong yes</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
              <option value="strong_no">Strong no</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="block font-medium text-[#0f1419]" htmlFor="overall-comment">
              Overall feedback
            </label>
            <textarea
              id="overall-comment"
              required
              minLength={1}
              maxLength={2000}
              rows={5}
              value={overallComment}
              onChange={(event) => setOverallComment(event.target.value)}
              className="w-full rounded-lg border border-[#e1e8ed] bg-white px-3 py-2 text-sm text-[#0f1419] focus:border-[#2563eb] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/20"
              placeholder="Summarize the key evidence behind your recommendation."
            />
          </div>

          {submitError ? (
            <p className="text-sm text-[#d92d20]" role="alert">
              {submitError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-[#2563eb] px-5 py-3 text-sm font-semibold text-white hover:bg-[#1d4ed8] focus:outline-none focus:ring-2 focus:ring-[#2563eb]/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Submitting scorecard…' : 'Submit scorecard'}
          </button>
        </form>
      </div>
    </main>
  )
}
