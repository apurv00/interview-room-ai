'use client'

import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import type { ProsodySegment, FacialSegment } from '@shared/types/multimodal'

interface SignalChartsProps {
  prosodySegments: ProsodySegment[]
  facialSegments: FacialSegment[]
  currentTimeSec: number
}

export default function SignalCharts({ prosodySegments, facialSegments, currentTimeSec }: SignalChartsProps) {
  // WPM data
  const wpmData = prosodySegments.map((p, i) => ({
    name: `Q${(p.questionIndex ?? i) + 1}`,
    wpm: p.wpm,
    midpoint: (p.startSec + p.endSec) / 2,
    confidence: p.confidenceMarker,
  }))

  // Eye contact data
  const eyeContactData = facialSegments.map((f, i) => ({
    name: `Q${(f.questionIndex ?? i) + 1}`,
    eyeContact: Math.round(f.avgEyeContact * 100),
    midpoint: (f.startSec + f.endSec) / 2,
  }))

  // Filler density
  const fillerData = prosodySegments.map((p, i) => ({
    name: `Q${(p.questionIndex ?? i) + 1}`,
    fillers: p.fillerWords.length,
    midpoint: (p.startSec + p.endSec) / 2,
  }))

  return (
    <div className="space-y-6">
      {/* WPM over time */}
      {wpmData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Speaking Pace (WPM)</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={wpmData}>
                <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
                  labelStyle={{ color: '#e5e7eb' }}
                />
                {/* Ideal WPM zone */}
                <ReferenceLine y={120} stroke="#4ade80" strokeDasharray="3 3" strokeOpacity={0.4} />
                <ReferenceLine y={160} stroke="#4ade80" strokeDasharray="3 3" strokeOpacity={0.4} />
                <Line
                  type="monotone"
                  dataKey="wpm"
                  stroke="#818cf8"
                  strokeWidth={2}
                  dot={{ fill: '#818cf8', r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-gray-500 mt-1">Green zone: ideal 120–160 WPM</p>
        </div>
      )}

      {/* Eye contact */}
      {eyeContactData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Eye Contact</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={eyeContactData}>
                <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} domain={[0, 100]} unit="%" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
                  labelStyle={{ color: '#e5e7eb' }}
                  formatter={(value) => [`${value}%`, 'Eye Contact']}
                />
                <Area
                  type="monotone"
                  dataKey="eyeContact"
                  stroke="#34d399"
                  fill="#34d399"
                  fillOpacity={0.2}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filler word density */}
      {fillerData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Filler Words per Question</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fillerData}>
                <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }}
                  labelStyle={{ color: '#e5e7eb' }}
                />
                <Bar dataKey="fillers" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Current time indicator (just informational) */}
      <p className="text-xs text-gray-500 text-center">
        Playback: {Math.floor(currentTimeSec / 60)}:{Math.floor(currentTimeSec % 60).toString().padStart(2, '0')}
      </p>
    </div>
  )
}
