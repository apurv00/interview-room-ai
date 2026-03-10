import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Interview Room',
  robots: { index: false },
}

export default function InterviewLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
