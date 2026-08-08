'use client'

/**
 * IPG Hire v2 member shell — sidebar layout for the workspace surface
 * (/workspace/*). Middleware requires auth for these paths; workspace
 * membership is enforced per-request by the API layer (requireMembership),
 * so this shell stays dumb: nav + brand + sign-out.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { signOut, useSession } from 'next-auth/react'

const NAV = [
  { href: '/workspace/jobs', label: 'Jobs', icon: '📋' },
  { href: '/workspace/candidates', label: 'Candidates', icon: '👥' },
  { href: '/workspace/members', label: 'Team', icon: '🧑‍💼' },
]

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const [mobileOpen, setMobileOpen] = useState(false)

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
      <p className="truncate text-[#0f1419]">{session?.user?.email ?? ''}</p>
      <button
        onClick={() => signOut({ callbackUrl: '/' })}
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
