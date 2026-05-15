'use client'

import { useEffect, useState, type RefObject } from 'react'
import VideoPlayer from '@interview/components/replay/VideoPlayer'
import ReplayTranscript from '@interview/components/replay/ReplayTranscript'
import TimelineTrack from '@interview/components/replay/TimelineTrack'
import MomentCards from '@interview/components/replay/MomentCards'
import SignalCharts from '@interview/components/replay/SignalCharts'
import CoachingPanel from '@interview/components/replay/CoachingPanel'
import TranscriptTab from '@interview/components/feedback/TranscriptTab'
import MultimodalScoreChips from '@interview/components/feedback/MultimodalScoreChips'
import type { MultimodalAnalysisData, TimelineEvent } from '@shared/types/multimodal'
import type { StoredInterviewData } from '@shared/types'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface ActiveWarning {
  label: string
  type: 'attention' | 'neutral'
}

interface MultimodalAnalysisTabProps {
  data: StoredInterviewData
  analysis: MultimodalAnalysisData | null
  analysisLoading: boolean
  analysisError: string | null
  analysisProgress: string
  hasAnalysisSource: boolean
  videoSrc: string | null
  recordingUrl: string | null
  sessionStartedAt: number | null
  questionMarkers: QuestionMarker[]
  keyMoments: TimelineEvent[]
  activeWarning: ActiveWarning | null
  analysisVideoTime: number
  setAnalysisVideoTime: (sec: number) => void
  /** Mirrors the existing page-level analysisSeekRef pattern. */
  onSeekRef: (fn: ((seconds: number) => void) | null) => void
  replayFullscreen: boolean
  setReplayFullscreen: (open: boolean) => void
  onRetry: () => void
  /** Used by the video-less fallback to drive transcript active-line highlighting. */
  activeTranscriptIndex: number
  activeEntryRef: RefObject<HTMLDivElement | null>
  /** Used by the video-less fallback's TranscriptTab to seek the audio player. */
  seekToAudio: ((sec: number) => void) | null
}

