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

// Pages where the shell is hidden (full-screen experience)
const HIDDEN_PATHS = ['/interview', '/signin', '/signup']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { status } = useSession()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const isAuthenticated = status === 'authenticated'

  // Hide shell on full-screen pages
  const isHidden = HIDDEN_PATHS.some((p) => pathname.startsWith(p))
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
      <nav aria-label="Main navigation" className="sticky top-0 w-full bg-white/80 backdrop-blur-md z-50 border-b border-slate-200/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Brand */}
            <Link href="/" className="flex items-center gap-2 no-underline">
              <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center">
                <Mic className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-lg tracking-tight text-slate-800">
                interviewprep<span className="text-blue-600">.guru</span>
              </span>
            </Link>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center gap-6">
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`text-[13px] font-medium transition-colors ${
                      isActive ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}

              <div className="ml-2 flex items-center gap-3">
                {isAuthenticated && <XpBadge />}
                <AuthMenu />
              </div>
            </div>

            {/* Mobile menu toggle */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden text-slate-500 hover:text-slate-800"
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 bg-white">
            <div className="px-4 py-3 space-y-1">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="block px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg"
                >
                  {link.label}
                </Link>
              ))}
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
                  <Link
                    href="/signin"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className="block px-3 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg text-center"
                  >
                    Sign In
                  </Link>
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
