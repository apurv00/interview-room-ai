import type { Metadata } from 'next'
import HireRuntimeCompleteClient from './complete-client'

const DEFAULT_HIRE_CONTROL_URL = 'https://hire.interviewprep.guru'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Interview submitted | InterviewPrep Guru',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

function resolvedHireControlUrl(): string {
  try {
    const url = new URL(process.env.HIRE_CONTROL_URL || DEFAULT_HIRE_CONTROL_URL)
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      return DEFAULT_HIRE_CONTROL_URL
    }
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_HIRE_CONTROL_URL
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return DEFAULT_HIRE_CONTROL_URL
  }
}

export default function HireRuntimeCompletePage() {
  return <HireRuntimeCompleteClient controlUrl={resolvedHireControlUrl()} />
}
