import { notFound } from 'next/navigation'
import Link from 'next/link'
import { isFeatureEnabled } from '@shared/featureFlags'

export const dynamic = 'force-dynamic'

/**
 * /jobs — the feed shell (Wave 1c scaffold). Renders 404 while the
 * jobs_tab flag is off, so shipping this scaffold is byte-invisible in
 * production. The Wave-3 feed replaces the empty state below; the page is
 * a server component so the flag reads real env, and the public-surface
 * posture (P-2: anon browse) is already wired in middleware.
 */
export default function JobsPage() {
  if (!isFeatureEnabled('jobs_tab')) notFound()

  return (
    <main className="mx-auto max-w-3xl px-4 py-16" aria-label="Job feed">
      <h1 className="text-2xl font-semibold">Jobs picked for your readiness</h1>
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
        Your feed is warming up — fresh postings are being gathered. In the
        meantime, the fastest way to sharpen your matches is a resume.
      </p>
      <div className="mt-8 rounded-xl border border-dashed p-6">
        <p className="font-medium">Attach your resume — we&apos;ll sort jobs for you.</p>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Matching reads your skills and target role. No resume yet? Build one in minutes.
        </p>
        <div className="mt-4 flex gap-3">
          <Link
            href="/resume/builder?return=/jobs"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Build my resume
          </Link>
          <Link
            href="/resume"
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            I already have one
          </Link>
        </div>
      </div>
    </main>
  )
}
