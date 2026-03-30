'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSession } from 'next-auth/react'
import BadgeToast from './BadgeToast'

interface UnnotifiedBadge {
  badgeId: string
  name: string
  icon: string
  xpReward: number
}

const BASE_INTERVAL_MS = 120_000 // 2 minutes
const MAX_INTERVAL_MS = 300_000  // 5 minutes

export default function BadgeUnlockChecker() {
  const { status } = useSession()
  const [queue, setQueue] = useState<UnnotifiedBadge[]>([])
  const intervalRef = useRef(BASE_INTERVAL_MS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleNext = useCallback((checkFn: () => Promise<void>) => {
    timerRef.current = setTimeout(() => {
      if (!document.hidden) {
        checkFn()
      } else {
        scheduleNext(checkFn)
      }
    }, intervalRef.current)
  }, [])

  const checkBadges = useCallback(async () => {
    try {
      const res = await fetch('/api/learn/badges/unnotified')
      if (!res.ok) return
      const data = await res.json()
      if (data.badges?.length > 0) {
        // Reset to base interval when badges are found
        intervalRef.current = BASE_INTERVAL_MS
        setQueue(prev => {
          const existing = new Set(prev.map(b => b.badgeId))
          const newBadges = data.badges.filter((b: UnnotifiedBadge) => !existing.has(b.badgeId))
          return [...prev, ...newBadges]
        })
      } else {
        // Exponential backoff when no badges found (up to max)
        intervalRef.current = Math.min(intervalRef.current * 1.5, MAX_INTERVAL_MS)
      }
    } catch {
      // Silently fail — backoff on error too
      intervalRef.current = Math.min(intervalRef.current * 1.5, MAX_INTERVAL_MS)
    }
    scheduleNext(checkBadges)
  }, [scheduleNext])

  useEffect(() => {
    if (status !== 'authenticated') return

    // Initial check after a short delay to avoid blocking page load
    const initialTimer = setTimeout(() => checkBadges(), 2000)

    return () => {
      clearTimeout(initialTimer)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
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
