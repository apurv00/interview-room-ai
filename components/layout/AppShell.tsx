'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import AuthMenu from './AuthMenu'
import Footer from './Footer'

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/history', label: 'History' },
  { href: '/progress', label: 'Progress' },
  { href: '/pricing', label: 'Pricing' },
]

// Pages where the shell is hidden (full-screen experience)
const HIDDEN_PATHS = ['/interview']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Hide shell on full-screen pages
  const isHidden = HIDDEN_PATHS.some((p) => pathname.startsWith(p))

  if (isHidden) {
    return <>{children}</>
  }

  return (
    <>
      <nav className="sticky top-0 z-50 bg-slate-950/80 backdrop-blur-lg border-b border-slate-800/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            {/* Left: brand */}
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                </svg>
              </div>
              <span className="text-sm font-bold text-white group-hover:text-indigo-400 transition hidden sm:block">
                Interview Prep Guru
              </span>
            </Link>

            {/* Center: nav links */}
            <div className="flex items-center gap-1">
              {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                      isActive
                        ? 'text-white bg-slate-800'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}
            </div>

            {/* Right: auth */}
            <AuthMenu />
          </div>
        </div>
      </nav>
      <div className="flex-1">{children}</div>
      <Footer />
    </>
  )
}
