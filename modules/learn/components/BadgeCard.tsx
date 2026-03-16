'use client'

interface BadgeCardProps {
  icon: string
  name: string
  description: string
  rarity: string
  earned: boolean
  earnedAt?: Date
}

const RARITY_COLORS: Record<string, string> = {
  common: 'border-[#6b7280]',
  rare: 'border-[#3b82f6]',
  epic: 'border-[#a855f7]',
  legendary: 'border-[#f59e0b]',
}

const RARITY_GLOW: Record<string, string> = {
  common: '',
  rare: 'shadow-blue-500/20',
  epic: 'shadow-purple-500/20',
  legendary: 'shadow-amber-500/30',
}

export default function BadgeCard({ icon, name, description, rarity, earned, earnedAt }: BadgeCardProps) {
  return (
    <div
      className={`surface-card-bordered p-4 text-center transition-all ${
        earned
          ? `border-2 ${RARITY_COLORS[rarity]} shadow-lg ${RARITY_GLOW[rarity]}`
          : 'opacity-40 grayscale'
      }`}
    >
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-sm font-semibold text-[#f0f2f5] mb-1">{name}</p>
      <p className="text-xs text-[#6b7280]">{description}</p>
      {earned && earnedAt && (
        <p className="text-micro text-[#4b5563] mt-2">
          {new Date(earnedAt).toLocaleDateString()}
        </p>
      )}
      {!earned && (
        <p className="text-micro text-[#4b5563] mt-2 uppercase tracking-wide">Locked</p>
      )}
    </div>
  )
}
