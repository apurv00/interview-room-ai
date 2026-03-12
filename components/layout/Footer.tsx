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

// Pages where footer is hidden (full-screen experiences)
const HIDDEN_PREFIXES = ['/interview', '/lobby']

export default function Footer() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  return (
    <footer className="border-t border-[rgba(255,255,255,0.06)] mt-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[#4b5563]">
          <span>&copy; {new Date().getFullYear()} Interview Prep Guru</span>
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-4">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="hover:text-[#b0b8c4] transition"
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
