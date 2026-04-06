'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import AuthMenu from './AuthMenu'
import Footer from './Footer'
import XpBadge from '@learn/components/XpBadge'
import BadgeUnlockChecker from '@learn/components/BadgeUnlockChecker'

const NAV_LINKS = [
  { href: '/interview/setup', label: 'Interview', icon: 'M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z' },
  { href: '/resume', label: 'Resume', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { href: '/history', label: 'History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { href: '/learn/progress', label: 'Progress', icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' },
  { href: '/resources', label: 'Resources', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
]

const MORE_LINKS = [
  { href: '/resume', label: 'Resume Tools' },
  { href: '/learn/badges', label: 'Badges' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/settings', label: 'Settings' },
]

// Pages where the shell is hidden (full-screen experience)
const HIDDEN_PATHS = ['/interview', '/signin', '/signup']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { status } = useSession()
  const [moreOpen, setMoreOpen] = useState(false)
  const isAuthenticated = status === 'authenticated'

  // Hide shell on full-screen pages
  const isHidden = HIDDEN_PATHS.some((p) => pathname.startsWith(p))
  if (isHidden) return <>{children}</>

  return (
    <>
      {/* Desktop/Tablet header */}
      <nav aria-label="Main navigation" className="sticky top-0 z-50 h-[52px] bg-white/85 backdrop-blur-xl border-b border-[#e1e8ed]/60">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-full">
          <div className="flex items-center justify-between h-full">
            {/* Left: brand */}
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              </div>
              <span className="text-[15px] font-bold text-slate-800 hidden sm:block">
                interviewprep<span className="text-[#2563eb]">.guru</span>
              </span>
            </Link>

            {/* Center: nav links (desktop) — Twitter-style with bottom indicator */}
            <div className="hidden md:flex items-center h-full">
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`relative px-4 h-full flex items-center text-sm font-medium transition-colors ${
                      isActive
                        ? 'text-[#0f1419]'
                        : 'text-[#536471] hover:text-[#0f1419] hover:bg-[#f7f9f9]'
                    }`}
                  >
                    {link.label}
                    {/* Active indicator bar */}
                    {isActive && (
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[calc(100%-16px)] h-[3px] bg-[#2563eb] rounded-full" />
                    )}
                  </Link>
                )
              })}
              <Link
                href="/pricing"
                className={`relative px-4 h-full flex items-center text-sm font-medium transition-colors ${
                  pathname === '/pricing'
                    ? 'text-[#0f1419]'
                    : 'text-[#536471] hover:text-[#0f1419] hover:bg-[#f7f9f9]'
                }`}
              >
                Pricing
                {pathname === '/pricing' && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[calc(100%-16px)] h-[3px] bg-[#2563eb] rounded-full" />
                )}
              </Link>
            </div>

            {/* Right: xp + auth */}
            <div className="flex items-center gap-3">
              {isAuthenticated && <XpBadge />}
              <AuthMenu />
            </div>
          </div>
        </div>
      </nav>

      <div className={`flex-1 ${isAuthenticated ? 'pb-[56px] md:pb-0' : ''}`}>
        {children}
      </div>

      {/* Mobile bottom tab bar (authenticated only) */}
      {isAuthenticated && (
        <nav
          aria-label="Mobile navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-[56px] bg-white/90 backdrop-blur-xl border-t border-[#e1e8ed]/60"
        >
          <div className="flex items-center justify-around h-full px-2">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative flex flex-col items-center gap-0.5 py-1 px-3 transition-colors ${
                    isActive ? 'text-[#2563eb]' : 'text-[#8b98a5]'
                  }`}
                >
                  {/* Top indicator bar for mobile */}
                  {isActive && (
                    <span className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-[3px] bg-[#2563eb] rounded-full" />
                  )}
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={isActive ? 2.5 : 2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
                  </svg>
                  <span className="text-micro">{link.label}</span>
                </Link>
              )
            })}
            {/* More tab */}
            <button
              onClick={() => setMoreOpen(!moreOpen)}
              className={`flex flex-col items-center gap-0.5 py-1 px-3 transition-colors ${
                moreOpen ? 'text-[#2563eb]' : 'text-[#8b98a5]'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" />
              </svg>
              <span className="text-micro">More</span>
            </button>
          </div>

          {/* More bottom sheet */}
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-40 bg-black/10" onClick={() => setMoreOpen(false)} />
              <div className="absolute bottom-full left-0 right-0 z-50 bg-white border-t border-[#e1e8ed] rounded-t-2xl shadow-[var(--shadow-dropdown)] animate-slide-up">
                <div className="w-8 h-1 bg-[#e1e8ed] rounded-full mx-auto mt-2 mb-1" />
                {MORE_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMoreOpen(false)}
                    className="block px-6 py-3.5 text-sm text-[#0f1419] hover:bg-[#f7f9f9] transition-colors"
                  >
                    {link.label}
                  </Link>
                ))}
                <button
                  onClick={() => {
                    setMoreOpen(false)
                    try {
                      localStorage.removeItem('interviewConfig')
                      localStorage.removeItem('interviewData')
                      localStorage.removeItem('interviewActiveSession')
                    } catch { /* ignore */ }
                    signOut({ callbackUrl: '/' })
                  }}
                  className="w-full text-left px-6 py-3.5 text-sm text-[#f4212e] hover:bg-[#f7f9f9] transition-colors"
                >
                  Sign Out
                </button>
              </div>
            </>
          )}
        </nav>
      )}

      {/* Footer */}
      <Footer />

      {/* Badge unlock notifications */}
      {isAuthenticated && <BadgeUnlockChecker />}
    </>
  )
}
