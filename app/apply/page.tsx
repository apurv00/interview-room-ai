import type { Metadata } from 'next'
import ApplyClient from './ApplyClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Apply — IPG Hire',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function ApplyPage() {
  return <ApplyClient />
}
