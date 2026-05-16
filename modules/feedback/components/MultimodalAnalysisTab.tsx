'use client'

import { useMemo, useState, type RefObject } from 'react'
import TranscriptTab from '@feedback/components/TranscriptTab'
import MultimodalReplayShell from '@feedback/components/multimodal/MultimodalReplayShell'
import QuestionChapterRow from '@feedback/components/multimodal/QuestionChapterRow'
import Scrubber from '@feedback/components/multimodal/Scrubber'
import SignalTrack from '@feedback/components/multimodal/SignalTrack'
import VideoMetricChips from '@feedback/components/multimodal/VideoMetricChips'
import MomentsTabBody from '@feedback/components/multimodal/MomentsTabBody'
import TranscriptTabBody from '@feedback/components/multimodal/TranscriptTabBody'
import CoachingTipsTabBody from '@feedback/components/multimodal/CoachingTipsTabBody'
import { FONT_MONO } from '@feedback/components/multimodal/tokens'
import { findActiveQuestionIndex } from '@feedback/components/multimodal/activeQuestion'
import type { MultimodalAnalysisData, TimelineEvent } from '@shared/types/multimodal'
import type { FeedbackData, StoredInterviewData } from '@shared/types'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

// Kept for prop compatibility with page.tsx — not used by the new layout
// (the playhead-driven active-warning was a Round-3 concern).
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
  drillRecommendations?: FeedbackData['drill_recommendations']
  onQuestionClick?: (questionIndex: number) => void
  maxQuestionIndex?: number
  onPracticeClick?: (drillIndex: number) => void
}

type RightPaneTab = 'moments' | 'transcript' | 'tips'

