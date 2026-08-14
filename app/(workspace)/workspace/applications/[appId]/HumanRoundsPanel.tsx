'use client'

import { useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'

const DIMENSIONS = [
  ['role_capability', 'Role capability'],
  ['problem_solving', 'Problem solving'],
  ['communication', 'Communication'],
  ['collaboration', 'Collaboration'],
] as const

type DimensionKey = (typeof DIMENSIONS)[number][0]
type Recommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no'
type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  strong_yes: 'Strong yes',
  yes: 'Yes',
  no: 'No',
  strong_no: 'Strong no',
}

function dimensionLabel(key: DimensionKey): string {
  return DIMENSIONS.find(([dimensionKey]) => dimensionKey === key)?.[1] ?? key
}

export interface HumanScorecardView {
  reviewerKind: 'kit' | 'member'
  reviewerName: string
  dimensions: Array<{
    key: DimensionKey
    rating: number
    evidence: string
  }>
  recommendation: Recommendation
  overallComment: string
  submittedAt: string
}

export interface HumanRoundDeliveryView {
  initial: {
    status: DeliveryStatus
    attempts: number
    sentAt: string | null
    terminalFailure: boolean
  } | null
  reminder: {
    status: DeliveryStatus
    sentAt: string | null
  } | null
}

export interface HumanRoundView {
  id: string
  mode: 'guest_kit' | 'member_room'
  status: 'pending_scorecard' | 'completed' | 'revoked'
  openedAt: string | null
  scorecardSubmittedAt: string | null
  revokedAt: string | null
  createdAt: string
  /** Detail-only HR evidence; never a kit capability or contact record. */
  scorecard?: HumanScorecardView | null
  /** Safe delivery state only—no recipient, provider error, URL, or token. */
  delivery?: HumanRoundDeliveryView | null
}

interface HumanRoundsPanelProps {
  applicationId: string
  humanRounds: HumanRoundView[]
  jobIsOpen: boolean
  terminal: boolean
  onChanged: () => Promise<void>
}

function newRatings(): Record<DimensionKey, number> {
  return {
    role_capability: 3,
    problem_solving: 3,
    communication: 3,
    collaboration: 3,
  }
}

