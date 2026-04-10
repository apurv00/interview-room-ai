'use client'

import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceArea,
} from 'recharts'

interface SpeechMetric {
  wpm: number
  fillerRate: number
  totalWords: number
}

interface SpeechMetricsChartProps {
  speechMetrics: SpeechMetric[]
}

export default function SpeechMetricsChart({ speechMetrics }: SpeechMetricsChartProps) {
  if (!speechMetrics || speechMetrics.length === 0) {
    return (
      <div className="text-center py-8 text-[#71767b] text-sm">
        No speech metrics available.
      </div>
    )
  }

  const data = speechMetrics.map((m, i) => ({
    name: `Q${i + 1}`,
    wpm: Math.round(m.wpm),
    fillerPct: Math.round(m.fillerRate * 100 * 10) / 10,
    totalWords: m.totalWords,
  }))

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Speech Metrics</h4>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          {/* Ideal WPM zone: 120-160 */}
          <ReferenceArea
            y1={120}
            y2={160}
            yAxisId="left"
            fill="#10b981"
            fillOpacity={0.08}
            label={{ value: 'Ideal WPM', position: 'insideTopLeft', fontSize: 10, fill: '#10b981' }}
          />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 12, fill: '#71767b' }}
            axisLine={{ stroke: '#e1e8ed' }}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 'auto']}
            tick={{ fontSize: 12, fill: '#71767b' }}
            axisLine={{ stroke: '#e1e8ed' }}
            tickLine={false}
            width={35}
            label={{ value: 'WPM', angle: -90, position: 'insideLeft', fontSize: 11, fill: '#71767b' }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, 'auto']}
            tick={{ fontSize: 12, fill: '#71767b' }}
            axisLine={{ stroke: '#e1e8ed' }}
            tickLine={false}
            width={40}
            label={{ value: 'Filler %', angle: 90, position: 'insideRight', fontSize: 11, fill: '#71767b' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fff',
              border: '1px solid #e1e8ed',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#0f1419',
            }}
            formatter={(value, name) => {
              if (name === 'WPM') return [`${value} wpm`, name]
              if (name === 'Filler Rate') return [`${value}%`, name]
              return [`${value}`, name]
            }}
          />
          <Legend wrapperStyle={{ fontSize: '12px', color: '#71767b' }} />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="wpm"
            stroke="#2563eb"
            strokeWidth={2}
            dot={{ r: 3, fill: '#2563eb' }}
            activeDot={{ r: 5 }}
            name="WPM"
          />
          <Bar
            yAxisId="right"
            dataKey="fillerPct"
            fill="#f59e0b"
            fillOpacity={0.7}
            radius={[4, 4, 0, 0]}
            barSize={24}
            name="Filler Rate"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
