import type { Metadata } from 'next'

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const canonical = `/jobs/${encodeURIComponent(params.id)}`

  return {
    title: 'Job details',
    alternates: {
      canonical,
    },
    robots: {
      index: false,
      follow: false,
      googleBot: {
        index: false,
        follow: false,
      },
    },
  }
}

export default function JobDetailLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
