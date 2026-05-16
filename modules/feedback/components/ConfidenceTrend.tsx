'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

interface SpeechMetric {
  wpm: number
  fillerRate: number
}

interface ConfidenceTrendProps {
  speechMetrics: SpeechMetric[]
}

function deriveConfidence(wpm: number, fillerRate: number): number {
  const raw = 100 - fillerRate * 200 - Math.abs(wpm - 140) * 0.5
  return Math.round(Math.max(0, Math.min(100, raw)))
}

export default function ConfidenceTrend({ speechMetrics }: ConfidenceTrendProps) {
  if (!speechMetrics || speechMetrics.length === 0) {
    return (
      <div className="text-center py-8 text-[#71767b] text-sm">
        No confidence data available.
      </div>
    )
  }

  const data = speechMetrics.map((m, i) => ({
    name: `Q${i + 1}`,
    confidence: deriveConfidence(m.wpm, m.fillerRate),
  }))

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Confidence Trend</h4>
      <ResponsiveContainer width="100%" height={150}>
        <AreaChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <defs>
            <linearGradient id="confidenceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
              <stop offset="40%" stopColor="#10b981" stopOpacity={0.2} />
              <stop offset="60%" stopColor="#f59e0b" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="name"
            tick={{ fontSize: 12, fill: '#71767b' }}
            axisLine={{ stroke: '#e1e8ed' }}
            tickLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 12, fill: '#71767b' }}
            axisLine={{ stroke: '#e1e8ed' }}
            tickLine={false}
            width={35}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fff',
              border: '1px solid #e1e8ed',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#0f1419',
            }}
            formatter={(value) => [`${value}`, 'Confidence']}
          />
          {/* Zone reference lines */}
          <ReferenceLine
            y={60}
            stroke="#10b981"
            strokeDasharray="3 3"
            strokeOpacity={0.5}
          />
          <ReferenceLine
            y={40}
            stroke="#f59e0b"
            strokeDasharray="3 3"
            strokeOpacity={0.5}
          />
          <Area
            type="monotone"
            dataKey="confidence"
            stroke="#2563eb"
            strokeWidth={2}
            fill="url(#confidenceGradient)"
            dot={{ r: 3, fill: '#2563eb' }}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-2 text-[10px] text-[#71767b]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#10b981]" />
          Above 60: Strong
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#f59e0b]" />
          40-60: Moderate
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
          Below 40: Low
        </span>
      </div>
    </div>
  )
}
