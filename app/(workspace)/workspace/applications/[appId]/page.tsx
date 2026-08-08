'use client'

/**
 * Candidate card — decision-first (build plan §Dashboard & screens #4).
 * Header leads with the AI recommendation evidence; dimension bars and a
 * per-question breakdown link every number to the answer that produced it.
 * All round/stage actions live here: send AI interview, revoke link,
 * advance / reject. Loading this page triggers server-side reconciliation,
 * so fresh AI results appear the moment the member looks.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Accordion from '@shared/ui/Accordion'
import { ScoreBar } from '@shared/ui/ScoreBar'
import StateView from '@shared/ui/StateView'

interface PerQuestion {
  questionIndex: number
  question: string
  answer?: string
  answerSummary?: string
  score: number | null
  relevance?: number | null
  structure?: number | null
  specificity?: number | null
  ownership?: number | null
  jdAlignment?: number | null
  flags?: string[]
}

interface RoundResults {
  overallScore: number | null
  passProbability?: string
  confidenceLevel?: string
  answerQualityScore?: number | null
  communicationScore?: number | null
  jdMatchScore?: number | null
  redFlags?: string[]
  topImprovements?: string[]
  answeredCount?: number | null
  plannedQuestionCount?: number | null
  endReason?: string | null
  perQuestion?: PerQuestion[]
  pending?: boolean
}

interface Round {
  id: string
  status: string
  invitedAt: string
  inviteExpiresAt: string
  consentAt: string | null
  linkedAt: string | null
  revokedAt: string | null
  config: { role: string; experience: string; duration: number }
  results: RoundResults | null
}

interface CardData {
  application: {
    id: string
    jobId: string
    stage: string
    decisionNote: string | null
    events: Array<{
      type: string
      from: string | null
      to: string | null
      actorName: string
      note: string | null
      at: string
    }>
  }
  candidate: { id: string; name: string; email: string; phone: string | null }
  job: { id: string; title: string; status: string }
  rounds: Round[]
  activity: Array<{ roundId: string; inProgress: boolean }>
}

const TERMINAL = ['hired', 'rejected']

export default function ApplicationCardPage({ params }: { params: { appId: string } }) {
  const [data, setData] = useState<CardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSend, setShowSend] = useState(false)
  const [experience, setExperience] = useState<'0-2' | '3-6' | '7+'>('3-6')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(true)
  const [needNote, setNeedNote] = useState<'advance' | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/workspace/applications/${params.appId}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error)
      setData(body)
    } catch {
      setError('Could not load this candidate.')
    }
  }, [params.appId])

  useEffect(() => {
    void load()
  }, [load])

  async function sendAiInterview(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/applications/${params.appId}/rounds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experience, duration: 15 }),
      })
      const body = await res.json()
      if (!res.ok) {
        setActionError(body.error || 'Could not send the AI interview.')
        return
      }
      setInviteUrl(body.inviteUrl)
      setEmailSent(body.emailSent)
      setShowSend(false)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(roundId: string) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/rounds/${roundId}/revoke`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error || 'Could not revoke the link.')
        return
      }
      setInviteUrl(null)
      await load()
    } catch {
      setActionError('Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function moveStage(action: 'advance' | 'reject', moveNote?: string) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/applications/${params.appId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(moveNote ? { note: moveNote } : {}) }),
      })
      const body = await res.json()
      if (!res.ok) {
        if (body.code === 'DECISION_NOTE_REQUIRED') {
          setNeedNote('advance')
          return
        }
        setActionError(body.error || 'Could not move the candidate.')
        return
      }
      setNeedNote(null)
      setNote('')
      await load()
    } catch {
      setActionError('Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (!data) return <StateView state="loading" skeletonLayout="card" />

  const { application, candidate, job, rounds, activity } = data
  const latest = rounds[0] ?? null
  const results = latest?.results ?? null
  const inProgress = activity.some((a) => a.inProgress)
  const terminal = TERMINAL.includes(application.stage)
  const liveRound =
    latest && !latest.revokedAt && latest.status !== 'completed' ? latest : null

  return (
    <div className="space-y-6">
      {/* Decision-first header */}
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6">
        <Link
          href={`/workspace/jobs/${job.id}`}
          className="text-xs text-[#71767b] hover:text-indigo-600"
        >
          ← {job.title}
        </Link>
        <div className="flex items-start justify-between gap-4 mt-1 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-[#0f1419]">{candidate.name}</h1>
            <p className="text-sm text-[#536471]">
              {candidate.email}
              {candidate.phone ? ` · ${candidate.phone}` : ''}
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge variant="primary">{application.stage}</Badge>
              {results?.overallScore != null && (
                <Badge
                  variant={
                    results.overallScore >= 70
                      ? 'success'
                      : results.overallScore >= 50
                        ? 'caution'
                        : 'danger'
                  }
                  dot
                >
                  AI {results.overallScore}
                </Badge>
              )}
              {results?.passProbability && (
                <span className="text-xs text-[#536471]">
                  Pass probability: {results.passProbability}
                  {results.confidenceLevel ? ` · Confidence: ${results.confidenceLevel}` : ''}
                </span>
              )}
              {inProgress && <Badge variant="primary">Interview in progress</Badge>}
            </div>
          </div>
          {!terminal && job.status === 'open' && (
            <div className="flex gap-2 shrink-0">
              {!liveRound && latest?.status !== 'completed' && (
                <Button onClick={() => setShowSend((v) => !v)}>
                  {showSend ? 'Cancel' : 'Send AI interview'}
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => void moveStage('advance')}>
                Advance
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void moveStage('reject')}>
                Reject
              </Button>
            </div>
          )}
        </div>
        {application.decisionNote && (
          <p className="mt-3 text-sm text-emerald-700">Decision: {application.decisionNote}</p>
        )}
        {actionError && <p className="mt-3 text-sm text-[#f4212e]">{actionError}</p>}
        {needNote && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-[#536471]">
              A decision note is required to mark this candidate Hired.
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={4000}
              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              placeholder="Why this candidate?"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || note.trim().length === 0}
                onClick={() => void moveStage('advance', note.trim())}
              >
                Confirm hire
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setNeedNote(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Send AI interview */}
      {showSend && (
        <form
          onSubmit={sendAiInterview}
          className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3"
        >
          <p className="text-sm font-medium text-[#0f1419]">
            Send a 15-minute AI screening interview for “{job.title}” to {candidate.email}.
          </p>
          <div className="space-y-1.5">
            <label className="text-sm text-[#536471] block">Candidate&apos;s experience level</label>
            <select
              value={experience}
              onChange={(e) => setExperience(e.target.value as typeof experience)}
              className="px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
            >
              <option value="0-2">0–2 years</option>
              <option value="3-6">3–6 years</option>
              <option value="7+">7+ years</option>
            </select>
          </div>
          <p className="text-xs text-[#71767b]">
            The candidate sees a recording + AI-analysis disclosure and must consent
            before anything starts. The link expires in 7 days and can be revoked.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send invite'}
          </Button>
        </form>
      )}

      {inviteUrl && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 text-sm space-y-1">
          <p className="text-indigo-900 font-medium">
            {emailSent ? 'Invite emailed.' : 'Email delivery unavailable — share this link directly:'}
          </p>
          <code className="block text-xs break-all text-indigo-800">{inviteUrl}</code>
        </div>
      )}

      {/* Rounds + evidence */}
      {rounds.map((round) => (
        <div key={round.id} className="bg-white border border-[#e1e8ed] rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-[#0f1419]">
                AI interview · {round.config.duration} min · {round.config.experience} yrs
              </h2>
              <p className="text-xs text-[#71767b]">
                Sent {new Date(round.invitedAt).toLocaleString()}
                {round.consentAt && ' · consent recorded'}
                {round.linkedAt && ` · completed ${new Date(round.linkedAt).toLocaleString()}`}
                {round.revokedAt && ' · revoked'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  round.status === 'completed'
                    ? 'success'
                    : round.revokedAt
                      ? 'default'
                      : 'primary'
                }
              >
                {round.revokedAt ? 'revoked' : round.status.replace('_', ' ')}
              </Badge>
              {!round.revokedAt && round.status !== 'completed' && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void revoke(round.id)}>
                  Revoke link
                </Button>
              )}
            </div>
          </div>

          {round.results?.pending && (
            <p className="text-sm text-amber-600">
              Interview finished — the full report is still being generated. Per-answer
              scores below are already final.
            </p>
          )}

          {round.results && (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                <ScoreBar label="Overall" score={round.results.overallScore ?? 0} />
                {round.results.answerQualityScore != null && (
                  <ScoreBar label="Answer quality" score={round.results.answerQualityScore} />
                )}
                {round.results.jdMatchScore != null && (
                  <ScoreBar label="JD match" score={round.results.jdMatchScore} />
                )}
              </div>
              {(round.results.answeredCount != null || round.results.endReason) && (
                <p className="text-xs text-[#71767b]">
                  {round.results.answeredCount != null &&
                    `Answered ${round.results.answeredCount}${round.results.plannedQuestionCount ? ` of ${round.results.plannedQuestionCount} planned` : ''} questions`}
                  {round.results.endReason && ` · ended: ${round.results.endReason}`}
                </p>
              )}
              {round.results.redFlags && round.results.redFlags.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  {round.results.redFlags.map((flag, i) => (
                    <Badge key={i} variant="danger">
                      {flag}
                    </Badge>
                  ))}
                </div>
              )}
              {round.results.perQuestion && round.results.perQuestion.length > 0 && (
                <Accordion
                  mode="multi"
                  items={round.results.perQuestion.map((q) => ({
                    title: `Q${q.questionIndex + 1} · ${q.score != null ? `${q.score}` : '—'} · ${q.question.slice(0, 80)}${q.question.length > 80 ? '…' : ''}`,
                    content: (
                      <div className="space-y-3 text-sm">
                        <p className="text-[#0f1419] font-medium">{q.question}</p>
                        {q.answer && (
                          <blockquote className="border-l-2 border-[#e1e8ed] pl-3 text-[#536471] whitespace-pre-wrap">
                            {q.answer}
                          </blockquote>
                        )}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {q.relevance != null && <ScoreBar label="Relevance" score={q.relevance} />}
                          {q.structure != null && <ScoreBar label="Structure" score={q.structure} />}
                          {q.specificity != null && <ScoreBar label="Specificity" score={q.specificity} />}
                          {q.ownership != null && <ScoreBar label="Ownership" score={q.ownership} />}
                        </div>
                        {q.flags && q.flags.length > 0 && (
                          <div className="flex gap-2 flex-wrap">
                            {q.flags.map((f, i) => (
                              <Badge key={i} variant="caution">
                                {f}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ),
                  }))}
                />
              )}
            </>
          )}
        </div>
      ))}

      {/* Audit timeline */}
      <div className="bg-white border border-[#e1e8ed] rounded-2xl p-6">
        <h2 className="text-sm font-semibold text-[#0f1419] mb-3">History</h2>
        <ul className="space-y-2">
          {[...application.events].reverse().map((ev, i) => (
            <li key={i} className="text-sm text-[#536471]">
              <span className="text-xs text-[#71767b]">
                {new Date(ev.at).toLocaleString()} ·
              </span>{' '}
              <strong className="text-[#0f1419]">{ev.actorName}</strong>{' '}
              {ev.type === 'stage_move'
                ? `moved ${ev.from} → ${ev.to}`
                : ev.type.replaceAll('_', ' ')}
              {ev.note ? ` — ${ev.note}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
