import type { Metadata } from 'next'
import { resolveApplyToken } from '@hire'
import ApplyForm from './ApplyForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Apply — IPG Hire',
  // Never indexed: a shared apply link is semi-private, and search
  // engines must not turn one into a permanent public record.
  robots: { index: false, follow: false },
}

/**
 * Public application page: /apply/[token]
 *
 * Server component — the token is resolved server-side before anything
 * renders, and EVERY failure (bad token, link disabled, job closed) shows
 * the same generic page, so the URL space cannot be probed for which
 * employers or jobs exist.
 */
export default async function ApplyPage({ params }: { params: { token: string } }) {
  const view = await resolveApplyToken(params.token)

  if (!view) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
        <div className="max-w-md w-full bg-white border border-[#e1e8ed] rounded-2xl p-8 text-center space-y-3">
          <div className="text-3xl">🔗</div>
          <h1 className="text-lg font-semibold text-[#0f1419]">
            This application link is no longer active
          </h1>
          <p className="text-sm text-[#536471]">
            The role may have closed or the link may have been replaced. Please contact
            the company for an up-to-date link.
          </p>
        </div>
      </main>
    )
  }

  const { job, workspaceName } = view

  return (
    <main className="min-h-screen bg-[#f8fafc] px-4 py-10">
      <div className="max-w-lg mx-auto space-y-6">
        <header className="text-center space-y-1">
          <p className="text-xs uppercase tracking-wide text-[#71767b]">{workspaceName}</p>
          <h1 className="text-xl font-bold text-[#0f1419]">{job.title}</h1>
          <p className="text-sm text-[#536471]">Apply with your résumé — it takes a minute.</p>
        </header>

        <ApplyForm token={params.token} />

        <p className="text-xs text-[#71767b] text-center leading-relaxed">
          By applying you agree that your name, contact details and résumé are shared
          with {workspaceName} for this role, and may be reviewed with AI assistance.
          See our{' '}
          <a href="/privacy" className="text-[#2563eb]">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </main>
  )
}
