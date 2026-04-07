'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { Mic, Menu, X } from 'lucide-react'
import AuthMenu from './AuthMenu'
import Footer from './Footer'
import XpBadge from '@learn/components/XpBadge'
import BadgeUnlockChecker from '@learn/components/BadgeUnlockChecker'

const NAV_LINKS = [
  { href: '/interview/setup', label: 'Interview' },
  { href: '/resume', label: 'Resume' },
  { href: '/history', label: 'History' },
  { href: '/learn/progress', label: 'Progress' },
  { href: '/resources', label: 'Resources' },
  { href: '/pricing', label: 'Pricing' },
]

// Pages where the shell is hidden (full-screen experience).
// /interview/setup is intentionally NOT hidden — it shows the standard nav.
// Only the interview lobby/room itself (/interview, /interview/[id]) is full-screen.
const HIDDEN_PATHS = ['/signin', '/signup']
const INTERVIEW_ALLOW_NAV = ['/interview/setup']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { status } = useSession()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const isAuthenticated = status === 'authenticated'

  // Hide shell on full-screen pages
  const isInterviewRoute = pathname.startsWith('/interview') && !INTERVIEW_ALLOW_NAV.includes(pathname)
  const isHidden = isInterviewRoute || HIDDEN_PATHS.some((p) => pathname.startsWith(p))
  if (isHidden) return <>{children}</>

  const handleSignOut = () => {
    setIsMobileMenuOpen(false)
    try {
      localStorage.removeItem('interviewConfig')
      localStorage.removeItem('interviewData')
      localStorage.removeItem('interviewActiveSession')
    } catch { /* ignore */ }
    signOut({ callbackUrl: '/' })
  }

  return (
    <>
      <nav
        aria-label="Main navigation"
        className="sticky top-0 w-full bg-white/85 backdrop-blur-xl z-50 border-b border-slate-200/60"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-[68px]">
            {/* Brand */}
            <Link href="/" className="flex items-center gap-2.5 no-underline group">
              <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm shadow-blue-600/20 transition-transform duration-200 group-hover:scale-105">
                <Mic className="w-[18px] h-[18px] text-white" />
              </div>
              <span className="font-bold text-[17px] tracking-tight text-slate-900">
                interviewprep<span className="text-blue-600">.guru</span>
              </span>
            </Link>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center gap-1">
              {NAV_LINKS.map((link) => {
                const isActive =
                  pathname === link.href ||
                  (link.href !== '/' && pathname.startsWith(link.href + '/'))
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`px-3.5 py-2 rounded-full text-[13px] font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}

              <div className="ml-3 pl-3 border-l border-slate-200 flex items-center gap-3">
                {isAuthenticated ? (
                  <>
                    <XpBadge />
                    <AuthMenu />
                  </>
                ) : (
                  <>
                    <Link
                      href="/signin"
                      className="text-[13px] font-medium text-slate-600 hover:text-slate-900 transition-colors px-2"
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/signup"
                      className="px-4 py-2 rounded-full text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/20 transition-all"
                    >
                      Get started
                    </Link>
                  </>
                )}
              </div>
            </div>

            {/* Mobile menu toggle */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden -mr-2 p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100/70 transition"
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200/60 bg-white">
            <div className="px-4 py-3 space-y-1">
              {NAV_LINKS.map((link) => {
                const isActive =
                  pathname === link.href ||
                  (link.href !== '/' && pathname.startsWith(link.href + '/'))
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={`block px-3 py-2.5 text-sm font-medium rounded-lg transition-colors ${
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}
              <div className="pt-3 mt-3 border-t border-slate-100">
                {isAuthenticated ? (
                  <>
                    <Link
                      href="/settings"
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="block px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg"
                    >
                      Settings
                    </Link>
                    <button
                      onClick={handleSignOut}
                      className="block w-full text-left px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-slate-50 rounded-lg"
                    >
                      Sign Out
                    </button>
                  </>
                ) : (
                  <div className="space-y-2">
                    <Link
                      href="/signin"
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="block px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg text-center"
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/signup"
                      onClick={() => setIsMobileMenuOpen(false)}
                      className="block px-3 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg text-center"
                    >
                      Get started
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>

      <div className="flex-1">{children}</div>

      {/* Footer */}
      <Footer />

      {/* Badge unlock notifications */}
      {isAuthenticated && <BadgeUnlockChecker />}
    </>
  )
}
