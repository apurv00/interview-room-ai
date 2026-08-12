import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Apply — IPG Hire',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

/** Legacy request-target credentials are not accepted. New links use /apply#apply=…. */
export default function LegacyApplyPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8fafc] px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-[#e1e8ed] bg-white p-8 text-center">
        <div className="text-3xl">🔗</div>
        <h1 className="text-lg font-semibold text-[#0f1419]">
          This application link is no longer active
        </h1>
        <p className="text-sm text-[#536471]">
          Please contact the company for an updated application link.
        </p>
      </div>
    </main>
  )
}
