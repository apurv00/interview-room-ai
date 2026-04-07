'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Mic } from 'lucide-react'
import StartCta from '@shared/ui/StartCta'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

// Pages where footer is hidden (full-screen experiences)
const HIDDEN_PREFIXES = ['/interview', '/lobby']

// "Get Started" lives outside this list so it can be rendered as a
// <StartCta> that respects auth state — see <FooterColumn extraCta={...}/>
// in the Product column below.
const PRODUCT_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/interview/setup', label: 'Interview' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/resources', label: 'Resources' },
]

const TOOLS_LINKS = [
  { href: '/resume', label: 'Resume Builder' },
  { href: '/resume/tailor', label: 'Resume Tailor' },
  { href: '/resume/ats-check', label: 'ATS Checker' },
  { href: '/resume/templates', label: 'Resume Templates' },
  { href: '/hire', label: 'For Recruiters' },
]

const QUESTION_LINKS = [
  { href: '/learn/guides/common-interview-questions', label: 'Common Questions' },
  { href: '/learn/guides/behavioral-questions', label: 'Behavioral Questions' },
  { href: '/learn/guides/technical-interview-questions', label: 'Technical Questions' },
  { href: '/learn/guides/mock-interview-guide', label: 'Mock Interview Guide' },
  { href: '/learn/guides/interview-readiness-quiz', label: 'Readiness Quiz' },
]

const TIP_LINKS = [
  { href: '/learn/guides/interview-tips', label: '50+ Interview Tips' },
  { href: '/learn/guides/phone-interview-tips', label: 'Phone Tips' },
  { href: '/learn/guides/video-interview-tips', label: 'Video Tips' },
  { href: '/learn/guides/star-method-guide', label: 'STAR Method Guide' },
  { href: '/learn/guides/body-language-guide', label: 'Body Language' },
  { href: '/learn/guides/interview-frameworks', label: 'Frameworks' },
]

function FooterColumn({
  title,
  links,
  extraCta,
}: {
  title: string
  links: { href: string; label: string }[]
  extraCta?: React.ReactNode
}) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-4">{title}</h3>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
        {extraCta && <li>{extraCta}</li>}
      </ul>
    </div>
  )
}

export default function Footer() {
  const pathname = usePathname()
  const { open: openAuthGate } = useAuthGate()

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  return (
    <footer className="bg-white border-t border-slate-200 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Top: brand + columns */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-10">
          {/* Brand column */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2 no-underline mb-3">
              <div className="w-7 h-7 rounded-xl bg-blue-600 flex items-center justify-center">
                <Mic className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="font-bold text-[15px] tracking-tight text-slate-800">
                interviewprep<span className="text-blue-600">.guru</span>
              </span>
            </Link>
            <p className="text-[12px] text-slate-400 leading-relaxed max-w-[200px]">
              AI-powered interview coaching with face, voice, and content analysis.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={PRODUCT_LINKS}
            extraCta={
              <StartCta className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
                Get Started
              </StartCta>
            }
          />
          <FooterColumn title="Tools" links={TOOLS_LINKS} />
          <FooterColumn title="Interview Questions" links={QUESTION_LINKS} />
          <FooterColumn title="Tips & Frameworks" links={TIP_LINKS} />
        </div>

        {/* Bottom bar */}
        <div className="border-t border-slate-100 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-[12px] text-slate-400">
            &copy; {new Date().getFullYear()} InterviewPrep.guru
          </div>
          <nav aria-label="Legal" className="flex items-center gap-6 text-[12px] text-slate-400">
            <Link href="/privacy" className="hover:text-slate-700 transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-700 transition-colors">Terms</Link>
            <a href="mailto:contact@interviewprep.guru" className="hover:text-slate-700 transition-colors">Contact</a>
            <button
              type="button"
              onClick={() => openAuthGate('generic')}
              className="hover:text-slate-700 transition-colors"
            >
              Sign In
            </button>
          </nav>
        </div>
      </div>
    </footer>
  )
}
