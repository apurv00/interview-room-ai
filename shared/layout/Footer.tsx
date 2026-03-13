'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Pages where footer is hidden (full-screen experiences)
const HIDDEN_PREFIXES = ['/interview', '/lobby']

const PRODUCT_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/practice', label: 'Practice Sets' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/resources', label: 'Resources' },
  { href: '/signup', label: 'Get Started' },
]

const TOOLS_LINKS = [
  { href: '/resume', label: 'Resume Builder' },
  { href: '/resume/tailor', label: 'Resume Tailor' },
  { href: '/resume/ats-check', label: 'ATS Checker' },
  { href: '/resume/templates', label: 'Resume Templates' },
  { href: '/hire', label: 'For Recruiters' },
]

const QUESTION_LINKS = [
  { href: '/resources/common-interview-questions', label: 'Common Questions' },
  { href: '/resources/behavioral-questions', label: 'Behavioral Questions' },
  { href: '/resources/technical-interview-questions', label: 'Technical Questions' },
  { href: '/resources/mock-interview-guide', label: 'Mock Interview Guide' },
  { href: '/resources/interview-readiness-quiz', label: 'Readiness Quiz' },
]

const TIP_LINKS = [
  { href: '/resources/interview-tips', label: '50+ Interview Tips' },
  { href: '/resources/phone-interview-tips', label: 'Phone Tips' },
  { href: '/resources/video-interview-tips', label: 'Video Tips' },
  { href: '/resources/star-method-guide', label: 'STAR Method Guide' },
  { href: '/resources/body-language-guide', label: 'Body Language' },
  { href: '/resources/interview-frameworks', label: 'Frameworks' },
]

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <h3 className="step-label mb-3">{title}</h3>
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Footer() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  return (
    <footer className="border-t border-[var(--color-border-subtle)] mt-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-10">
        {/* Columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8">
          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Tools" links={TOOLS_LINKS} />
          <FooterColumn title="Interview Questions" links={QUESTION_LINKS} />
          <FooterColumn title="Tips & Frameworks" links={TIP_LINKS} />
        </div>

        {/* Bottom bar */}
        <div className="border-t border-[var(--color-border-subtle)] pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--foreground-muted)]">
          <span>&copy; {new Date().getFullYear()} Interview Prep Guru</span>
          <nav aria-label="Legal" className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-[var(--foreground-secondary)] transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-[var(--foreground-secondary)] transition-colors">Terms</Link>
            <Link href="/signin" className="hover:text-[var(--foreground-secondary)] transition-colors">Sign In</Link>
          </nav>
        </div>
      </div>
    </footer>
  )
}
