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
import { ScoreBar, scoreBand } from '@shared/ui/ScoreBar'
import StateView from '@shared/ui/StateView'

// Canonical 75/55 bands (shared/ui/ScoreBar) — a 72 must never be green here
// while amber in the adjacent ScoreBar (Codex on #603, same class as #498).
function scoreBadgeVariant(score: number): 'success' | 'caution' | 'danger' {
  const band = scoreBand(score)
  return band === 'strong' ? 'success' : band === 'ok' ? 'caution' : 'danger'
}

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
  evaluationFailed?: boolean
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
  unscored?: boolean
  completedAfterRevoke?: boolean
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
  attemptCount: number | null
  results: RoundResults | null
}

interface CardData {
  application: {
    id: string
    jobId: string
    stage: string
    decisionNote: string | null
    resumeMatch?: {
      score: number | null
      strengths: string[]
      gaps: string[]
      scoredAt: string
      stale: boolean
    } | null
    /** Append-only public apply-page submissions, newest first. */
    applicantSubmissions?: Array<{
      text: string
      fileName: string | null
      submittedAt: string
      score: number | null
    }>
    events: Array<{
      type: string
      from: string | null
      to: string | null
      actorName: string
      note: string | null
      at: string
    }>
  }
  candidate: {
    id: string
    name: string
    email: string
    phone: string | null
    /** Workspace pool résumé — what a FIRST-TIME applicant's CV lands in. */
    resumeText?: string | null
    resumeFileName?: string | null
  }
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

  async function adjudicateSubmission(index: number, action: 'promote' | 'delete') {
    if (action === 'delete' && !confirm('Delete this submitted résumé? This is recorded in the audit trail.')) return
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/applications/${params.appId}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, action }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setActionError(body.error || 'Could not update the submission.')
        return
      }
      await load()
    } catch {
      setActionError('Something went wrong.')
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
                <Badge variant={scoreBadgeVariant(results.overallScore)} dot>
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
              {/* Visible whenever no round is live — a follow-up AI round
                  after a completed one is a supported flow. */}
              {!liveRound && (
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

      {/* Resume-vs-JD match from intake (Phase 2) — evidence, not verdict */}
      {application.resumeMatch && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-[#0f1419]">Résumé match</p>
            {application.resumeMatch.score != null ? (
              <Badge variant={scoreBadgeVariant(application.resumeMatch.score)} dot>
                {application.resumeMatch.score} / 100
              </Badge>
            ) : (
              <Badge>unscored</Badge>
            )}
            {application.resumeMatch.stale && (
              <Badge variant="caution">outdated — résumé replaced since scoring</Badge>
            )}
          </div>
          {application.resumeMatch.score != null && (
            <ScoreBar label="JD match (résumé)" score={application.resumeMatch.score} />
          )}
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            {application.resumeMatch.strengths.length > 0 && (
              <div>
                <p className="text-xs font-medium text-[#536471] mb-1">Evidence for</p>
                <ul className="space-y-1 text-[#0f1419]">
                  {application.resumeMatch.strengths.map((s, i) => (
                    <li key={i}>· {s}</li>
                  ))}
                </ul>
              </div>
            )}
            {application.resumeMatch.gaps.length > 0 && (
              <div>
                <p className="text-xs font-medium text-[#536471] mb-1">No evidence of</p>
                <ul className="space-y-1 text-[#0f1419]">
                  {application.resumeMatch.gaps.map((g, i) => (
                    <li key={i}>· {g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Résumé submitted through the public apply page. Shown whenever it
          exists, because it — not the pool résumé — is what the JD-match
          score above was computed from. */}
      {/* EVERY résumé on file, never one instead of another. The pool copy
          (a first-time applicant's, or a bulk upload's) and each public
          submission are shown together: rendering only the submissions let
          an anonymous caller hide the original simply by appending one of
          their own (Codex P1 on #615). Divergence is called out, because
          two different documents for one person is itself the signal. */}
      {(candidate.resumeText || application.applicantSubmissions?.length) && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-[#0f1419]">Résumés on file</p>
            {(application.applicantSubmissions?.length ?? 0) > 0 && candidate.resumeText && (
              <Badge variant="caution">
                {application.applicantSubmissions!.length} submitted via apply page
              </Badge>
            )}
          </div>

          {(application.applicantSubmissions?.length ?? 0) +
            (candidate.resumeText ? 1 : 0) >
            1 && (
            <p className="text-xs text-[#f4212e]">
              More than one résumé exists for this candidate. Anyone with the public link can
              add a document, so review each before deciding — the newest is not automatically
              the authentic one, and nothing here has replaced anything.
            </p>
          )}

          {candidate.resumeText && (
            <details className="text-sm border border-[#e1e8ed] rounded-xl p-3">
              <summary className="cursor-pointer text-xs text-[#536471]">
                {candidate.resumeFileName ?? 'On file'} · on the candidate record
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-[#0f1419] max-h-80 overflow-y-auto bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-3">
                {candidate.resumeText}
              </pre>
            </details>
          )}

          {application.applicantSubmissions?.map((sub, i) => (
            <details key={i} className="text-sm border border-[#e1e8ed] rounded-xl p-3">
              <summary className="cursor-pointer text-xs text-[#536471]">
                {sub.fileName ?? 'Attached file'} · submitted{' '}
                {new Date(sub.submittedAt).toLocaleString()}
                {sub.score != null ? ` · JD match ${sub.score}` : ' · unscored'}
                {i === 0 ? ' · newest' : ''}
                {i === application.applicantSubmissions!.length - 1 &&
                application.applicantSubmissions!.length > 1
                  ? ' · first received'
                  : ''}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-[#0f1419] max-h-80 overflow-y-auto bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-3">
                {sub.text}
              </pre>
              {/* Adjudication — the only path that removes evidence, so it
                  is deliberate, attributed and written to the timeline. */}
              <div className="mt-2 flex gap-2">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void adjudicateSubmission(i, 'promote')}
                >
                  This one is authentic
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void adjudicateSubmission(i, 'delete')}
                >
                  Delete as fraudulent
                </Button>
              </div>
            </details>
          ))}
        </div>
      )}

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

          {round.results?.unscored && (
            <p className="text-sm text-amber-600">
              The AI declined to score this interview — the candidate didn&apos;t answer
              enough questions. Details are in the flags below; per-answer scores (if
              any) are shown for the answers that were given.
            </p>
          )}

          {round.results?.completedAfterRevoke && (
            <p className="text-sm text-red-600">
              This interview was completed <strong>after the link was revoked</strong> —
              the candidate had already started when the link was killed. Results are
              attached for completeness; treat them at your discretion.
            </p>
          )}

          {(round.attemptCount ?? 0) > 1 && (
            <p className="text-sm text-amber-600">
              The candidate started this interview {round.attemptCount} times — the
              scores below are from the first completed run.
            </p>
          )}

          {round.results && (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                {/* Never paint a missing score as a red 0 — while the report
                    is pending the "report pending" note above is the truth. */}
                {round.results.overallScore != null && (
                  <ScoreBar label="Overall" score={round.results.overallScore} />
                )}
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
                        {q.evaluationFailed && (
                          <p className="text-xs text-amber-600">
                            The AI evaluation of this answer failed — no scores are shown
                            for it. Read the answer above and judge it directly.
                          </p>
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
