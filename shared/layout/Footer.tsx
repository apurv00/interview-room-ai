'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Mic } from 'lucide-react'

// Pages where footer is hidden (full-screen experiences)
const HIDDEN_PREFIXES = ['/interview', '/lobby']

export default function Footer() {
  const pathname = usePathname()

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    return null
  }

  return (
    <footer className="bg-white border-t border-slate-200 py-8 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center gap-4">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <div className="w-6 h-6 rounded-lg bg-blue-600 flex items-center justify-center">
            <Mic className="w-3 h-3 text-white" />
          </div>
          <span className="text-[13px] font-semibold text-slate-600">
            interviewprep<span className="text-blue-600">.guru</span>
          </span>
        </Link>

        <nav aria-label="Footer links" className="flex gap-6 text-[12px] text-slate-400">
          <Link href="/resources" className="hover:text-slate-700 transition-colors">Resources</Link>
          <Link href="/pricing" className="hover:text-slate-700 transition-colors">Pricing</Link>
          <Link href="/privacy" className="hover:text-slate-700 transition-colors">Privacy</Link>
          <Link href="/terms" className="hover:text-slate-700 transition-colors">Terms</Link>
          <a href="mailto:contact@interviewprep.guru" className="hover:text-slate-700 transition-colors">Contact</a>
        </nav>

        <div className="text-[12px] text-slate-400">&copy; {new Date().getFullYear()} InterviewPrep.guru</div>
      </div>
    </footer>
  )
}
