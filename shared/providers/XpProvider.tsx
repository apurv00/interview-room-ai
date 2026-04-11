'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useSession } from 'next-auth/react'
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
  // Gate the XP fetch behind auth. Previously this provider was mounted at
  // the root of the app and fired `GET /api/learn/xp` on every page load —
  // including for anonymous homepage visitors. `/api/learn/xp` is not in the
  // middleware public allowlist, so NextAuth intercepted the 401 and
  // constructed a redirect with `callbackUrl=/api/learn/xp`. After OAuth
  // the user landed on the raw JSON endpoint instead of a product page.
  const { status } = useSession()
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
    // Defensive no-op: refreshXp is also exposed on the context for manual
    // refreshes (e.g. after earning XP). The same gate applies there.
    if (status !== 'authenticated') return
    try {
      const res = await deduplicatedFetch('/api/learn/xp')
      if (res.ok) {
        const json = await res.json()
        setData(json)
      }
    } catch {
      // Silently fail
    }
  }, [status])

  useEffect(() => {
    if (status !== 'authenticated') return
    refreshXp()
  }, [status, refreshXp])

  return (
    <XpContext.Provider value={{ ...data, refreshXp }}>
      {children}
    </XpContext.Provider>
  )
}
