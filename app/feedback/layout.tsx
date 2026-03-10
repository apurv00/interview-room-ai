import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Feedback',
  robots: { index: false },
}

export default function FeedbackLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
