'use client'

import { useMemo } from 'react'
import { ScoreBar } from '@shared/ui/ScoreBar'
import PeerComparison, { type PeerData } from '@interview/components/feedback/PeerComparison'
import ScoreProgressionChart from '@interview/components/feedback/ScoreProgressionChart'
import SpeechMetricsChart from '@interview/components/feedback/SpeechMetricsChart'
import DimensionRadar from '@interview/components/feedback/DimensionRadar'
import ConfidenceTrend from '@interview/components/feedback/ConfidenceTrend'
import QuestionHeatmap from '@interview/components/feedback/QuestionHeatmap'
import RedFlagCards from '@interview/components/feedback/RedFlagCards'
import ScoreTrendChart from '@interview/components/feedback/ScoreTrendChart'
import ComparisonCard from '@learn/components/feedback/ComparisonCard'
import type { FeedbackData, StoredInterviewData } from '@shared/types'
import { PROBABILITY_COLORS, CONFIDENCE_TREND_LABELS } from '@interview/config/feedbackConfig'

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
  currentScore: number
  currentScores?: { relevance: number; structure: number; specificity: number; ownership: number }
  domain?: string
  /** Set when this session is a retake — drives "vs first attempt" comparison. */
  parentSessionId?: string
}

export default function OverviewTab({ data, feedback, sessionId, peerData, peerLoading, currentScore, currentScores, domain, parentSessionId }: OverviewTabProps) {
  const { dimensions, red_flags, top_3_improvements } = feedback
  const { answer_quality, communication } = dimensions
  const engagementSignals = dimensions.engagement_signals || null

  // Compute evaluation data for charts
  const evalData = useMemo(() =>
    (data.evaluations || []).map((e) => {
      const ev = e as unknown as Record<string, unknown>
      return {
        question: (ev.question as string) || '',
        answer: (ev.answer as string) || '',
        relevance: Number(ev.relevance) || 0,
        structure: Number(ev.structure) || 0,
        specificity: Number(ev.specificity) || 0,
        ownership: Number(ev.ownership) || 0,
        jdAlignment: ev.jdAlignment as number | undefined,
        flags: (ev.flags as string[]) || [],
      }
    })
  , [data.evaluations])

  const speechData = useMemo(() =>
    (data.speechMetrics || []).map((m) => {
      const sm = m as unknown as Record<string, unknown>
      return {
        wpm: Number(sm.wpm) || 0,
        fillerRate: Number(sm.fillerRate) || 0,
        totalWords: Number(sm.totalWords) || 0,
      }
    })
  , [data.speechMetrics])

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Score Trend + Comparison */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Score Trend</h3>
          <ScoreTrendChart currentScore={currentScore} sessionId={sessionId} />
        </section>
        {currentScores && (
          <ComparisonCard
            currentScores={currentScores}
            overallScore={currentScore}
            domain={domain}
            parentSessionId={parentSessionId}
          />
        )}
      </div>

      {/* Row 1: Dimension Radar + Communication + Engagement */}
      <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Dimension Radar */}
        <div className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Scoring Dimensions</h3>
          {evalData.length > 0 ? (
            <DimensionRadar evaluations={evalData} />
          ) : (
            <p className="text-caption text-[#71767b]">No evaluation data</p>
          )}
        </div>

        {/* Communication Summary */}
        <div className="surface-card-bordered p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-subheading text-[#0f1419]">Communication</span>
            <span className="text-heading font-bold text-cyan-500">{Number(communication.score) || 0}</span>
          </div>
          <div className="space-y-2">
            <ScoreBar label="Pacing" score={communication.pause_score} color="cyan" detail={`${communication.wpm} wpm`} />
            <ScoreBar label="Filler words" score={Math.round(Math.max(0, 100 - communication.filler_rate * 200))} color="cyan" detail={`${(communication.filler_rate * 100).toFixed(1)}%`} />
            <ScoreBar label="Conciseness" score={Math.round(Math.max(0, 100 - communication.rambling_index * 100))} color="cyan" />
          </div>
        </div>

        {/* Confidence Trend */}
        <div className="surface-card-bordered p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-subheading text-[#0f1419]">Confidence Trend</span>
            {engagementSignals && (
              <span className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.color || 'text-[#71767b] bg-[#f8fafc] border-[#e1e8ed]'}`}>
                {CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.text || s(engagementSignals.confidence_trend)}
              </span>
            )}
          </div>
          {speechData.length > 0 ? (
            <ConfidenceTrend speechMetrics={speechData} />
          ) : (
            <p className="text-caption text-[#71767b]">No speech data</p>
          )}
        </div>
      </section>

      {/* Row 2: Score Progression */}
      {evalData.length > 1 && (
        <section className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Score Progression</h3>
          <ScoreProgressionChart evaluations={evalData} />
        </section>
      )}

      {/* Row 3: Speech Metrics */}
      {speechData.length > 1 && (
        <section className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Speech Metrics</h3>
          <SpeechMetricsChart speechMetrics={speechData} />
        </section>
      )}

      {/* Row 4: Question Heatmap */}
      {evalData.length > 0 && (
        <section className="surface-card-bordered p-4 sm:p-5">
          <h3 className="text-subheading text-[#0f1419] mb-3">Question Breakdown</h3>
          <QuestionHeatmap evaluations={evalData} transcript={data.transcript} />
        </section>
      )}

      {/* JD Alignment */}
      {feedback.jd_match_score !== undefined && (
        <section className="surface-card-bordered p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-subheading text-[#0f1419]">JD Alignment</span>
            <span className="text-heading font-bold text-cyan-500">{feedback.jd_match_score}</span>
          </div>
          <ScoreBar label="Overall JD Match" score={feedback.jd_match_score} color="cyan" />
          {feedback.jd_requirement_breakdown && feedback.jd_requirement_breakdown.length > 0 && (
            <div className="pt-2 border-t border-[#e1e8ed] space-y-2">
              {feedback.jd_requirement_breakdown.map((req, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`shrink-0 mt-0.5 ${req.matched ? 'text-green-600' : 'text-red-500'}`}>
                    {req.matched ? '✓' : '✗'}
                  </span>
                  <div>
                    <p className="text-body text-[#0f1419]">{s(req.requirement)}</p>
                    {req.evidence && <p className="text-caption text-[#8b98a5] mt-0.5">{s(req.evidence)}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Red Flags */}
      <RedFlagCards redFlags={Array.isArray(red_flags) ? red_flags.map(f => s(f)) : []} />

      {/* Top 3 Improvements */}
      <section className="surface-card-bordered p-5">
        <h3 className="text-subheading text-[#0f1419] mb-4">Top Improvements</h3>
        <div className="space-y-3">
          {Array.isArray(top_3_improvements) && top_3_improvements.map((tip, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-brand-500/20 border border-brand-500/30 text-brand-500 text-xs flex items-center justify-center font-bold">
                {i + 1}
              </span>
              <p className="text-body text-[#0f1419] leading-relaxed">{s(tip)}</p>
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
