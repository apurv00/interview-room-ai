import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: { default: 'Jobs | Interview Prep Guru', template: '%s | Jobs' },
  description:
    'Personalized job matches with readiness signals — see how prepared you are, practice for the role, and apply with confidence.',
}

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
