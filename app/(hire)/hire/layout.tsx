'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { LayoutDashboard, Users, FileText, Mail, Settings, Briefcase, ArrowLeft, Menu, LogOut } from 'lucide-react'
import Skeleton from '@shared/ui/Skeleton'

const HIRE_NAV = [
  { href: '/hire/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/hire/candidates', label: 'Candidates', icon: Users },
  { href: '/hire/templates', label: 'Templates', icon: FileText },
  { href: '/hire/invite', label: 'Invite', icon: Mail },
  { href: '/hire/settings', label: 'Settings', icon: Settings },
]

export default function HireLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-page)]">
        <Skeleton variant="rect" width={240} height={16} />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-[var(--color-page)]">
      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-60 bg-[var(--color-card)] border-r border-[var(--color-border)]
        transform transition-transform duration-200
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:translate-x-0 md:static
      `}>
        {/* Brand */}
        <div className="h-14 flex items-center px-5 border-b border-[var(--color-border)]">
          <Link href="/hire/dashboard" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-[var(--ds-radius-sm)] bg-[var(--ds-primary)] flex items-center justify-center">
              <Briefcase className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <div>
              <span className="text-sm font-bold text-[var(--foreground)]">IPG Hire</span>
              <span className="block text-micro text-[var(--foreground-tertiary)]">For Recruiters</span>
            </div>
          </Link>
        </div>

        {/* Nav links */}
        <nav className="px-3 py-4 space-y-1">
          {HIRE_NAV.map(link => {
            const isActive = pathname.startsWith(link.href)
            const Icon = link.icon
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-[var(--ds-radius-sm)] text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-[var(--ds-primary-light)] text-[var(--ds-primary)] border border-[var(--ds-primary-border)]'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--color-surface)]'
                }`}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={1.5} />
                {link.label}
              </Link>
            )
          })}
        </nav>

        {/* Bottom section */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-[var(--color-border)]">
          <Link href="/" className="flex items-center gap-2 text-xs text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors mb-3">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Main Site
          </Link>
          {session?.user && (
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[var(--foreground-secondary)] truncate">{session.user.name}</p>
                <p className="text-micro text-[var(--foreground-tertiary)] truncate">{session.user.email}</p>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: '/' })}
                className="text-[var(--foreground-tertiary)] hover:text-red-500 transition-colors"
                aria-label="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Backdrop for mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main content */}
      <div className="flex-1 md:ml-0">
        {/* Top bar for mobile */}
        <header className="md:hidden sticky top-0 z-20 h-14 bg-[var(--color-card)] border-b border-[var(--color-border)] flex items-center px-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-[var(--foreground-secondary)] hover:text-[var(--foreground)] transition-colors"
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="ml-3 text-sm font-bold text-[var(--foreground)]">IPG Hire</span>
        </header>

        <main className="p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
