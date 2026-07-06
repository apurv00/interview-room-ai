'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { dimensionLabels } from '@shared/lib/answerSuggestion'

interface Evaluation {
  /** 1-based original question number, preserved across filters in OverviewTab.
   *  Falls back to array position for older callers that don't supply it. */
  questionNumber?: number
  relevance: number
  structure: number
  specificity: number
  ownership: number
}

interface ScoreProgressionChartProps {
  evaluations: Evaluation[]
  /** Session interview-type slug — domain-aware series names (config.interviewType). */
  interviewType?: string
}

const DIMENSION_COLORS = {
  relevance: '#2563eb',
  structure: '#10b981',
  specificity: '#f59e0b',
  ownership: '#8b5cf6',
} as const

export default function ScoreProgressionChart({ evaluations, interviewType }: ScoreProgressionChartProps) {
  if (!evaluations || evaluations.length === 0) {
    return (
      <div className="text-center py-8 text-[#71767b] text-sm">
        No score data available.
      </div>
    )
  }

  const labels = dimensionLabels(interviewType)

  const data = evaluations.map((ev, i) => ({
    name: `Q${ev.questionNumber ?? i + 1}`,
    relevance: ev.relevance,
    structure: ev.structure,
    specificity: ev.specificity,
    ownership: ev.ownership,
  }))

  return (
    <div className="bg-white rounded-2xl border border-[#e1e8ed] p-4">
      <h4 className="text-sm font-semibold text-[#0f1419] mb-3">Score Progression</h4>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
          />
          <Legend
            wrapperStyle={{ fontSize: '12px', color: '#71767b' }}
          />
          <Line
            type="monotone"
            dataKey="relevance"
            stroke={DIMENSION_COLORS.relevance}
            strokeWidth={2}
            dot={{ r: 3, fill: DIMENSION_COLORS.relevance }}
            activeDot={{ r: 5 }}
            name={labels.relevance}
          />
          <Line
            type="monotone"
            dataKey="structure"
            stroke={DIMENSION_COLORS.structure}
            strokeWidth={2}
            dot={{ r: 3, fill: DIMENSION_COLORS.structure }}
            activeDot={{ r: 5 }}
            name={labels.structure}
          />
          <Line
            type="monotone"
            dataKey="specificity"
            stroke={DIMENSION_COLORS.specificity}
            strokeWidth={2}
            dot={{ r: 3, fill: DIMENSION_COLORS.specificity }}
            activeDot={{ r: 5 }}
            name={labels.specificity}
          />
          <Line
            type="monotone"
            dataKey="ownership"
            stroke={DIMENSION_COLORS.ownership}
            strokeWidth={2}
            dot={{ r: 3, fill: DIMENSION_COLORS.ownership }}
            activeDot={{ r: 5 }}
            name={labels.ownership}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
