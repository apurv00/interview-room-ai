'use client'

import type { SpeechMetrics } from '@/lib/types'

interface CommunicationDetailProps {
  metrics: SpeechMetrics[]
}

export default function CommunicationDetail({ metrics }: CommunicationDetailProps) {
  if (metrics.length === 0) return null

  const maxWpm = Math.max(...metrics.map((m) => m.wpm), 200)

  return (
    <div className="space-y-3">
      {/* WPM per question mini chart */}
      <div>
        <p className="text-xs text-slate-500 font-medium mb-2">Pacing per question</p>
        <div className="flex items-end gap-1 h-10">
          {metrics.map((m, i) => {
            const h = Math.max(4, (m.wpm / maxWpm) * 100)
            const color =
              m.wpm >= 120 && m.wpm <= 160
                ? 'bg-emerald-500'
                : m.wpm > 180
                ? 'bg-red-400'
                : 'bg-amber-400'
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5" title={`Q${i + 1}: ${m.wpm} wpm`}>
                <div className={`w-full rounded-sm ${color} transition-all`} style={{ height: `${h}%` }} />
                <span className="text-[9px] text-slate-600">{i + 1}</span>
              </div>
            )
          })}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[9px] text-slate-600">Ideal: 120-160 wpm</span>
          <span className="text-[9px] text-slate-600">
            <span className="inline-block w-1.5 h-1.5 rounded-sm bg-emerald-500 mr-0.5" />good
            <span className="inline-block w-1.5 h-1.5 rounded-sm bg-amber-400 mx-0.5 ml-1.5" />slow
            <span className="inline-block w-1.5 h-1.5 rounded-sm bg-red-400 mx-0.5 ml-1.5" />fast
          </span>
        </div>
      </div>

      {/* Filler distribution */}
      <div>
        <p className="text-xs text-slate-500 font-medium mb-1">Filler words per question</p>
        <div className="flex gap-1">
          {metrics.map((m, i) => {
            const intensity = Math.min(1, m.fillerRate * 10)
            return (
              <div
                key={i}
                className="flex-1 h-4 rounded-sm"
                style={{
                  backgroundColor: `rgba(251, 191, 36, ${Math.max(0.1, intensity)})`,
                }}
                title={`Q${i + 1}: ${m.fillerWordCount} filler words (${(m.fillerRate * 100).toFixed(1)}%)`}
              />
            )
          })}
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="text-[9px] text-slate-600">Light = good</span>
          <span className="text-[9px] text-slate-600">Bright = many fillers</span>
        </div>
      </div>
    </div>
  )
}
