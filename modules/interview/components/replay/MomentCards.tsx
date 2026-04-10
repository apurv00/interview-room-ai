'use client'

import { Eye, Mic, Brain, Lightbulb, Play } from 'lucide-react'
import type { TimelineEvent } from '@shared/types/multimodal'

interface MomentCardsProps {
  moments: TimelineEvent[]
  onSeek: (seconds: number) => void
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string; badge: string }> = {
  positive: { bg: 'bg-emerald-50', border: 'border-emerald-200', badge: 'bg-emerald-600' },
  attention: { bg: 'bg-amber-50', border: 'border-amber-200', badge: 'bg-amber-600' },
  neutral: { bg: 'bg-slate-50', border: 'border-slate-200', badge: 'bg-slate-500' },
}

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  audio: <Mic className="w-3.5 h-3.5" />,
  facial: <Eye className="w-3.5 h-3.5" />,
  content: <Brain className="w-3.5 h-3.5" />,
  fused: <Lightbulb className="w-3.5 h-3.5" />,
}

const TYPE_EMOJI: Record<string, string> = {
  strength: '\u2197\ufe0f',
  improvement: '\u2198\ufe0f',
  observation: '\ud83d\udd0d',
  coaching_tip: '\ud83d\udca1',
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function MomentCards({ moments, onSeek }: MomentCardsProps) {
  if (moments.length === 0) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {moments.map((moment, i) => {
        const severity = moment.severity || 'neutral'
        const styles = SEVERITY_STYLES[severity] || SEVERITY_STYLES.neutral

        return (
          <button
            key={i}
            onClick={() => onSeek(moment.startSec)}
            className={`${styles.bg} ${styles.border} border rounded-xl p-4 text-left transition-all hover:shadow-md hover:scale-[1.01] cursor-pointer group`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`${styles.badge} text-white text-xs font-mono px-2 py-0.5 rounded-md`}>
                {formatTime(moment.startSec)}
              </span>
              <span className="text-sm">{TYPE_EMOJI[moment.type] || ''}</span>
              <span className="text-[#71767b] opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
                <Play className="w-3.5 h-3.5" />
              </span>
            </div>
            <p className="text-sm font-medium text-[#0f1419] leading-snug">{moment.title}</p>
            <p className="text-caption text-[#71767b] mt-1 line-clamp-2">{moment.description}</p>
            <div className="flex items-center gap-1 mt-2 text-[#8b98a5]">
              {SIGNAL_ICONS[moment.signal] || <Lightbulb className="w-3.5 h-3.5" />}
              <span className="text-xs capitalize">{moment.signal}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
