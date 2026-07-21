import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: { default: 'Jobs | Interview Prep Guru', template: '%s | Jobs' },
  description:
    'Browse live job postings, save roles, practice from the job description, and track the application status you record.',
}

export default function JobsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
