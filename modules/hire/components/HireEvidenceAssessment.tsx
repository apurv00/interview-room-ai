'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

interface EvidenceRef {
  id: string
  type: 'transcript_span' | 'recording_range' | 'integrity_observation' | 'identity_photo'
  questionId?: string
  startMs?: number
  endMs?: number
  mediaAssetId?: string
  transcriptExcerpt?: string
}

interface Assessment {
  overallScore: number | null
  overallEvidenceIds: string[]
  recommendation?: string
  confidence?: string
  dimensions: Array<{
    key: string
    label: string
    score: number | null
    evidenceIds: string[]
  }>
  findings: Array<{
    kind: 'strength' | 'gap'
    text: string
    evidenceIds: string[]
  }>
  questions: Array<{
    questionId: string
    index: number
    prompt: string
    answer?: string
    score: number | null
    evidenceIds: string[]
    questionStartedMs?: number
    answerStartedMs?: number
    answerEndedMs?: number
  }>
}

interface Props {
  applicationId: string
  assessment: Assessment
  evidenceIndex: EvidenceRef[]
  identityPhoto: { assetId: string; capturedAt: string } | null
  mediaPurged: boolean
}

function timestamp(value?: number): string {
  if (value === undefined) return 'timestamp unavailable'
  const seconds = Math.max(0, Math.floor(value / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function ScoreEvidenceButton({
  label,
  score,
  evidenceIds,
  onOpen,
}: {
  label: string
  score: number
  evidenceIds: string[]
  onOpen: (ids: string[], label: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(evidenceIds, label)}
      className="rounded-xl border border-[#dbe5ef] bg-[#f8fafc] p-3 text-left transition hover:border-[#2563eb] hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-[#2563eb]/30"
      aria-label={`${label}: ${score} out of 100. Open cited evidence.`}
    >
      <span className="block text-xs text-[#536471]">{label}</span>
      <span className="mt-1 block text-xl font-bold text-[#0f1419]">{score}</span>
      <span className="mt-1 block text-xs font-medium text-[#2563eb]">
        View cited moment{evidenceIds.length === 1 ? '' : 's'}
      </span>
    </button>
  )
}

function RecordingEvidence({
  applicationId,
  evidence,
}: {
  applicationId: string
  evidence: EvidenceRef
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  async function loadRecording() {
    if (!evidence.mediaAssetId || loading) return
    setLoading(true)
    setError(false)
    try {
      const response = await fetch(
        `/api/workspace/applications/${encodeURIComponent(applicationId)}/media/${encodeURIComponent(evidence.mediaAssetId)}`,
        { cache: 'no-store' },
      )
      if (!response.ok) throw new Error('media unavailable')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('media unavailable')
      setUrl(body.url)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (url) {
    return (
      <video
        ref={videoRef}
        controls
        preload="metadata"
        src={url}
        className="mt-3 w-full rounded-lg bg-black"
        onLoadedMetadata={() => {
          if (videoRef.current && evidence.startMs !== undefined) {
            videoRef.current.currentTime = evidence.startMs / 1_000
          }
        }}
      >
        Your browser cannot play this private interview recording.
      </video>
    )
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void loadRecording()}
        disabled={loading || !evidence.mediaAssetId}
        className="text-xs font-semibold text-[#2563eb] underline disabled:text-[#8b98a5]"
      >
        {loading ? 'Opening private recording…' : `Play from ${timestamp(evidence.startMs)}`}
      </button>
      {error && (
        <p className="mt-1 text-xs text-[#71767b]">
          Media was removed or is temporarily unavailable; transcript evidence remains.
        </p>
      )}
    </div>
  )
}

export default function HireEvidenceAssessment({
  applicationId,
  assessment,
  evidenceIndex,
  identityPhoto,
  mediaPurged,
}: Props) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [photoUnavailable, setPhotoUnavailable] = useState(false)
  const [selected, setSelected] = useState<{ ids: string[]; label: string } | null>(null)
  const evidenceById = useMemo(
    () => new Map(evidenceIndex.map((evidence) => [evidence.id, evidence])),
    [evidenceIndex],
  )
  const questionById = useMemo(
    () => new Map(assessment.questions.map((question) => [question.questionId, question])),
    [assessment.questions],
  )

  useEffect(() => {
    if (!identityPhoto || mediaPurged) return
    let cancelled = false
    fetch(
      `/api/workspace/applications/${encodeURIComponent(applicationId)}/media/${encodeURIComponent(identityPhoto.assetId)}`,
      { cache: 'no-store' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('photo unavailable')
        return response.json() as Promise<{ url?: string }>
      })
      .then((body) => {
        if (!cancelled && body.url) setPhotoUrl(body.url)
      })
      .catch(() => {
        if (!cancelled) setPhotoUnavailable(true)
      })
    return () => {
      cancelled = true
    }
  }, [applicationId, identityPhoto, mediaPurged])

  const openEvidence = (ids: string[], label: string) => {
    if (ids.length > 0) setSelected({ ids, label })
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-[160px_1fr]">
        <div>
          <p className="mb-2 text-xs font-medium text-[#536471]">Interview identity photo</p>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived private R2 URL
            <img
              src={photoUrl}
              alt="Candidate identity selfie captured at interview start"
              className="aspect-square w-full rounded-xl border border-[#e1e8ed] object-cover"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-[#cfd9de] bg-[#f8fafc] p-3 text-center text-xs text-[#71767b]">
              {mediaPurged || photoUnavailable
                ? 'Media removed under the retention or deletion policy'
                : identityPhoto
                  ? 'Loading private photo…'
                  : 'No identity photo available'}
            </div>
          )}
          {identityPhoto && (
            <p className="mt-1 text-[11px] text-[#71767b]">
              Captured {new Date(identityPhoto.capturedAt).toLocaleString()}
            </p>
          )}
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            {assessment.recommendation && (
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-800">
                AI recommendation (supporting evidence only): {assessment.recommendation}
              </span>
            )}
            {assessment.confidence && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">
                Confidence: {assessment.confidence}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {assessment.overallScore !== null && (
              <ScoreEvidenceButton
                label="Overall"
                score={assessment.overallScore}
                evidenceIds={assessment.overallEvidenceIds}
                onOpen={openEvidence}
              />
            )}
            {assessment.dimensions.map((dimension) =>
              dimension.score === null ? null : (
                <ScoreEvidenceButton
                  key={dimension.key}
                  label={dimension.label}
                  score={dimension.score}
                  evidenceIds={dimension.evidenceIds}
                  onOpen={openEvidence}
                />
              ),
            )}
          </div>
        </div>
      </div>

      {assessment.findings.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {assessment.findings.map((finding, index) => (
            <button
              key={`${finding.kind}-${index}`}
              type="button"
              onClick={() => openEvidence(finding.evidenceIds, finding.text)}
              className={`rounded-xl border p-3 text-left text-sm ${
                finding.kind === 'strength'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                  : 'border-amber-200 bg-amber-50 text-amber-950'
              }`}
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wide">
                {finding.kind}
              </span>
              {finding.text}
              <span className="mt-1 block text-xs underline">Open evidence</span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#536471]">
          Question evidence
        </p>
        {assessment.questions.map((question) => (
          <details key={question.questionId} className="rounded-xl border border-[#e1e8ed] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#0f1419]">
              Q{question.index + 1} · {question.score ?? 'unscored'} · {question.prompt}
            </summary>
            <div className="mt-3 space-y-2 text-sm">
              {question.answer && (
                <blockquote className="border-l-2 border-[#cfd9de] pl-3 text-[#536471]">
                  {question.answer}
                </blockquote>
              )}
              <button
                type="button"
                disabled={question.evidenceIds.length === 0}
                onClick={() => openEvidence(question.evidenceIds, `Question ${question.index + 1}`)}
                className="text-xs font-semibold text-[#2563eb] underline disabled:text-[#8b98a5]"
              >
                Open cited transcript at {timestamp(question.answerStartedMs)}
              </button>
            </div>
          </details>
        ))}
      </div>

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Evidence for ${selected.label}`}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 md:items-center"
          onClick={() => setSelected(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-[#71767b]">Cited evidence</p>
                <h3 className="text-base font-semibold text-[#0f1419]">{selected.label}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg px-2 py-1 text-sm text-[#536471] hover:bg-slate-100"
                aria-label="Close evidence"
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {selected.ids.map((id) => {
                const evidence = evidenceById.get(id)
                const question = evidence?.questionId
                  ? questionById.get(evidence.questionId)
                  : undefined
                return (
                  <div key={id} className="rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-3">
                    <p className="text-xs font-semibold text-[#2563eb]">
                      {evidence?.type.replaceAll('_', ' ') ?? 'Evidence unavailable'} ·{' '}
                      {timestamp(evidence?.startMs)}
                    </p>
                    {question && (
                      <>
                        <p className="mt-2 text-sm font-medium text-[#0f1419]">{question.prompt}</p>
                        {question.answer && (
                          <p className="mt-1 whitespace-pre-wrap text-sm text-[#536471]">
                            {question.answer}
                          </p>
                        )}
                      </>
                    )}
                    {evidence?.type === 'transcript_span' && evidence.transcriptExcerpt && (
                      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-[#cfd9de] pl-3 text-sm text-[#536471]">
                        {evidence.transcriptExcerpt}
                      </blockquote>
                    )}
                    {evidence?.type === 'recording_range' && (
                      <RecordingEvidence applicationId={applicationId} evidence={evidence} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
