/**
 * The page our crawler's User-Agent links to (DECISIONS #9: honest branded
 * UA with a contact URL is part of the invited-access legal posture).
 * Server component, static, no client JS.
 */
export const metadata = {
  title: 'InterviewPrepGuruBot | Interview Prep Guru',
  robots: { index: false },
}

export default function JobsBotPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-slate-900">
      <h1 className="text-2xl font-semibold">InterviewPrepGuruBot</h1>
      <p className="mt-4 text-sm leading-6 text-slate-600">
        This is the crawler for Interview Prep Guru&apos;s job feed. It reads
        publicly advertised sitemaps and public APIs to help candidates
        discover live job postings, and always links applicants back to the
        original source to apply — we never take applications ourselves.
      </p>
      <ul className="mt-4 list-disc pl-5 text-sm leading-6 text-slate-600">
        <li>We obey robots.txt and only read invited surfaces.</li>
        <li>Polite cadence: roughly once per day per source, rate-limited.</li>
        <li>Recruiter contact details are stripped, never stored or shown.</li>
        <li>Applicants are sent to your site — we drive traffic, not scrape leads.</li>
      </ul>
      <p className="mt-4 text-sm leading-6 text-slate-600">
        Source owner with a question or an objection? Email{' '}
        <a className="text-blue-600 underline" href="mailto:abhishek.apurv00@gmail.com">
          abhishek.apurv00@gmail.com
        </a>{' '}
        and we&apos;ll respond same-day; removal requests are honored immediately.
      </p>
    </main>
  )
}
