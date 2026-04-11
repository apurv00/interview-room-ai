import Link from 'next/link'
import type { Metadata } from 'next'
import { Home, ArrowRight, FileText, BookOpen, Mic } from 'lucide-react'
import { siteConfig } from '@shared/siteConfig'

export const metadata: Metadata = {
  title: 'Page not found',
  description: `The page you're looking for doesn't exist. Explore ${siteConfig.name}'s interview practice, resume tools, and guides.`,
  robots: { index: false, follow: false },
}

/** Branded 404 rendered by Next.js for any unmatched route. Replaces the
 *  bare framework default that QA Run 2 flagged (Issue #8). */
export default function NotFound() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-2xl text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 border border-blue-100 text-blue-600 text-[11px] font-semibold uppercase tracking-wider mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
          404 · Page not found
        </div>

        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-slate-900 leading-[1.1] mb-4">
          This page took a <span className="text-blue-600">wrong turn</span>.
        </h1>

        <p className="text-base text-slate-500 leading-relaxed max-w-lg mx-auto mb-8">
          The link might be broken, the page might have moved, or you might have mistyped the URL. Either way — here are some places to pick up where you left off.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 text-[14px] font-semibold rounded-full bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20 transition-all"
          >
            <Home className="w-4 h-4" />
            Back to home
          </Link>
          <Link
            href="/interview/setup"
            className="inline-flex items-center gap-2 px-6 py-3 text-[14px] font-semibold rounded-full bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Start an interview
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid sm:grid-cols-3 gap-3 text-left">
          <Link
            href="/resume"
            className="group flex items-start gap-3 p-4 rounded-2xl bg-white border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-100 transition-colors">
              <FileText className="w-4 h-4 text-blue-600" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">Resume tools</div>
              <div className="text-xs text-slate-500 mt-0.5">Builder, tailor, ATS check</div>
            </div>
          </Link>

          <Link
            href="/learn/guides"
            className="group flex items-start gap-3 p-4 rounded-2xl bg-white border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-100 transition-colors">
              <BookOpen className="w-4 h-4 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">Interview guides</div>
              <div className="text-xs text-slate-500 mt-0.5">26+ free articles</div>
            </div>
          </Link>

          <Link
            href="/pricing"
            className="group flex items-start gap-3 p-4 rounded-2xl bg-white border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0 group-hover:bg-emerald-100 transition-colors">
              <Mic className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">Pricing</div>
              <div className="text-xs text-slate-500 mt-0.5">Free, Pro, Enterprise</div>
            </div>
          </Link>
        </div>

        <p className="mt-10 text-xs text-slate-400">
          Still stuck? <a href="mailto:support@interviewprep.guru" className="text-blue-600 hover:underline">Email support</a>
        </p>
      </div>
    </div>
  )
}
