import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Interview History',
  robots: { index: false },
}

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
