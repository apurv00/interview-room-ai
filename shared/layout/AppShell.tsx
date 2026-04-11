'use client'

import { useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { Mic, Menu, X } from 'lucide-react'
import AuthMenu from './AuthMenu'
import Footer from './Footer'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const NAV_LINKS = [
  { href: '/interview/setup', label: 'Interview' },
  { href: '/learn/pathway', label: 'Pathway' },
  { href: '/resume', label: 'Resume' },
  { href: '/history', label: 'History' },
  { href: '/resources', label: 'Resources' },
  { href: '/pricing', label: 'Pricing' },
]

// Pages where the shell is hidden (full-screen experience).
// /interview/setup is intentionally NOT hidden — it shows the standard nav.
// Only the interview lobby/room itself (/interview, /interview/[id]) is full-screen.
const HIDDEN_PATHS = ['/signin', '/signup']
const INTERVIEW_ALLOW_NAV = ['/interview/setup']

interface AppShellProps {
  children: ReactNode
  /**
   * Optional element rendered in the desktop nav next to AuthMenu when the
   * user is authenticated. Used by the composition root (app/layout.tsx) to
   * inject domain-owned widgets (e.g. XP badge from the learn module) without
   * pulling a module dependency into the shared layout.
   */
  navAuthExtras?: ReactNode
  /**
   * Optional global widgets (toasts, pollers, etc.) rendered when the user
   * is authenticated. Keeps domain-specific global UX out of shared/.
   */
  authedGlobalWidgets?: ReactNode
}

export default function AppShell({
  children,
  navAuthExtras,
  authedGlobalWidgets,
}: AppShellProps) {
  const pathname = usePathname()
  const { status } = useSession()
  const { open: openAuthGate } = useAuthGate()
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
        className="fixed top-0 left-0 right-0 w-full bg-white/85 backdrop-blur-xl z-50 border-b border-slate-200/60"
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
                    {navAuthExtras}
                    <AuthMenu />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => openAuthGate('generic')}
                      className="text-[13px] font-medium text-slate-600 hover:text-slate-900 transition-colors px-2"
                    >
                      Sign in
                    </button>
                    <button
                      type="button"
                      onClick={() => openAuthGate('generic')}
                      className="px-4 py-2 rounded-full text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/20 transition-all"
                    >
                      Get started
                    </button>
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
                    <button
                      type="button"
                      onClick={() => { setIsMobileMenuOpen(false); openAuthGate('generic') }}
                      className="block w-full px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg text-center"
                    >
                      Sign in
                    </button>
                    <button
                      type="button"
                      onClick={() => { setIsMobileMenuOpen(false); openAuthGate('generic') }}
                      className="block w-full px-3 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg text-center"
                    >
                      Get started
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* pt-[68px] compensates for the now-fixed nav (h-[68px]) so children
          don't slide underneath. Sticky was unreliable on iOS Safari with
          backdrop-blur ancestors. */}
      <div className="flex-1 pt-[68px]">{children}</div>

      {/* Footer */}
      <Footer />

      {/* Injected global widgets (e.g. badge unlock notifications) */}
      {isAuthenticated && authedGlobalWidgets}
    </>
  )
}
