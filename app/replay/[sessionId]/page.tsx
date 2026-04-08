'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Video, BarChart3, MessageSquare, Lightbulb, Eye, Mic, Monitor } from 'lucide-react'
import VideoPlayer from '@interview/components/replay/VideoPlayer'
import TimelineTrack from '@interview/components/replay/TimelineTrack'
import SignalCharts from '@interview/components/replay/SignalCharts'
import ReplayTranscript from '@interview/components/replay/ReplayTranscript'
import CoachingPanel from '@interview/components/replay/CoachingPanel'
import AnalysisTrigger from '@interview/components/replay/AnalysisTrigger'
import type { MultimodalAnalysisData } from '@shared/types/multimodal'
import type { TranscriptEntry, InterviewConfig } from '@shared/types'

type Tab = 'transcript' | 'signals' | 'coaching'

interface SessionData {
  config: InterviewConfig
  transcript: TranscriptEntry[]
  recordingUrl?: string
  hasRecording?: boolean
  hasScreenRecording?: boolean
}

export default function ReplayPage() {
  const params = useParams()
  const router = useRouter()
  const { data: authSession } = useSession()
  const sessionId = params.sessionId as string

  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [analysis, setAnalysis] = useState<MultimodalAnalysisData | null>(null)
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [screenVideoSrc, setScreenVideoSrc] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const seekFnRef = useRef<((seconds: number) => void) | null>(null)

  // Load session data + analysis
  useEffect(() => {
    if (!authSession?.user) return

    async function loadData() {
      try {
        // Fetch session
        const sessionRes = await fetch(`/api/interviews/${sessionId}`)
        if (!sessionRes.ok) throw new Error('Failed to load session')
        const sessionJson = await sessionRes.json()

        setSessionData({
          config: sessionJson.config,
          transcript: sessionJson.transcript || [],
          recordingUrl: sessionJson.recordingUrl,
          hasRecording: sessionJson.hasRecording,
          hasScreenRecording: sessionJson.hasScreenRecording,
        })

        // Get presigned URL for video (R2), or fall back to legacy recordingUrl
        if (sessionJson.hasRecording) {
          const presignRes = await fetch(`/api/recordings/presign?sessionId=${sessionId}`)
          if (presignRes.ok) {
            const presignJson = await presignRes.json()
            setVideoSrc(presignJson.url)
          }
        } else if (sessionJson.recordingUrl) {
          setVideoSrc(sessionJson.recordingUrl)
        }

        // Screen recording (coding & system-design only)
        if (sessionJson.hasScreenRecording) {
          const screenPresignRes = await fetch(
            `/api/recordings/presign?sessionId=${sessionId}&kind=screen`
          )
          if (screenPresignRes.ok) {
            const screenPresignJson = await screenPresignRes.json()
            setScreenVideoSrc(screenPresignJson.url)
          }
        }

        // Fetch analysis (may not exist yet)
        const analysisRes = await fetch(`/api/analysis/${sessionId}`)
        if (analysisRes.ok) {
          const analysisJson = await analysisRes.json()
          setAnalysis(analysisJson)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load replay data')
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [sessionId, authSession])

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time)
  }, [])

  const handleSeek = useCallback((seconds: number) => {
    seekFnRef.current?.(seconds)
  }, [])

  const handleAnalysisComplete = useCallback(() => {
    // Reload analysis data
    fetch(`/api/analysis/${sessionId}`)
      .then((r) => r.json())
      .then((data) => setAnalysis(data))
      .catch(() => {})
  }, [sessionId])

  // Build question markers from transcript
  const questionMarkers = (sessionData?.transcript || [])
    .filter((t) => t.speaker === 'interviewer')
    .map((t, i) => ({ label: `Q${i + 1}`, offsetSeconds: t.timestamp }))

  // Compute total duration from analysis or estimate from transcript
  const totalDurationSec = analysis?.whisperTranscript?.length
    ? analysis.whisperTranscript[analysis.whisperTranscript.length - 1].end
    : sessionData?.transcript?.length
    ? Math.max(...sessionData.transcript.map((t) => t.timestamp)) + 60
    : 600

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-pulse text-gray-400">Loading replay...</div>
      </main>
    )
  }

  if (error || !sessionData) {
    return (
      <main className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4">
        <p className="text-red-400">{error || 'Session not found'}</p>
        <button
          onClick={() => router.push('/history')}
          className="text-sm text-blue-400 hover:underline"
        >
          Back to History
        </button>
      </main>
    )
  }

  const hasRecording = !!videoSrc
  const hasAnalysis = analysis?.status === 'completed'

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <button
            onClick={() => router.push(`/feedback/${sessionId}`)}
            className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
            aria-label="Back to feedback"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">Interview Replay</h1>
            <p className="text-sm text-gray-400">
              {sessionData.config.role} &middot; {sessionData.config.interviewType || 'Screening'} &middot; {sessionData.config.experience} years
            </p>
          </div>
          {hasAnalysis && analysis.totalCostUsd !== undefined && (
            <span className="ml-auto text-xs text-gray-500">
              Analysis cost: ${analysis.totalCostUsd.toFixed(3)} &middot; {((analysis.processingDurationMs || 0) / 1000).toFixed(0)}s
            </span>
          )}
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* No recording state */}
        {!hasRecording && (
          <div className="flex flex-col items-center gap-4 p-12 rounded-xl bg-gray-800/30 border border-gray-700/30">
            <Video className="w-12 h-12 text-gray-500" />
            <p className="text-gray-400">No recording available for this session</p>
            <p className="text-sm text-gray-500">Enable recording in your next interview to use replay</p>
          </div>
        )}

        {/* Video player + Timeline */}
        {hasRecording && (
          <>
            <VideoPlayer
              src={videoSrc!}
              questionMarkers={questionMarkers}
              onTimeUpdate={handleTimeUpdate}
              onSeek={(fn) => { seekFnRef.current = fn }}
            />

            {/* Screen recording (coding / system-design interviews) */}
            {screenVideoSrc && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-gray-300">
                  <Monitor className="w-4 h-4 text-blue-400" />
                  <span className="font-medium">Screen recording</span>
                  <span className="text-gray-500">
                    &middot; the work surface (IDE / canvas) you used during this interview
                  </span>
                </div>
                <VideoPlayer
                  src={screenVideoSrc}
                  questionMarkers={questionMarkers}
                />
              </div>
            )}

            {hasAnalysis && analysis.timeline && (
              <TimelineTrack
                events={analysis.timeline}
                totalDurationSec={totalDurationSec}
                currentTimeSec={currentTime}
                onSeek={handleSeek}
              />
            )}
          </>
        )}

        {/* Score summary badges */}
        {hasAnalysis && analysis.fusionSummary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <ScoreBadge
              icon={<Eye className="w-4 h-4" />}
              label="Eye Contact"
              score={analysis.fusionSummary.eyeContactScore}
            />
            <ScoreBadge
              icon={<Mic className="w-4 h-4" />}
              label="Body Language"
              score={analysis.fusionSummary.overallBodyLanguageScore}
            />
            <ScoreBadge
              icon={<BarChart3 className="w-4 h-4" />}
              label="Timeline Events"
              score={analysis.timeline?.length || 0}
              isCount
            />
            <ScoreBadge
              icon={<Lightbulb className="w-4 h-4" />}
              label="Coaching Tips"
              score={analysis.fusionSummary.coachingTips.length}
              isCount
            />
          </div>
        )}

        {/* Analysis trigger (no analysis yet) */}
        {hasRecording && !hasAnalysis && (
          <AnalysisTrigger
            sessionId={sessionId}
            onAnalysisComplete={handleAnalysisComplete}
          />
        )}

        {/* Tabbed content */}
        {hasAnalysis && (
          <div>
            {/* Tab buttons */}
            <div className="flex border-b border-gray-800 mb-4">
              {([
                { key: 'transcript' as Tab, label: 'Transcript', icon: <MessageSquare className="w-4 h-4" /> },
                { key: 'signals' as Tab, label: 'Signals', icon: <BarChart3 className="w-4 h-4" /> },
                { key: 'coaching' as Tab, label: 'Coaching', icon: <Lightbulb className="w-4 h-4" /> },
              ]).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-blue-500 text-blue-400'
                      : 'border-transparent text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === 'transcript' && (
              <ReplayTranscript
                whisperSegments={analysis.whisperTranscript || []}
                transcript={sessionData.transcript}
                currentTimeSec={currentTime}
                onWordClick={handleSeek}
              />
            )}

            {activeTab === 'signals' && (
              <SignalCharts
                prosodySegments={analysis.prosodySegments || []}
                facialSegments={analysis.facialSegments || []}
                currentTimeSec={currentTime}
              />
            )}

            {activeTab === 'coaching' && analysis.fusionSummary && (
              <CoachingPanel
                fusionSummary={analysis.fusionSummary}
                timeline={analysis.timeline || []}
                onSeek={handleSeek}
              />
            )}
          </div>
        )}
      </div>
    </main>
  )
}

function ScoreBadge({
  icon,
  label,
  score,
  isCount = false,
}: {
  icon: React.ReactNode
  label: string
  score: number
  isCount?: boolean
}) {
  const color = isCount
    ? 'text-blue-400'
    : score >= 70
    ? 'text-emerald-400'
    : score >= 40
    ? 'text-amber-400'
    : 'text-red-400'

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-800/50 border border-gray-700/30">
      <span className="text-gray-400">{icon}</span>
      <div>
        <p className={`text-lg font-semibold tabular-nums ${color}`}>
          {isCount ? score : `${score}/100`}
        </p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  )
}
