export const PROBABILITY_COLORS = {
  High: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  Medium: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  Low: 'text-red-400 bg-red-500/10 border-red-500/30',
} as const

export const CONFIDENCE_TREND_LABELS = {
  increasing: { text: 'Improving', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  stable: { text: 'Stable', color: 'text-[#8b98a5] bg-[#eff3f4] border-[#e1e8ed]' },
  declining: { text: 'Declining', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
} as const