function newEvidence(): Record<DimensionKey, string> {
  return {
    role_capability: '',
    problem_solving: '',
    communication: '',
    collaboration: '',
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return typeof body.error === 'string' ? body.error : fallback
}

function roundBadge(round: HumanRoundView): { label: string; variant: 'default' | 'primary' | 'success' | 'caution' } {
  if (round.status === 'completed') return { label: 'scorecard submitted', variant: 'success' }
  if (round.status === 'revoked') return { label: 'revoked', variant: 'default' }
  return { label: 'scorecard pending', variant: 'caution' }
}

function formatAttempt(attempts: number): string {
  return `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`
}

function InitialDeliveryState({ delivery }: { delivery: NonNullable<HumanRoundDeliveryView['initial']> }) {
  if (delivery.status === 'sent') {
    return (
      <p className="text-xs text-emerald-700">
        Interview kit email sent{delivery.sentAt ? ` · ${new Date(delivery.sentAt).toLocaleString()}` : ''}
      </p>
    )
  }
  if (delivery.status === 'pending') {
    return <p className="text-xs text-[#536471]">Interview kit email queued for delivery.</p>
  }
  if (delivery.status === 'sending') {
    return <p className="text-xs text-[#536471]">Interview kit email is being delivered.</p>
  }
  if (delivery.status === 'cancelled') {
    return <p className="text-xs text-[#71767b]">Interview kit delivery was cancelled.</p>
  }
  if (delivery.terminalFailure) {
    return (
      <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
        <p className="font-medium">Interview kit delivery stopped after {formatAttempt(delivery.attempts)}.</p>
        <p className="mt-1">
          Confirm the interviewer’s email address, then create a new interviewer kit if they still need to complete the round.
        </p>
      </div>
    )
  }
  return (
    <p className="text-xs text-amber-700">
      Interview kit delivery will retry automatically · {formatAttempt(delivery.attempts)} so far.
    </p>
  )
}

function ReminderDeliveryState({ delivery }: { delivery: NonNullable<HumanRoundDeliveryView['reminder']> }) {
  if (delivery.status === 'sent') {
    return (
      <p className="text-xs text-[#536471]">
        One scorecard reminder emailed{delivery.sentAt ? ` · ${new Date(delivery.sentAt).toLocaleString()}` : ''}
      </p>
    )
  }
  if (delivery.status === 'cancelled') return null
  if (delivery.status === 'failed') {
    return <p className="text-xs text-amber-700">The one scorecard reminder was not delivered; no additional reminder will be created.</p>
  }
  return <p className="text-xs text-[#536471]">One scorecard reminder is queued for delivery.</p>
}

/**
 * The authenticated counterpart to the public kit. This UI never renders a
 * possession capability: it can log a human round, see aggregate state, and
 * submit a member's own rubric only.
 */
export default function HumanRoundsPanel({
  applicationId,
  humanRounds,
  jobIsOpen,
  terminal,
  onChanged,
}: HumanRoundsPanelProps) {
  const [showGuestForm, setShowGuestForm] = useState(false)
  const [interviewerName, setInterviewerName] = useState('')
  const [interviewerEmail, setInterviewerEmail] = useState('')
  const [guestCommand, setGuestCommand] = useState<{ key: string; operationId: string } | null>(null)
  const [memberOperationId, setMemberOperationId] = useState<string | null>(null)
  const [scorecardRoundId, setScorecardRoundId] = useState<string | null>(null)
  const [ratings, setRatings] = useState<Record<DimensionKey, number>>(newRatings)
  const [evidence, setEvidence] = useState<Record<DimensionKey, string>>(newEvidence)
  const [recommendation, setRecommendation] = useState<Recommendation>('yes')
  const [overallComment, setOverallComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const canCreate = jobIsOpen && !terminal

  async function createGuestRound(event: React.FormEvent) {
    event.preventDefault()
    const name = interviewerName.trim()
    const email = interviewerEmail.trim()
    if (!name || !email) return
    const key = `${name.toLocaleLowerCase()}|${email.toLocaleLowerCase()}`
    const operationId = guestCommand?.key === key ? guestCommand.operationId : crypto.randomUUID()
    setGuestCommand({ key, operationId })
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/workspace/applications/${applicationId}/human-rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'guest_kit',
          interviewerName: name,
          interviewerEmail: email,
          operationId,
        }),
      })
      if (!response.ok) {
        setError(await responseError(response, 'Could not send the interview kit.'))
        return
      }
      const result = await response.json()
      setNotice(
        result.deliveryQueued === true
          ? 'Interview kit queued for delivery. The interviewer can complete it without an account.'
          : 'The kit was saved and will be recovered by the delivery worker.',
      )
      setInterviewerName('')
      setInterviewerEmail('')
      setGuestCommand(null)
      setShowGuestForm(false)
      await onChanged()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function createMemberRound() {
    const operationId = memberOperationId ?? crypto.randomUUID()
    setMemberOperationId(operationId)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/workspace/applications/${applicationId}/human-rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'member_room', operationId }),
      })
      if (!response.ok) {
        setError(await responseError(response, 'Could not log the member-run interview.'))
        return
      }
      const result = await response.json()
      setMemberOperationId(null)
      const createdRoundId = result.humanRound?.id
      if (typeof createdRoundId === 'string') setScorecardRoundId(createdRoundId)
      setNotice('Member interview room opened. Use your preferred video call, then record the scorecard below.')
      await onChanged()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(round: HumanRoundView) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/workspace/human-rounds/${round.id}/revoke`, {
        method: 'POST',
      })
      if (!response.ok) {
        setError(await responseError(response, 'Could not revoke this human round.'))
        return
      }
      if (scorecardRoundId === round.id) setScorecardRoundId(null)
      setNotice(round.mode === 'guest_kit' ? 'Interview kit revoked.' : 'Member-led interview discarded.')
      await onChanged()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  function openScorecard(roundId: string) {
    setError(null)
    setNotice(null)
    setScorecardRoundId(roundId)
    setRatings(newRatings())
    setEvidence(newEvidence())
    setRecommendation('yes')
    setOverallComment('')
  }

  async function submitScorecard(event: React.FormEvent) {
    event.preventDefault()
    if (!scorecardRoundId) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/workspace/human-rounds/${scorecardRoundId}/scorecard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dimensions: DIMENSIONS.map(([key]) => ({
            key,
            rating: ratings[key],
            evidence: evidence[key].trim(),
          })),
          recommendation,
          overallComment: overallComment.trim(),
        }),
      })
      if (!response.ok) {
        setError(await responseError(response, 'Could not submit the scorecard.'))
        return
      }
      setScorecardRoundId(null)
      setNotice('Scorecard submitted. Its evidence now appears as a completed human round.')
      await onChanged()
    } catch {
      setError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-4" aria-labelledby="human-rounds-heading">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 id="human-rounds-heading" className="text-sm font-semibold text-[#0f1419]">
            Human interview rounds
          </h2>
          <p className="mt-1 text-xs text-[#71767b]">
            Send a brief + scorecard to an interviewer, or record a member-led call. Human evidence stays separate from AI assessments.
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowGuestForm((value) => !value)}>
              {showGuestForm ? 'Cancel kit' : 'Send interviewer kit'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void createMemberRound()}>
              {busy ? 'Opening…' : 'Open member interview room'}
            </Button>
          </div>
        )}
      </div>

      {!canCreate && (
        <p className="text-xs text-[#71767b]">
          Human rounds can be created only while this application and job are active.
        </p>
      )}

      {error && <p className="text-sm text-[#f4212e]" role="alert">{error}</p>}
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}

      {showGuestForm && canCreate && (
        <form onSubmit={createGuestRound} className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-3">
          <p className="text-sm font-medium text-indigo-950">Send a scorecard-only interviewer kit</p>
          <p className="text-xs text-indigo-900">
            The interviewer receives an expiring link by email. It contains a minimal brief and no candidate contact details or AI result.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              label="Interviewer name"
              value={interviewerName}
              onChange={(event) => setInterviewerName(event.target.value)}
              maxLength={120}
              required
            />
            <Input
              label="Interviewer email"
              type="email"
              value={interviewerEmail}
              onChange={(event) => setInterviewerEmail(event.target.value)}
              maxLength={254}
              required
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || !interviewerName.trim() || !interviewerEmail.trim()}>
            {busy ? 'Sending…' : 'Send kit'}
          </Button>
        </form>
      )}

      {humanRounds.length === 0 ? (
        <p className="text-sm text-[#536471]">No human interview rounds logged yet.</p>
      ) : (
        <div className="space-y-3">
          {humanRounds.map((round) => {
            const chip = roundBadge(round)
            const isMemberDraft = round.mode === 'member_room' && round.status === 'pending_scorecard'
            const isOpenScorecard = scorecardRoundId === round.id
            return (
              <div key={round.id} className="rounded-xl border border-[#e1e8ed] p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-[#0f1419]">
                      {round.mode === 'guest_kit' ? 'Interviewer kit' : 'Member-run interview'}
                    </p>
                    <p className="mt-1 text-xs text-[#71767b]">
                      Logged {new Date(round.createdAt).toLocaleString()}
                      {round.openedAt && ` · opened ${new Date(round.openedAt).toLocaleString()}`}
                      {round.scorecardSubmittedAt && ` · submitted ${new Date(round.scorecardSubmittedAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={chip.variant}>{chip.label}</Badge>
                    {canCreate && round.status === 'pending_scorecard' && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void revoke(round)}>
                        {round.mode === 'guest_kit' ? 'Revoke kit' : 'Discard round'}
                      </Button>
                    )}
                  </div>
                </div>

                {canCreate && isMemberDraft && !isOpenScorecard && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => openScorecard(round.id)}>
                    Complete my scorecard
                  </Button>
                )}

                {round.delivery?.initial && (
                  <InitialDeliveryState delivery={round.delivery.initial} />
                )}
                {round.delivery?.reminder && (
                  <ReminderDeliveryState delivery={round.delivery.reminder} />
                )}

                {round.scorecard && (
                  <div className="rounded-lg border border-[#e1e8ed] bg-[#f8fafc] p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <h3 className="text-sm font-medium text-[#0f1419]">Submitted scorecard</h3>
                        <p className="mt-1 text-xs text-[#71767b]">
                          Submitted by {round.scorecard.reviewerName} · {new Date(round.scorecard.submittedAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge variant={round.scorecard.recommendation === 'strong_yes' || round.scorecard.recommendation === 'yes' ? 'success' : 'caution'}>
                        {RECOMMENDATION_LABEL[round.scorecard.recommendation]}
                      </Badge>
                    </div>
                    <dl className="grid gap-3 md:grid-cols-2">
                      {round.scorecard.dimensions.map((dimension) => (
                        <div key={dimension.key} className="rounded-md border border-[#e1e8ed] bg-white p-3">
                          <dt className="text-xs font-medium text-[#0f1419]">
                            {dimensionLabel(dimension.key)} · {dimension.rating} / 5
                          </dt>
                          <dd className="mt-1 text-xs whitespace-pre-wrap text-[#536471]">{dimension.evidence}</dd>
                        </div>
                      ))}
                    </dl>
                    <div>
                      <p className="text-xs font-medium text-[#0f1419]">Overall comment</p>
                      <p className="mt-1 text-sm whitespace-pre-wrap text-[#536471]">{round.scorecard.overallComment}</p>
                    </div>
                  </div>
                )}

                {canCreate && isOpenScorecard && (
                  <form onSubmit={submitScorecard} className="rounded-lg bg-[#f8fafc] border border-[#e1e8ed] p-4 space-y-4">
                    <div>
                      <h3 className="text-sm font-medium text-[#0f1419]">Member-run interview room</h3>
                      <p className="mt-1 text-xs text-[#71767b]">Use your preferred video call, then rate every dimension and record specific interview evidence here.</p>
                    </div>
                    {DIMENSIONS.map(([key, label]) => (
                      <div key={key} className="grid gap-2 md:grid-cols-[10rem_1fr] md:items-start">
                        <div>
                          <label htmlFor={`${round.id}-${key}-rating`} className="block text-sm text-[#0f1419]">{label}</label>
                          <select
                            id={`${round.id}-${key}-rating`}
                            aria-label={`${label} rating`}
                            value={ratings[key]}
                            onChange={(event) => setRatings((current) => ({ ...current, [key]: Number(event.target.value) }))}
                            className="mt-1 h-9 rounded-[6px] border border-[#e1e8ed] bg-white px-2 text-sm"
                          >
                            {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating} / 5</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`${round.id}-${key}-evidence`} className="block text-xs text-[#536471]">Evidence</label>
                          <textarea
                            id={`${round.id}-${key}-evidence`}
                            aria-label={`${label} evidence`}
                            value={evidence[key]}
                            onChange={(event) => setEvidence((current) => ({ ...current, [key]: event.target.value }))}
                            required
                            maxLength={2000}
                            rows={2}
                            className="mt-1 w-full rounded-[6px] border border-[#e1e8ed] bg-white px-3 py-2 text-sm"
                            placeholder="What did the interviewer observe?"
                          />
                        </div>
                      </div>
                    ))}
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <label htmlFor={`${round.id}-recommendation`} className="block text-sm text-[#0f1419]">Recommendation</label>
                        <select
                          id={`${round.id}-recommendation`}
                          value={recommendation}
                          onChange={(event) => setRecommendation(event.target.value as Recommendation)}
                          className="mt-1 h-9 w-full rounded-[6px] border border-[#e1e8ed] bg-white px-2 text-sm"
                        >
                          <option value="strong_yes">Strong yes</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                          <option value="strong_no">Strong no</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${round.id}-overall-comment`} className="block text-sm text-[#0f1419]">Overall comment</label>
                        <textarea
                          id={`${round.id}-overall-comment`}
                          value={overallComment}
                          onChange={(event) => setOverallComment(event.target.value)}
                          required
                          maxLength={4000}
                          rows={2}
                          className="mt-1 w-full rounded-[6px] border border-[#e1e8ed] bg-white px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" disabled={busy || !overallComment.trim() || DIMENSIONS.some(([key]) => !evidence[key].trim())}>
                        {busy ? 'Submitting…' : 'Submit scorecard'}
                      </Button>
                      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setScorecardRoundId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
