'use client'

import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

interface Evaluation {
  relevance: number
  structure: number
  specificity: number
  ownership: number
  jdAlignment?: number
}

interface DimensionRadarProps {
  evaluations: Evaluation[]
}

export default function DimensionRadar({ evaluations }: DimensionRadarProps) {
  if (!evaluations || evaluations.length === 0) {
    return (
      <div className="text-center py-8 text-[#71767b] text-sm">
        No evaluation data available.
      </div>
    )
  }

  const n = evaluations.length
  const avg = (key: keyof Evaluation) => {
    const sum = evaluations.reduce((acc, ev) => acc + (Number(ev[key]) || 0), 0)
    return Math.round(sum / n)
  }

  const hasJdAlignment = evaluations.some((ev) => ev.jdAlignment != null)

  const data = [
    { dimension: 'Relevance', value: avg('relevance'), fullMark: 100 },
    { dimension: 'Structure', value: avg('structure'), fullMark: 100 },
    { dimension: 'Specificity', value: avg('specificity'), fullMark: 100 },
    { dimension: 'Ownership', value: avg('ownership'), fullMark: 100 },
    ...(hasJdAlignment
      ? [{ dimension: 'JD Alignment', value: avg('jdAlignment'), fullMark: 100 }]
      : []),
  ]

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Dimension Overview</h4>
      <ResponsiveContainer width="100%" height={300}>
        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={data}>
          <PolarGrid stroke="#e1e8ed" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fill: '#71767b' }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#71767b' }}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#fff',
              border: '1px solid #e1e8ed',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#0f1419',
            }}
            formatter={(value) => [`${value}`, 'Score']}
          />
          <Radar
            name="Score"
            dataKey="value"
            stroke="#2563eb"
            fill="#2563eb"
            fillOpacity={0.3}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
}
