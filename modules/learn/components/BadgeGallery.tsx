'use client'

import { useEffect, useState } from 'react'
import BadgeCard from './BadgeCard'

interface BadgeDef {
  id: string
  name: string
  description: string
  icon: string
  category: string
  rarity: string
}

interface EarnedBadge extends BadgeDef {
  earnedAt: Date
}

const CATEGORY_LABELS: Record<string, string> = {
  milestone: 'Milestones',
  streak: 'Streaks',
  score: 'Scores',
  exploration: 'Exploration',
  social: 'Social',
}

export default function BadgeGallery() {
  const [earned, setEarned] = useState<EarnedBadge[]>([])
  const [available, setAvailable] = useState<BadgeDef[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/learn/badges')
      .then(r => r.json())
      .then(data => {
        setEarned(data.earned || [])
        setAvailable(data.available || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-32 bg-[#f8fafc] rounded-xl animate-pulse" />
        ))}
      </div>
    )
  }

  const allBadges = [
    ...earned.map(b => ({ ...b, earned: true })),
    ...available.map(b => ({ ...b, earned: false, earnedAt: undefined })),
  ]

  // Group by category
  const categories = Object.keys(CATEGORY_LABELS)

  return (
    <div className="space-y-8">
      <div className="text-sm text-[#71767b]">
        {earned.length} / {allBadges.length} badges earned
      </div>

      {categories.map(cat => {
        const badges = allBadges.filter(b => b.category === cat)
        if (badges.length === 0) return null

        return (
          <section key={cat}>
            <h2 className="text-sm font-semibold text-[#0f1419] mb-3">
              {CATEGORY_LABELS[cat]}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {badges.map(badge => (
                <BadgeCard
                  key={badge.id}
                  icon={badge.icon}
                  name={badge.name}
                  description={badge.description}
                  rarity={badge.rarity}
                  earned={badge.earned}
                  earnedAt={'earnedAt' in badge ? (badge as EarnedBadge).earnedAt : undefined}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