/**
 * Round 4: full visual + IA redesign of the Multimodal tab.
 *
 * Two-column layout: video panel (left) + tabs panel (right).
 *  - Video panel: bare <video> + custom controls (Q chip, asked chip,
 *    fullscreen, play overlay, live caption) + Q chapter row + scrubber +
 *    session-wide signal track + 5 metric chips.
 *  - Tabs panel: 3 tabs — Key moments | Transcript | Coaching tips.
 *
 * Single source of truth: `analysisVideoTime` from page.tsx state. Drives
 * the live caption, the active Q chip, the scrubber position, the active
 * highlight band, the active line in TranscriptTabBody, and the playhead
 * bar on the SignalTrack. The Moments tab uses its own local
 * `selectedMomentId` state — clicking a moment seeks the video (which
 * indirectly updates everything time-derived) and expands the card; auto-
 * expand on playback was rejected to avoid visual churn in the list.
 *
 * `replayFullscreen` mode keeps the same internal layout but fills the
 * viewport (strict 1440×900 fit happens here per the user's "no scroll"
 * constraint).
 */
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
  // activeWarning intentionally unused — Round 4 doesn't surface playhead
  // warnings on the video the same way Round 3 did.
  activeWarning: _activeWarning,
  analysisVideoTime,
  setAnalysisVideoTime,
  onSeekRef,
  replayFullscreen,
  setReplayFullscreen,
  onRetry,
  activeTranscriptIndex,
  activeEntryRef,
  seekToAudio,
  drillRecommendations,
  onQuestionClick,
  maxQuestionIndex,
  onPracticeClick,
}: MultimodalAnalysisTabProps) {
  const [tab, setTab] = useState<RightPaneTab>('moments')
  const [playing, setPlaying] = useState(false)
  // The new shell exposes seek via the same ref-callback pattern as VideoPlayer.
  // We track it locally so the scrubber + chapter row + moment clicks can call it.
  const [seek, setSeek] = useState<((sec: number) => void) | null>(null)
  const [videoDuration, setVideoDuration] = useState<number>(0)

  // Total duration prefers the video's actual duration; falls back to the
  // last timeline event's endSec; final fallback 300s so divisions don't blow up.
  const totalDurationSec = useMemo(() => {
    if (videoDuration > 0) return videoDuration
    if (analysis?.timeline && analysis.timeline.length > 0) {
      return Math.ceil(analysis.timeline[analysis.timeline.length - 1].endSec)
    }
    return 300
  }, [videoDuration, analysis?.timeline])

  // Active question — extracted to `findActiveQuestionIndex` for direct unit
  // testing. Returns -1 (no active question) when playback is before the
  // first marker (intro/silence) — Codex P2 on PR #370. Downstream
  // renderers (activeQuestion, activeQuestionRange, askedQuestionText,
  // activeQuestionLabel, QuestionChapterRow.activeIndex) all guard
  // against `< 0` already.
  const activeQuestionIndex = useMemo(
    () => findActiveQuestionIndex(questionMarkers, analysisVideoTime),
    [questionMarkers, analysisVideoTime]
  )

  const activeQuestion = activeQuestionIndex >= 0 ? questionMarkers[activeQuestionIndex] : null
  const nextQuestion = activeQuestionIndex >= 0 ? questionMarkers[activeQuestionIndex + 1] : null
  const activeQuestionRange = activeQuestion
    ? {
        startSec: activeQuestion.offsetSeconds,
        endSec: nextQuestion ? nextQuestion.offsetSeconds : totalDurationSec,
      }
    : null

  // The interviewer text of the active question, looked up from the
  // transcript via questionIndex. Used in the asked-question chip on the video.
  const askedQuestionText = useMemo(() => {
    if (activeQuestionIndex < 0) return undefined
    const entry = data.transcript.find(
      (e) => e.speaker === 'interviewer' && e.questionIndex === activeQuestionIndex
    )
    return entry?.text
  }, [data.transcript, activeQuestionIndex])

  // ── Loading ────────────────────────────────────────────────────────────────
  if (analysisLoading) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-8 text-center space-y-4 animate-fade-in">
        <div className="w-8 h-8 rounded-full border-2 border-blue-600 border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-stone-600">{analysisProgress || 'Loading analysis...'}</p>
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (analysisError) {
    return (
      <div className="bg-white border border-red-500/30 rounded-xl p-6 text-center space-y-3 animate-fade-in">
        <p className="text-sm text-red-600">{analysisError}</p>
        {hasAnalysisSource && (
          <button
            type="button"
            onClick={onRetry}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium transition"
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
      <div className="bg-white border border-stone-200 rounded-xl p-8 text-center animate-fade-in">
        <p className="text-sm text-stone-600">
          {hasAnalysisSource
            ? 'Multimodal analysis is being prepared. Refresh in a moment.'
            : 'Multimodal analysis is not available for this session.'}
        </p>
      </div>
    )
  }

  // ── Tab bar (right pane) ───────────────────────────────────────────────────
  const tabs: Array<{ id: RightPaneTab; label: string; count: number | null }> = [
    { id: 'moments', label: 'Key moments', count: keyMoments.length },
    { id: 'transcript', label: 'Transcript', count: null },
    { id: 'tips', label: 'Coaching tips', count: analysis.fusionSummary?.coachingTips.length ?? 0 },
  ]

  const tabsPanel = (
    <div className="bg-white border border-stone-200 rounded-xl flex flex-col min-h-0 flex-1">
      <div
        className="flex border-b border-stone-200 px-2 flex-shrink-0"
        role="tablist"
      >
        {tabs.map((t) => {
          const isActive = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-2.5 cursor-pointer text-[12px] font-medium inline-flex items-center gap-1 -mb-px border-b-2 whitespace-nowrap transition-colors ${
                isActive
                  ? 'text-stone-900 border-stone-900'
                  : 'text-stone-600 border-transparent hover:text-stone-900'
              }`}
            >
              {t.label}
              {t.count !== null && (
                <span
                  className="text-[10px] text-stone-400 bg-stone-100 px-1.5 py-px rounded"
                  style={{ fontFamily: FONT_MONO }}
                >
                  {t.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3.5">
        {tab === 'moments' && (
          <MomentsTabBody
            moments={keyMoments}
            onSeek={(sec) => seek?.(sec)}
            prosodySegments={analysis.prosodySegments}
            facialSegments={analysis.facialSegments}
            whisperSegments={analysis.whisperTranscript}
            questions={questionMarkers}
          />
        )}
        {tab === 'transcript' && (
          <TranscriptTabBody
            transcript={data.transcript}
            currentTimeSec={analysisVideoTime}
            sessionStartedAt={sessionStartedAt}
            onSeek={(sec) => seek?.(sec)}
          />
        )}
        {tab === 'tips' && (
          <CoachingTipsTabBody
            fusionSummary={analysis.fusionSummary}
            drillRecommendations={drillRecommendations}
            onQuestionClick={onQuestionClick}
            maxQuestionIndex={maxQuestionIndex}
            onPracticeClick={onPracticeClick}
          />
        )}
      </div>
    </div>
  )

  // ── Video-less fallback ────────────────────────────────────────────────────
  if (!videoSrc) {
    return (
      <div className="space-y-4 animate-fade-in">
        <section className="bg-white border border-stone-200 rounded-xl p-6 sm:p-8 text-center space-y-3">
          <div className="mx-auto w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <p className="text-lg font-medium text-stone-900">Video wasn&apos;t recorded for this session</p>
          <p className="text-sm text-stone-600 max-w-md mx-auto">
            Multimodal replay is unavailable, but you can still review the transcript and coaching tips below.
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

        {analysis.fusionSummary && analysis.fusionSummary.coachingTips.length > 0 && (
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <CoachingTipsTabBody
              fusionSummary={analysis.fusionSummary}
              drillRecommendations={drillRecommendations}
              onQuestionClick={onQuestionClick}
              maxQuestionIndex={maxQuestionIndex}
              onPracticeClick={onPracticeClick}
            />
          </div>
        )}
      </div>
    )
  }

  // ── Full layout ────────────────────────────────────────────────────────────
  return (
    <div
      className={
        replayFullscreen
          ? 'fixed inset-0 z-50 bg-stone-50 overflow-hidden p-3.5'
          : 'animate-fade-in'
      }
      style={replayFullscreen ? { height: '100vh' } : undefined}
    >
      <div
        className="flex gap-3 h-full min-h-0"
        style={replayFullscreen ? undefined : { height: 'min(808px, calc(100vh - 280px))' }}
      >
        {/* LEFT — video panel */}
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 flex flex-col gap-3 min-h-0 flex-[1.4] min-w-0">
          <MultimodalReplayShell
            src={videoSrc}
            currentTimeSec={analysisVideoTime}
            onTimeUpdate={setAnalysisVideoTime}
            onSeekRef={(fn) => {
              setSeek(() => fn)
              onSeekRef(fn)
            }}
            whisperSegments={analysis.whisperTranscript}
            askedQuestion={askedQuestionText}
            activeQuestionLabel={activeQuestion?.label}
            totalDurationSec={totalDurationSec}
            playing={playing}
            setPlaying={setPlaying}
            replayFullscreen={replayFullscreen}
            setReplayFullscreen={setReplayFullscreen}
            onDurationKnown={setVideoDuration}
          />

          <QuestionChapterRow
            questions={questionMarkers}
            totalDurationSec={totalDurationSec}
            activeIndex={activeQuestionIndex}
            onJumpToQuestion={(sec) => seek?.(sec)}
          />

          <Scrubber
            currentTimeSec={analysisVideoTime}
            totalDurationSec={totalDurationSec}
            onSeek={(sec) => seek?.(sec)}
            playing={playing}
            setPlaying={setPlaying}
            questions={questionMarkers}
            activeQuestion={activeQuestionRange}
            keyMoments={keyMoments}
          />

          <SignalTrack
            timeline={analysis.timeline || []}
            keyMoments={keyMoments}
            totalDurationSec={totalDurationSec}
            currentTimeSec={analysisVideoTime}
            questions={questionMarkers}
          />

          <VideoMetricChips
            fusionSummary={analysis.fusionSummary}
            speechMetrics={data.speechMetrics}
          />
        </div>

        {/* RIGHT — tabs panel */}
        <div className="flex flex-col min-h-0 flex-1 min-w-[360px]">
          {tabsPanel}
        </div>
      </div>
    </div>
  )
}