export default function MultimodalAnalysisTab({
  data,
  analysis,
  analysisLoading,
  analysisError,
  analysisProgress,
  hasAnalysisSource,
  videoSrc,
  recordingUrl,
  sessionStartedAt,
  questionMarkers,
  keyMoments,
  activeWarning,
  analysisVideoTime,
  setAnalysisVideoTime,
  onSeekRef,
  replayFullscreen,
  setReplayFullscreen,
  onRetry,
  activeTranscriptIndex,
  activeEntryRef,
  seekToAudio,
}: MultimodalAnalysisTabProps) {
  const [rightPaneTab, setRightPaneTab] = useState<'transcript' | 'moments' | 'tips'>('transcript')
  const [seek, setSeek] = useState<((sec: number) => void) | null>(null)
  // Local mirror of seek so the right-pane click handlers can call it without re-renders.
  useEffect(() => {
    onSeekRef(seek)
    return () => onSeekRef(null)
  }, [seek, onSeekRef])

  // ── Loading ────────────────────────────────────────────────────────────────
  if (analysisLoading) {
    return (
      <div className="surface-card-bordered p-8 text-center space-y-4 animate-fade-in">
        <div className="w-8 h-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin mx-auto" />
        <p className="text-body text-[#536471]">{analysisProgress || 'Loading analysis...'}</p>
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (analysisError) {
    return (
      <div className="surface-card-bordered border-red-500/30 p-6 text-center space-y-3 animate-fade-in">
        <p className="text-body text-red-600">{analysisError}</p>
        {hasAnalysisSource && (
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] text-sm font-medium transition"
          >
            Retry Analysis
          </button>
        )}
      </div>
    )
  }

  // ── Pending (no analysis yet, but source exists) ────────────────────────────
  if (!analysis || analysis.status !== 'completed') {
    return (
      <div className="surface-card-bordered p-8 text-center animate-fade-in">
        <p className="text-body text-[#71767b]">
          {hasAnalysisSource
            ? 'Multimodal analysis is being prepared. Refresh in a moment.'
            : 'Multimodal analysis is not available for this session.'}
        </p>
      </div>
    )
  }

  // ── Common: aggregate chips (always render with analysis data) ─────────────
  const chips = (
    <MultimodalScoreChips
      fusionSummary={analysis.fusionSummary}
      speechMetrics={data.speechMetrics}
    />
  )

  // ── Video-less fallback ────────────────────────────────────────────────────
  if (!videoSrc) {
    return (
      <div className="space-y-6 animate-fade-in">
        {chips}

        <section className="surface-card-bordered p-6 sm:p-8 text-center space-y-3">
          <div className="mx-auto w-12 h-12 rounded-full bg-[#f1f5f9] flex items-center justify-center">
            <svg className="w-6 h-6 text-[#71767b]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <p className="text-subheading text-[#0f1419]">Video wasn&apos;t recorded for this session</p>
          <p className="text-body text-[#71767b] max-w-md mx-auto">
            Multimodal replay is unavailable, but you can still review the transcript and any signal data captured during the interview.
          </p>
        </section>

        <TranscriptTab
          transcript={data.transcript}
          activeTranscriptIndex={activeTranscriptIndex}
          activeEntryRef={activeEntryRef}
          recordingUrl={recordingUrl}
          sessionStartedAt={sessionStartedAt}
          seekTo={seekToAudio}
        />

        {((analysis.prosodySegments?.length ?? 0) > 0 || (analysis.facialSegments?.length ?? 0) > 0) && (
          <section className="surface-card-bordered p-4 sm:p-6">
            <h3 className="text-subheading text-[#0f1419] mb-4">Per-Question Signals</h3>
            <SignalCharts
              prosodySegments={analysis.prosodySegments || []}
              facialSegments={analysis.facialSegments || []}
              currentTimeSec={0}
            />
          </section>
        )}

        {analysis.fusionSummary && analysis.fusionSummary.coachingTips.length > 0 && (
          <CoachingPanel
            fusionSummary={analysis.fusionSummary}
            timeline={analysis.timeline || []}
            onSeek={() => {}}
            hideMoments
          />
        )}
      </div>
    )
  }

  // ── Full layout: aggregate chips → sticky-spine + scrolling stream → signal charts ──
  return (
    <div
      className={
        replayFullscreen
          ? 'fixed inset-0 z-50 bg-white overflow-y-auto p-6 space-y-6'
          : 'space-y-6 animate-fade-in'
      }
    >
      {replayFullscreen && (
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <h2 className="text-heading text-[#0f1419]">Interview Replay</h2>
          <button
            onClick={() => setReplayFullscreen(false)}
            className="p-2 rounded-lg hover:bg-[#f8fafc] border border-[#e1e8ed] text-[#536471] hover:text-[#0f1419] transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className={replayFullscreen ? 'max-w-7xl mx-auto space-y-6' : 'space-y-6'}>
        {chips}

        {/* Two-column body — sticky video spine + scrolling insight stream */}
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-5 items-start">
          {/* LEFT — sticky video + timeline */}
          <div className="lg:sticky lg:top-[180px] space-y-3">
            <div className="relative">
              <VideoPlayer
                src={videoSrc}
                questionMarkers={questionMarkers}
                onTimeUpdate={setAnalysisVideoTime}
                onSeek={(fn) => setSeek(() => fn)}
                activeWarning={activeWarning}
              />
              {!replayFullscreen && (
                <button
                  onClick={() => setReplayFullscreen(true)}
                  className="absolute top-3 right-3 z-10 p-2 rounded-lg bg-white/80 hover:bg-white border border-[#e1e8ed] text-[#536471] hover:text-[#0f1419] transition-colors"
                  title="Expand replay"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                  </svg>
                </button>
              )}
            </div>
            {analysis.timeline && analysis.timeline.length > 0 && (
              <TimelineTrack
                events={analysis.timeline}
                totalDurationSec={
                  analysis.timeline.length > 0
                    ? Math.ceil(analysis.timeline[analysis.timeline.length - 1].endSec)
                    : 300
                }
                currentTimeSec={analysisVideoTime}
                onSeek={(sec) => seek?.(sec)}
              />
            )}
          </div>

          {/* RIGHT — scrolling insight stream */}
          <div className="space-y-3 min-w-0">
            <div className="flex gap-1 bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-1" role="tablist">
              {(
                [
                  { key: 'transcript', label: 'Transcript' },
                  { key: 'moments', label: `Key Moments${keyMoments.length > 0 ? ` (${keyMoments.length})` : ''}` },
                  { key: 'tips', label: `Tips${(analysis.fusionSummary?.coachingTips.length ?? 0) > 0 ? ` (${analysis.fusionSummary?.coachingTips.length})` : ''}` },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={rightPaneTab === t.key}
                  onClick={() => setRightPaneTab(t.key)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    rightPaneTab === t.key
                      ? 'bg-white text-[#0f1419] shadow-sm'
                      : 'text-[#71767b] hover:text-[#0f1419]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {rightPaneTab === 'transcript' && analysis.whisperTranscript && analysis.whisperTranscript.length > 0 && (
              <ReplayTranscript
                whisperSegments={analysis.whisperTranscript}
                transcript={data.transcript}
                currentTimeSec={analysisVideoTime}
                onWordClick={(sec) => seek?.(sec)}
                className={replayFullscreen ? 'max-h-[60vh]' : 'max-h-[420px]'}
              />
            )}
            {rightPaneTab === 'transcript' && (!analysis.whisperTranscript || analysis.whisperTranscript.length === 0) && (
              <p className="text-caption text-[#71767b] p-4">Word-level transcript not available.</p>
            )}

            {rightPaneTab === 'moments' && (
              keyMoments.length > 0 ? (
                <MomentCards moments={keyMoments} onSeek={(sec) => seek?.(sec)} />
              ) : (
                <p className="text-caption text-[#71767b] p-4">No key moments captured.</p>
              )
            )}

            {rightPaneTab === 'tips' && (
              analysis.fusionSummary && analysis.fusionSummary.coachingTips.length > 0 ? (
                <CoachingPanel
                  fusionSummary={analysis.fusionSummary}
                  timeline={analysis.timeline || []}
                  onSeek={(sec) => seek?.(sec)}
                  hideMoments
                />
              ) : (
                <p className="text-caption text-[#71767b] p-4">No coaching tips generated.</p>
              )
            )}
          </div>
        </div>

        {/* Per-question signal charts — full-width, open by default */}
        {((analysis.prosodySegments?.length ?? 0) > 0 || (analysis.facialSegments?.length ?? 0) > 0) && (
          <section className="surface-card-bordered p-4 sm:p-6">
            <h3 className="text-subheading text-[#0f1419] mb-4">Per-Question Signals</h3>
            <SignalCharts
              prosodySegments={analysis.prosodySegments || []}
              facialSegments={analysis.facialSegments || []}
              currentTimeSec={analysisVideoTime}
            />
          </section>
        )}
      </div>
    </div>
  )
}
