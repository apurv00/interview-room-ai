import Link from 'next/link'
import type { Metadata } from 'next'
import { getResourcesByCategory } from '@learn/lib/resources'
import { siteConfig } from '@shared/siteConfig'
import JsonLd from '@shared/seo/JsonLd'

export const metadata: Metadata = {
  title: 'Interview Preparation Resources',
  description:
    'Free interview preparation resources: common questions, behavioral interview tips, STAR method guide, salary negotiation strategies, and more.',
  keywords: [
    'interview preparation resources',
    'interview questions',
    'interview tips',
    'STAR method',
    'behavioral interview',
    'mock interview guide',
  ],
  alternates: { canonical: `${siteConfig.url}/resources` },
}

const CATEGORIES = [
  { key: 'questions' as const, label: 'Interview Questions' },
  { key: 'tips' as const, label: 'Tips & Strategies' },
  { key: 'frameworks' as const, label: 'Frameworks & Practice' },
  { key: 'companies' as const, label: 'Company Guides' },
]

export default function ResourcesPage() {
  return (
    <main className="min-h-screen px-4 sm:px-6 py-12">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: 'Interview Preparation Resources',
          description: metadata.description,
          url: `${siteConfig.url}/resources`,
          publisher: { '@type': 'Organization', name: siteConfig.name },
        }}
      />

      <div className="max-w-[1100px] mx-auto">
        {/* Header */}
        <nav aria-label="Breadcrumb" className="text-caption text-[var(--foreground-tertiary)] mb-6">
          <Link href="/" className="hover:text-[#2563eb] transition-colors">Home</Link>
          <span className="mx-2">&rsaquo;</span>
          <span className="text-[var(--foreground-secondary)]">Resources</span>
        </nav>

        <h1 className="text-display text-[var(--foreground)]">Interview Preparation Resources</h1>
        <p className="text-body text-[var(--foreground-tertiary)] mt-3 max-w-[640px]">
          Everything you need to ace your next interview — from common questions and proven frameworks to salary negotiation strategies.
        </p>

        {/* Category Grid */}
        <div className="mt-section grid md:grid-cols-3 gap-section">
          {CATEGORIES.map((cat) => {
            const items = getResourcesByCategory(cat.key)
            return (
              <div key={cat.key}>
                <h2 className="step-label mb-4">{cat.label}</h2>
                <ul className="space-y-1">
                  {items.map((r) => (
                    <li key={r.slug}>
                      <Link
                        href={`/resources/${r.slug}`}
                        className="block py-2 px-3 rounded-[8px] hover:bg-[var(--color-surface)] transition-colors group"
                      >
                        <span className="text-subheading text-[var(--foreground)] group-hover:text-[#2563eb] transition-colors">
                          {r.title}
                        </span>
                        <p className="text-caption text-[var(--foreground-tertiary)] mt-0.5 line-clamp-2">
                          {r.description}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        {/* CTA */}
        <section className="mt-region text-center surface-card-bordered p-7">
          <h2 className="text-heading text-[var(--foreground)]">Ready to Put This Into Practice?</h2>
          <p className="text-body text-[var(--foreground-tertiary)] mt-2">
            Practice with our AI interviewer and get instant scored feedback on your answers.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center h-11 px-5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-[10px] text-sm font-medium transition-colors"
            >
              Start Practicing Free
            </Link>
            <Link
              href="/"
              className="inline-flex items-center justify-center h-11 px-5 bg-[var(--color-surface)] hover:bg-[var(--color-raised)] text-[var(--foreground-secondary)] rounded-[10px] text-sm font-medium transition-colors border border-[var(--color-border)]"
            >
              Try an Interview
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
