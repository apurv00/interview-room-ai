'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { deduplicatedFetch } from '@shared/cachedFetch'

interface XpContextValue {
  xp: number
  level: number
  title: string
  xpToNextLevel: number
  xpThisWeek: number
  xpForCurrentLevel: number
  xpForNextLevel: number
  refreshXp: () => Promise<void>
}

const XpContext = createContext<XpContextValue>({
  xp: 0,
  level: 1,
  title: 'Novice',
  xpToNextLevel: 100,
  xpThisWeek: 0,
  xpForCurrentLevel: 0,
  xpForNextLevel: 100,
  refreshXp: async () => {},
})

export function useXp() {
  return useContext(XpContext)
}

export default function XpProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Omit<XpContextValue, 'refreshXp'>>({
    xp: 0,
    level: 1,
    title: 'Novice',
    xpToNextLevel: 100,
    xpThisWeek: 0,
    xpForCurrentLevel: 0,
    xpForNextLevel: 100,
  })

  const refreshXp = useCallback(async () => {
    try {
      const res = await deduplicatedFetch('/api/learn/xp')
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    refreshXp()
  }, [refreshXp])

  return (
    <XpContext.Provider value={{ ...data, refreshXp }}>
      {children}
    </XpContext.Provider>
  )
}
