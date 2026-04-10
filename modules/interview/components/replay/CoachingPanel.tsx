'use client'

import { Eye, Mic, Brain, Lightbulb, Play } from 'lucide-react'
import type { TimelineEvent, FusionSummary } from '@shared/types/multimodal'

interface CoachingPanelProps {
  fusionSummary: FusionSummary
  timeline: TimelineEvent[]
  onSeek: (seconds: number) => void
  hideMoments?: boolean
}

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  audio: <Mic className="w-4 h-4" />,
  facial: <Eye className="w-4 h-4" />,
  content: <Brain className="w-4 h-4" />,
  fused: <Lightbulb className="w-4 h-4" />,
}

const SIGNAL_COLORS: Record<string, string> = {
  audio: 'text-purple-600',
  facial: 'text-emerald-600',
  content: 'text-blue-600',
  fused: 'text-amber-600',
}

export default function CoachingPanel({ fusionSummary, timeline, onSeek, hideMoments }: CoachingPanelProps) {
  const coachingEvents = timeline.filter((e) => e.type === 'coaching_tip')
  const improvementEvents = fusionSummary.improvementMoments || []

  return (
    <div className="space-y-6">
      {/* Actionable coaching tips */}
      <div className="surface-card-bordered p-4 sm:p-5">
        <h4 className="text-subheading text-[#0f1419] mb-3">Coaching Tips</h4>
        <div className="space-y-2">
          {fusionSummary.coachingTips.map((tip, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/8 border border-blue-500/15"
            >
              <span className="mt-0.5 text-blue-600">
                <Lightbulb className="w-4 h-4" />
              </span>
              <p className="text-body text-[#0f1419]">{tip}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Improvement moments with "watch" buttons */}
      {!hideMoments && improvementEvents.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-3">Key Moments to Review</h4>
          <div className="space-y-2">
            {improvementEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-[#f8fafc] border border-[#e1e8ed]"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-[#71767b]'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#0f1419]">{event.title}</p>
                  <p className="text-caption text-[#71767b] mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] transition-colors shrink-0"
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
      {!hideMoments && coachingEvents.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-3">Coaching Moments</h4>
          <div className="space-y-2">
            {coachingEvents.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 p-3 rounded-lg bg-[#f8fafc] border border-[#eff3f4]"
              >
                <span className={SIGNAL_COLORS[event.signal] || 'text-[#71767b]'}>
                  {SIGNAL_ICONS[event.signal] || <Lightbulb className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#0f1419]">{event.title}</p>
                  <p className="text-caption text-[#8b98a5] mt-0.5">{event.description}</p>
                </div>
                <button
                  onClick={() => onSeek(event.startSec)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-[#eff3f4] hover:bg-[#e1e8ed] text-[#536471] transition-colors shrink-0"
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
