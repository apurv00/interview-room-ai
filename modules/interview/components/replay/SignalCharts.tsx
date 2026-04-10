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

  // Eye contact data — skip segments with no facial data (sentinel value -1)
  const eyeContactData = facialSegments
    .filter((f) => f.avgEyeContact >= 0)
    .map((f, i) => ({
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
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-2">Speaking Pace (WPM)</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={wpmData}>
                <XAxis dataKey="name" tick={{ fill: '#71767b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71767b', fontSize: 11 }} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                  labelStyle={{ color: '#0f1419' }}
                />
                {/* Ideal WPM zone */}
                <ReferenceLine y={120} stroke="#059669" strokeDasharray="3 3" strokeOpacity={0.4} />
                <ReferenceLine y={160} stroke="#059669" strokeDasharray="3 3" strokeOpacity={0.4} />
                <Line
                  type="monotone"
                  dataKey="wpm"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={{ fill: '#2563eb', r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-caption text-[#8b98a5] mt-1">Green zone: ideal 120-160 WPM</p>
        </div>
      )}

      {/* Eye contact */}
      {eyeContactData.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-2">Eye Contact</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={eyeContactData}>
                <XAxis dataKey="name" tick={{ fill: '#71767b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71767b', fontSize: 11 }} domain={[0, 100]} unit="%" />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                  labelStyle={{ color: '#0f1419' }}
                  formatter={(value) => [`${value}%`, 'Eye Contact']}
                />
                <Area
                  type="monotone"
                  dataKey="eyeContact"
                  stroke="#059669"
                  fill="#059669"
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filler word density */}
      {fillerData.length > 0 && (
        <div className="surface-card-bordered p-4 sm:p-5">
          <h4 className="text-subheading text-[#0f1419] mb-2">Filler Words per Question</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={fillerData}>
                <XAxis dataKey="name" tick={{ fill: '#71767b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71767b', fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e1e8ed', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                  labelStyle={{ color: '#0f1419' }}
                />
                <Bar dataKey="fillers" fill="#d97706" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Current time indicator (just informational) */}
      <p className="text-caption text-[#8b98a5] text-center">
        Playback: {Math.floor(currentTimeSec / 60)}:{Math.floor(currentTimeSec % 60).toString().padStart(2, '0')}
      </p>
    </div>
  )
}
