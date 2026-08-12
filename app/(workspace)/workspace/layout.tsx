'use client'

/**
 * IPG Hire v2 member shell — sidebar layout for the workspace surface
 * (/workspace/* on www, and the whole hire.* subdomain via the middleware
 * rewrite). On www the middleware auth-gates /workspace directly; on the
 * hire subdomain the PRE-REWRITE pathname (e.g. "/", "/jobs") can be in the
 * public allowlist, so this shell owns the signed-out redirect. Workspace
 * membership is enforced per-request by the API layer (requireMembership).
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { clearAllInterviewStorage } from '@shared/storageKeys'

interface HireMemberSessionView {
  authenticated: boolean
  member?: { name: string; email: string; role: 'admin' | 'member' }
}

const NAV = [
  { href: '/workspace/jobs', label: 'Jobs', icon: '📋' },
  { href: '/workspace/candidates', label: 'Candidates', icon: '👥' },
  { href: '/workspace/members', label: 'Team', icon: '🧑‍💼' },
]

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const [hireSession, setHireSession] = useState<HireMemberSessionView | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    let live = true
    void fetch('/api/hire-auth/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((value: HireMemberSessionView) => {
        if (live) setHireSession(value)
      })
      .catch(() => {
        if (live) setHireSession({ authenticated: false })
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (status === 'unauthenticated' && hireSession?.authenticated === false) {
      router.replace('/hire-signin')
    }
  }, [status, hireSession, router, pathname])

  const nav = (
    <nav className="flex-1 px-3 py-4 space-y-1">
      {NAV.map((item) => {
        const active = pathname?.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
              active
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-[#536471] hover:bg-gray-50 hover:text-[#0f1419]'
            }`}
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </Link>
        )
      })}
    </nav>
  )

  const brand = (
    <div className="px-5 py-5 border-b border-[#e1e8ed]">
      <Link href="/workspace" className="block">
        <span className="text-lg font-bold text-[#0f1419]">IPG Hire</span>
        <span className="block text-xs text-[#71767b]">Hiring workspace</span>
      </Link>
    </div>
  )

  const userBlock = (
    <div className="px-5 py-4 border-t border-[#e1e8ed] text-sm">
      <p className="truncate text-[#0f1419]">
        {hireSession?.member?.email ?? session?.user?.email ?? ''}
      </p>
      <button
        onClick={async () => {
          // Shared-browser privacy: scrub account-bound state BEFORE the
          // session ends (same contract as AppShell/Resume; pinned by
          // shared/layout/__tests__/signOutStorage.test.tsx).
          await clearAllInterviewStorage()
          await fetch('/api/hire-auth/signout', { method: 'POST' }).catch(() => undefined)
          if (session?.user) {
            await signOut({ callbackUrl: '/hire-signin' })
          } else {
            window.location.assign('/hire-signin')
          }
        }}
        className="mt-1 text-xs text-[#71767b] hover:text-[#f4212e] transition-colors"
      >
        Sign out
      </button>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#f8fafc]">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col bg-white border-r border-[#e1e8ed] z-30">
        {brand}
        {nav}
        {userBlock}
      </aside>

      {/* Mobile header + drawer */}
      <div className="md:hidden sticky top-0 z-30 bg-white border-b border-[#e1e8ed] flex items-center justify-between px-4 py-3">
        <Link href="/workspace" className="font-bold text-[#0f1419]">
          IPG Hire
        </Link>
        <button
          aria-label="Menu"
          onClick={() => setMobileOpen((v) => !v)}
          className="px-2 py-1 text-xl"
        >
          ☰
        </button>
      </div>
      {mobileOpen && (
        <div className="md:hidden bg-white border-b border-[#e1e8ed]">
          {nav}
          {userBlock}
        </div>
      )}

      <main className="md:pl-60">
        <div className="p-4 md:p-8 max-w-5xl">{children}</div>
      </main>
    </div>
  )
}
