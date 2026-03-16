'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import BadgeToast from './BadgeToast'

interface UnnotifiedBadge {
  badgeId: string
  name: string
  icon: string
  xpReward: number
}

export default function BadgeUnlockChecker() {
  const { status } = useSession()
  const [queue, setQueue] = useState<UnnotifiedBadge[]>([])

  const checkBadges = useCallback(async () => {
    try {
      const res = await fetch('/api/learn/badges/unnotified')
      if (!res.ok) return
      const data = await res.json()
      if (data.badges?.length > 0) {
        setQueue(prev => {
          const existing = new Set(prev.map(b => b.badgeId))
          const newBadges = data.badges.filter((b: UnnotifiedBadge) => !existing.has(b.badgeId))
          return [...prev, ...newBadges]
        })
      }
    } catch {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') return

    // Initial check
    checkBadges()

    // Poll every 30 seconds when tab is visible
    const interval = setInterval(() => {
      if (!document.hidden) checkBadges()
    }, 30000)

    return () => clearInterval(interval)
  }, [status, checkBadges])

  const dismissBadge = useCallback(async (badgeId: string) => {
    setQueue(prev => prev.filter(b => b.badgeId !== badgeId))
    try {
      await fetch('/api/learn/badges/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ badgeId }),
      })
    } catch {
      // Silently fail
    }
  }, [])

  if (queue.length === 0) return null

  const current = queue[0]

  return (
    <BadgeToast
      key={current.badgeId}
      icon={current.icon}
      name={current.name}
      xpReward={current.xpReward}
      onDismiss={() => dismissBadge(current.badgeId)}
    />
  )
}
