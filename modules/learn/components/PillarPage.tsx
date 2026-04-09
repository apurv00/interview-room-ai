import Link from 'next/link'
import type { Pillar } from '@learn/lib/pillars'
import { getResourceBySlug } from '@learn/lib/resources'
import { siteConfig } from '@shared/siteConfig'
import JsonLd from '@shared/seo/JsonLd'

interface Props {
  pillar: Pillar
}

export default function PillarPage({ pillar }: Props) {
  const pillarUrl = `${siteConfig.url}/learn/guides/${pillar.slug}`

  // Resolve spoke titles from resources.ts so we do not duplicate titles in pillars.ts
  const resolvedSpokes = pillar.spokes
    .map(s => {
      const resource = getResourceBySlug(s.slug)
      if (!resource) return null
      return { slug: s.slug, title: resource.title, blurb: s.blurb }
    })
    .filter((s): s is { slug: string; title: string; blurb: string } => s !== null)

  return (
    <main className="min-h-screen px-4 sm:px-6 py-12">
      {/* JSON-LD: CollectionPage */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: pillar.title,
          description: pillar.metaDescription,
          url: pillarUrl,
          publisher: { '@type': 'Organization', name: siteConfig.name },
        }}
      />

      {/* JSON-LD: BreadcrumbList */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
            { '@type': 'ListItem', position: 2, name: 'Resources', item: `${siteConfig.url}/learn/guides` },
            { '@type': 'ListItem', position: 3, name: pillar.title, item: pillarUrl },
          ],
        }}
      />

      {/* JSON-LD: FAQPage */}
      {pillar.faq.length > 0 && (
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: pillar.faq.map(f => ({
              '@type': 'Question',
              name: f.q,
              acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
          }}
        />
      )}

      <div className="max-w-[860px] mx-auto">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-caption text-[var(--foreground-tertiary)] mb-6">
          <Link href="/" className="hover:text-[#2563eb] transition-colors">Home</Link>
          <span className="mx-2">&rsaquo;</span>
          <Link href="/learn/guides" className="hover:text-[#2563eb] transition-colors">Resources</Link>
          <span className="mx-2">&rsaquo;</span>
          <span className="text-[var(--foreground-secondary)]">{pillar.title}</span>
        </nav>

        {/* Title + intro */}
        <h1 className="text-display text-[var(--foreground)]">{pillar.title}</h1>
        <p className="text-body text-[var(--foreground-tertiary)] mt-3 leading-relaxed">{pillar.intro}</p>

        {/* Sections */}
        <div className="mt-section space-y-section">
          {pillar.sections.map((section, i) => (
            <section key={i}>
              <h2 className="text-heading text-[var(--foreground)]">{section.heading}</h2>
              <p className="text-body text-[var(--foreground-secondary)] mt-2 leading-relaxed">{section.body}</p>
            </section>
          ))}
        </div>

        {/* Spokes grid */}
        <section className="mt-section">
          <h2 className="text-heading text-[var(--foreground)]">Guides in This Hub</h2>
          <div className="grid sm:grid-cols-2 gap-element mt-4">
            {resolvedSpokes.map(s => (
              <Link
                key={s.slug}
                href={`/learn/guides/${s.slug}`}
                className="surface-card-bordered p-5 hover:bg-[var(--color-surface)] transition-colors block"
              >
                <p className="text-subheading text-[var(--foreground)]">{s.title}</p>
                <p className="text-caption text-[var(--foreground-tertiary)] mt-1.5 leading-relaxed">{s.blurb}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* FAQ */}
        {pillar.faq.length > 0 && (
          <section className="mt-section">
            <h2 className="text-heading text-[var(--foreground)]">Frequently Asked Questions</h2>
            <div className="mt-3 space-y-element">
              {pillar.faq.map((faq, i) => (
                <details key={i} className="surface-card-bordered p-4 group">
                  <summary className="text-subheading text-[var(--foreground)] cursor-pointer list-none flex items-center justify-between">
                    {faq.q}
                    <svg className="w-4 h-4 text-[var(--foreground-tertiary)] transition-transform group-open:rotate-180 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <p className="text-body text-[var(--foreground-secondary)] mt-3">{faq.a}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="mt-region text-center surface-card-bordered p-7">
          <h2 className="text-heading text-[var(--foreground)]">Put This Into Practice</h2>
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
              href="/learn/guides"
              className="inline-flex items-center justify-center h-11 px-5 bg-[var(--color-surface)] hover:bg-[var(--color-raised)] text-[var(--foreground-secondary)] rounded-[10px] text-sm font-medium transition-colors border border-[var(--color-border)]"
            >
              Browse All Resources
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
