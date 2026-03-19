'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import AuthMenu from './AuthMenu'
import ThemeToggle from '../ui/ThemeToggle'
import Footer from './Footer'
import XpBadge from '@learn/components/XpBadge'
import BadgeUnlockChecker from '@learn/components/BadgeUnlockChecker'

const NAV_LINKS = [
  { href: '/', label: 'Home', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { href: '/learn/practice', label: 'Practice', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  { href: '/resume', label: 'Resume', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { href: '/history', label: 'History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { href: '/learn/progress', label: 'Progress', icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' },
]

const MORE_LINKS = [
  { href: '/resume', label: 'Resume Tools' },
  { href: '/learn/badges', label: 'Badges' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/settings', label: 'Settings' },
]

// Pages where the shell is hidden (full-screen experience)
const HIDDEN_PATHS = ['/interview']

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
      <nav aria-label="Main navigation" className="sticky top-0 z-50 h-[52px] bg-card border-b border-[rgba(255,255,255,0.06)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-full">
          <div className="flex items-center justify-between h-full">
            {/* Left: brand */}
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-[6px] bg-[#6366f1] flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              </div>
              <span className="text-sm font-bold text-[#f0f2f5] group-hover:text-[#818cf8] transition hidden sm:block">
                Interview Prep Guru
              </span>
            </Link>

            {/* Center: nav links (desktop) */}
            <div className="hidden md:flex items-center gap-1">
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`px-3 py-1.5 rounded-[6px] text-sm font-medium transition-all duration-[120ms] ${
                      isActive
                        ? 'text-[#f0f2f5] bg-surface'
                        : 'text-[#6b7280] hover:text-[#b0b8c4] hover:bg-surface/50'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}
              <Link
                href="/pricing"
                className={`px-3 py-1.5 rounded-[6px] text-sm font-medium transition-all duration-[120ms] ${
                  pathname === '/pricing'
                    ? 'text-[#f0f2f5] bg-surface'
                    : 'text-[#6b7280] hover:text-[#b0b8c4] hover:bg-surface/50'
                }`}
              >
                Pricing
              </Link>
            </div>

            {/* Right: theme + xp + auth */}
            <div className="flex items-center gap-2">
              <ThemeToggle />
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
          className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-[56px] bg-card border-t border-[rgba(255,255,255,0.06)]"
        >
          <div className="flex items-center justify-around h-full px-2">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`flex flex-col items-center gap-0.5 py-1 px-3 transition-colors ${
                    isActive ? 'text-[#818cf8]' : 'text-[#4b5563]'
                  }`}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
                moreOpen ? 'text-[#818cf8]' : 'text-[#4b5563]'
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
              <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
              <div className="absolute bottom-full left-0 right-0 z-50 bg-card border-t border-[rgba(255,255,255,0.06)] shadow-md animate-fade-in">
                {MORE_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMoreOpen(false)}
                    className="block px-6 py-3.5 text-sm text-[#b0b8c4] hover:bg-surface transition-colors"
                  >
                    {link.label}
                  </Link>
                ))}
                <button
                  onClick={() => { setMoreOpen(false); signOut({ callbackUrl: '/' }) }}
                  className="w-full text-left px-6 py-3.5 text-sm text-[#f87171] hover:bg-surface transition-colors"
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
