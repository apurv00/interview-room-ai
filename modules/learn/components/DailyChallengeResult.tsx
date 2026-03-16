'use client'

interface DailyChallengeResultProps {
  score: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
  percentile: number
  communityAvg: number
  participantCount: number
}

const DIMENSION_LABELS: Record<string, string> = {
  relevance: 'Relevance',
  structure: 'Structure (STAR)',
  specificity: 'Specificity',
  ownership: 'Ownership',
}

export default function DailyChallengeResult({
  score,
  breakdown,
  percentile,
  communityAvg,
  participantCount,
}: DailyChallengeResultProps) {
  const scoreColor = score >= 80 ? 'text-[#34d399]' : score >= 60 ? 'text-[#f59e0b]' : 'text-[#f87171]'

  return (
    <div className="space-y-4">
      {/* Overall score */}
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-3xl font-bold ${scoreColor}`}>{score}</span>
          <span className="text-sm text-[#6b7280]">/100</span>
        </div>
        <div className="text-right text-xs text-[#6b7280]">
          <p>Top {100 - percentile}% of {participantCount} participants</p>
          <p>Community avg: {communityAvg}</p>
        </div>
      </div>

      {/* Breakdown */}
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(breakdown).map(([key, value]) => (
          <div key={key} className="bg-[#0f172a] rounded-lg px-3 py-2">
            <p className="text-micro text-[#6b7280]">{DIMENSION_LABELS[key] || key}</p>
            <p className="text-sm font-semibold text-[#f0f2f5]">{value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
