'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const FOOTER_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/signin', label: 'Sign In' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
]

// Pages where footer is hidden (authenticated-only or full-screen experiences)
const HIDDEN_PREFIXES = ['/interview', '/lobby', '/feedback', '/history', '/progress', '/settings']

export default function Footer() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  return (
    <footer className="border-t border-slate-800/60 mt-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <span>&copy; {new Date().getFullYear()} Interview Prep Guru</span>
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-4">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="hover:text-slate-300 transition"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  )
}
