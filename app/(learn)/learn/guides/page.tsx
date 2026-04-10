import Link from 'next/link'
import type { Metadata } from 'next'
import StartCta from '@shared/ui/StartCta'
import { RESOURCES, getResourcesByCategory } from '@learn/lib/resources'
import { PILLARS } from '@learn/lib/pillars'
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
  alternates: { canonical: '/learn/guides' },
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
          url: `${siteConfig.url}/learn/guides`,
          publisher: { '@type': 'Organization', name: siteConfig.name },
        }}
      />

      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
            { '@type': 'ListItem', position: 2, name: 'Resources', item: `${siteConfig.url}/learn/guides` },
          ],
        }}
      />

      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <nav aria-label="Breadcrumb" className="text-caption text-[#71767b] mb-6">
          <Link href="/" className="hover:text-[#2563eb] transition-colors">Home</Link>
          <span className="mx-2">&rsaquo;</span>
          <span className="text-[#536471]">Resources</span>
        </nav>

        <h1 className="text-display text-[#0f1419]">Interview Preparation Resources</h1>
        <p className="text-body text-[#71767b] mt-3 max-w-2xl">
          Everything you need to ace your next interview — from common questions and proven frameworks to salary negotiation strategies.
        </p>

        {/* Topic Hubs — primary entry points into the hub-and-spoke architecture */}
        <section className="mt-section">
          <h2 className="text-heading text-[var(--foreground)] mb-4">Topic Hubs</h2>
          <div className="grid sm:grid-cols-3 gap-element">
            {PILLARS.map((pillar) => (
              <Link
                key={pillar.slug}
                href={`/learn/guides/${pillar.slug}`}
                className="surface-card-bordered p-5 hover:bg-[var(--color-surface)] transition-colors block"
              >
                <p className="text-subheading text-[var(--foreground)]">{pillar.title}</p>
                <p className="text-caption text-[var(--foreground-tertiary)] mt-1.5 leading-relaxed line-clamp-3">
                  {pillar.metaDescription}
                </p>
              </Link>
            ))}
          </div>
        </section>

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
                        href={`/learn/guides/${r.slug}`}
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
          <h2 className="text-heading text-[#0f1419]">Ready to Put This Into Practice?</h2>
          <p className="text-body text-[#71767b] mt-2">
            Practice with our AI interviewer and get instant scored feedback on your answers.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <StartCta className="inline-flex items-center justify-center h-11 px-5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-[10px] text-sm font-medium transition-colors">
              Start Practicing Free
            </StartCta>
            <Link
              href="/"
              className="inline-flex items-center justify-center h-11 px-5 bg-[#f8fafc] hover:bg-[#eff3f4] text-[#536471] rounded-[10px] text-sm font-medium transition-colors border border-[#e1e8ed]"
            >
              Try an Interview
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
