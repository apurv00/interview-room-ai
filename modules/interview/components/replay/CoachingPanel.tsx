'use client'

import { Eye, Mic, Brain, Lightbulb, Play } from 'lucide-react'
import type { TimelineEvent, FusionSummary } from '@shared/types/multimodal'

interface CoachingPanelProps {
  fusionSummary: FusionSummary
  timeline: TimelineEvent[]
  onSeek: (seconds: number) => void
}

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  audio: <Mic className="w-4 h-4" />,
  facial: <Eye className="w-4 h-4" />,
  content: <Brain className="w-4 h-4" />,
  fused: <Lightbulb className="w-4 h-4" />,
}

const SIGNAL_COLORS: Record<string, string> = {
  audio: 'text-purple-400',
  facial: 'text-emerald-400',
  content: 'text-blue-400',
  fused: 'text-yellow-400',
}

export default function CoachingPanel({ fusionSummary, timeline, onSeek }: CoachingPanelProps) {
  const coachingEvents = timeline.filter((e) => e.type === 'coaching_tip')
  const improvementEvents = fusionSummary.improvementMoments || []

  return (
    <div className="space-y-6">
      {/* Actionable coaching tips */}
      <div>
        <h4 className="text-sm font-semibold text-gray-200 mb-3">Coaching Tips</h4>
        <div className="space-y-2">
          {fusionSummary.coachingTips.map((tip, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20"
            >
              <span className="mt-0.5 text-blue-400">
                <Lightbulb className="w-4 h-4" />
              </span>
              <p className="text-sm text-gray-200">{tip}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Improvement moments with "watch" buttons */}
      {improvementEvents.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-200 mb-3">Key Moments to Review</h4>
          <div className="space-y-2">
            {improvementEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-gray-400'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200">{event.title}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors shrink-0"
                  title={`Jump to ${formatTime(event.startSec)}`}
                >
                  <Play className="w-3 h-3" />
                  {formatTime(event.startSec)}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline coaching tip events */}
      {coachingEvents.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-200 mb-3">Coaching Moments</h4>
          <div className="space-y-2">
            {coachingEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/30"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-gray-400'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300">{event.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors shrink-0"
                >
                  <Play className="w-3 h-3" />
                  {formatTime(event.startSec)}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
