'use client'

import { useMemo } from 'react'
import MetricCard from '@shared/ui/MetricCard'
import { ScoreBar } from '@interview/components/ScoreBar'
import CommunicationDetail from '@interview/components/feedback/CommunicationDetail'
import PeerComparison, { type PeerData } from '@interview/components/feedback/PeerComparison'
import type { FeedbackData, StoredInterviewData, EngagementSignals, DeliverySignals } from '@shared/types'
import { PROBABILITY_COLORS, CONFIDENCE_TREND_LABELS } from '@interview/config/feedbackConfig'

// Helper: safely coerce to string for rendering (prevents React #310 on unexpected objects)
function s(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface OverviewTabProps {
  data: StoredInterviewData
  feedback: FeedbackData
  sessionId: string
  peerData: PeerData | null
  peerLoading: boolean
}

export default function OverviewTab({ data, feedback, sessionId, peerData, peerLoading }: OverviewTabProps) {
  const { dimensions, red_flags, top_3_improvements } = feedback
  const { answer_quality, communication } = dimensions

  const engagementSignals: EngagementSignals | null = dimensions.engagement_signals || null
  const deliverySignals: DeliverySignals | null = dimensions.delivery_signals || null

  // Single one-pass reduce for all avg scores
  const avgScores = useMemo(() => {
    if (!data.evaluations || data.evaluations.length === 0) return null
    const n = data.evaluations.length
    const sums = data.evaluations.reduce(
      (acc, e) => ({
        relevance: acc.relevance + (Number(e.relevance) || 0),
        structure: acc.structure + (Number(e.structure) || 0),
        specificity: acc.specificity + (Number(e.specificity) || 0),
        ownership: acc.ownership + (Number(e.ownership) || 0),
      }),
      { relevance: 0, structure: 0, specificity: 0, ownership: 0 }
    )
    return {
      relevance: Math.round(sums.relevance / n),
      structure: Math.round(sums.structure / n),
      specificity: Math.round(sums.specificity / n),
      ownership: Math.round(sums.ownership / n),
    }
  }, [data.evaluations])

  return (
    <div className="space-y-6">
      {/* Score breakdown */}
      <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-component animate-fade-in">
        {/* Answer Quality */}
        <MetricCard
          title="Answer Quality"
          score={Number(answer_quality.score) || 0}
          color="auto"
          metrics={[
            { label: 'Relevance', value: avgScores?.relevance ?? answer_quality.score },
            { label: 'Structure (STAR)', value: avgScores?.structure ?? answer_quality.score },
            { label: 'Specificity', value: avgScores?.specificity ?? answer_quality.score },
            { label: 'Ownership', value: avgScores?.ownership ?? answer_quality.score },
          ]}
          insights={{
            strengths: Array.isArray(answer_quality.strengths) ? answer_quality.strengths.map((str) => s(str)) : undefined,
            improvements: Array.isArray(answer_quality.weaknesses) ? answer_quality.weaknesses.map((w) => s(w)) : undefined,
          }}
        />

        {/* Communication */}
        <div className="surface-card-bordered p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-subheading text-[#f0f2f5]">Communication</span>
            <span className="text-heading font-bold text-cyan-400" role="meter" aria-valuenow={Number(communication.score) || 0} aria-valuemin={0} aria-valuemax={100} aria-label={`Communication score: ${Number(communication.score) || 0} out of 100`}>
              {Number(communication.score) || 0}
            </span>
          </div>
          <div className="space-y-3">
            <ScoreBar label="Pacing" score={communication.pause_score} color="cyan" detail={`${communication.wpm} wpm`} />
            <ScoreBar label="Filler words" score={Math.round(Math.max(0, 100 - communication.filler_rate * 500))} color="cyan" detail={`${(communication.filler_rate * 100).toFixed(1)}%`} />
            <ScoreBar label="Conciseness" score={Math.round(Math.max(0, 100 - communication.rambling_index * 100))} color="cyan" />
          </div>
          <div className="pt-2 border-t border-[rgba(255,255,255,0.10)]">
            <CommunicationDetail metrics={data.speechMetrics} />
          </div>
          <div className="pt-2 border-t border-[rgba(255,255,255,0.10)] space-y-1">
            {[
              { label: 'Avg. WPM', value: s(communication.wpm), ideal: '120-160' },
              { label: 'Filler rate', value: `${(Number(communication.filler_rate) * 100).toFixed(1)}%`, ideal: '<5%' },
              { label: 'Rambling index', value: Number(communication.rambling_index).toFixed(2), ideal: '<0.30' },
            ].map(({ label, value, ideal }) => (
              <div key={label} className="flex justify-between text-xs">
                <span className="text-[#4b5563]">{label}</span>
                <span className="text-[#d1d5db] tabular-nums">
                  {value} <span className="text-[#374151]">({ideal})</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Engagement (or legacy Delivery) */}
        {engagementSignals ? (
          <div className="surface-card-bordered p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-subheading text-[#f0f2f5]">Engagement</span>
              <span className="text-heading font-bold text-violet-400" role="meter" aria-valuenow={Number(engagementSignals.score) || 0} aria-valuemin={0} aria-valuemax={100} aria-label={`Engagement score: ${Number(engagementSignals.score) || 0} out of 100`}>
                {Number(engagementSignals.score) || 0}
              </span>
            </div>
            <div className="space-y-3">
              <ScoreBar label="Engagement depth" score={engagementSignals.engagement_score} color="indigo" />
              <ScoreBar label="Composure under pressure" score={engagementSignals.composure_under_pressure} color="indigo" />
              <ScoreBar label="Energy consistency" score={Math.round(engagementSignals.energy_consistency * 100)} color="indigo" />
            </div>
            <div className="pt-2 border-t border-[rgba(255,255,255,0.10)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-caption text-[#4b5563]">Confidence trend</span>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.color || 'text-[#9ca3af] bg-[rgba(255,255,255,0.05)] border-[rgba(255,255,255,0.10)]'}`}>
                  {CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.text || s(engagementSignals.confidence_trend)}
                </span>
              </div>
              <p className="text-caption text-[#374151]">
                Engagement scores are AI-estimated from speech patterns, answer depth, and consistency.
              </p>
            </div>
          </div>
        ) : deliverySignals ? (
          <div className="surface-card-bordered p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-subheading text-[#f0f2f5]">Delivery</span>
              <span className="text-heading font-bold text-violet-400" role="meter" aria-valuenow={Number(deliverySignals.score) || 0} aria-valuemin={0} aria-valuemax={100} aria-label={`Delivery score: ${Number(deliverySignals.score) || 0} out of 100`}>
                {Number(deliverySignals.score) || 0}
              </span>
            </div>
            <div className="space-y-3">
              <ScoreBar label="Gaze / eye contact" score={Math.round(deliverySignals.gaze_ratio * 100)} color="indigo" />
              <ScoreBar label="Head stability" score={Math.round(deliverySignals.head_stability * 100)} color="indigo" />
              <ScoreBar label="Affect variability" score={Math.round(deliverySignals.affect_variability * 100)} color="indigo" />
            </div>
            <div className="pt-2 border-t border-[rgba(255,255,255,0.10)]">
              <div className={`text-xs px-2 py-1 rounded-full border w-fit ${PROBABILITY_COLORS[deliverySignals.confidence_band]}`}>
                Confidence band: {deliverySignals.confidence_band}
              </div>
              <p className="text-caption text-[#374151] mt-2">
                Delivery scores are AI-estimated. Updated engagement analysis available in new sessions.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {/* JD Alignment Section */}
      {feedback.jd_match_score !== undefined && (
        <section className="surface-card-bordered p-4 sm:p-5 space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-subheading text-[#f0f2f5]">JD Alignment</span>
            <span className="text-heading font-bold text-cyan-400">{feedback.jd_match_score}</span>
          </div>
          <ScoreBar label="Overall JD Match" score={feedback.jd_match_score} color="cyan" />
          {feedback.jd_requirement_breakdown && feedback.jd_requirement_breakdown.length > 0 && (
            <div className="pt-2 border-t border-[rgba(255,255,255,0.10)] space-y-2">
              <p className="step-label">Requirement Breakdown</p>
              {feedback.jd_requirement_breakdown.map((req, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`shrink-0 mt-0.5 ${req.matched ? 'text-emerald-400' : 'text-red-400'}`}>
                    {req.matched ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </span>
                  <div className="flex-1">
                    <p className="text-body text-[#d1d5db]">{s(req.requirement)}</p>
                    {req.evidence && <p className="text-caption text-[#4b5563] mt-0.5">{s(req.evidence)}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Red flags */}
      {Array.isArray(red_flags) && red_flags.length > 0 && (
        <section className="bg-red-950/30 border border-red-500/20 rounded-[var(--radius-md)] p-5 animate-fade-in">
          <h3 className="text-subheading text-red-400 mb-3">Red flags detected</h3>
          <ul className="space-y-2">
            {red_flags.map((flag, idx) => (
              <li key={idx} className="flex items-start gap-2 text-body text-red-300">
                <span className="shrink-0">·</span> {s(flag)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Top 3 improvements */}
      <section className="surface-card-bordered p-5 animate-fade-in">
        <h3 className="text-subheading text-[#f0f2f5] mb-4">Top improvements for next attempt</h3>
        <div className="space-y-3">
          {Array.isArray(top_3_improvements) && top_3_improvements.map((tip, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-brand-500/20 border border-brand-500/30 text-brand-500 text-xs flex items-center justify-center font-bold">
                {i + 1}
              </span>
              <p className="text-body text-[#d1d5db] leading-relaxed">{s(tip)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Peer Comparison */}
      {sessionId && sessionId !== 'local' && data.config && feedback && (
        <PeerComparison data={peerData} loading={peerLoading} userFeedback={feedback} />
      )}
    </div>
  )
}
