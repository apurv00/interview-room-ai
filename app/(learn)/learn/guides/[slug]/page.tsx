import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getResourceBySlug, RESOURCES } from '@learn/lib/resources'
import { getPillarTitle } from '@learn/lib/pillars'
import { siteConfig } from '@shared/siteConfig'
import JsonLd from '@shared/seo/JsonLd'

interface Props {
  params: { slug: string }
}

export default function ResourcePage({ params }: Props) {
  const resource = getResourceBySlug(params.slug)
  if (!resource) return notFound()

  // Get related resources (same category, excluding current)
  const related = RESOURCES
    .filter(r => r.slug !== resource.slug && r.category === resource.category)
    .slice(0, 3)

  // If fewer than 3 in same category, fill from other categories
  if (related.length < 3) {
    const others = RESOURCES
      .filter(r => r.slug !== resource.slug && r.category !== resource.category)
      .slice(0, 3 - related.length)
    related.push(...others)
  }

  return (
    <main className="min-h-screen px-4 sm:px-6 py-12">
      {/* JSON-LD: FAQPage */}
      {resource.content.faq.length > 0 && (
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: resource.content.faq.map(f => ({
              '@type': 'Question',
              name: f.q,
              acceptedAnswer: {
                '@type': 'Answer',
                text: f.a,
              },
            })),
          }}
        />
      )}

      {/* JSON-LD: Article */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: resource.title,
          description: resource.description,
          author: { '@type': 'Organization', name: siteConfig.name },
          publisher: { '@type': 'Organization', name: siteConfig.name },
          datePublished: '2026-01-15',
          dateModified: '2026-03-12',
          url: `${siteConfig.url}/learn/guides/${resource.slug}`,
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
            { '@type': 'ListItem', position: 3, name: resource.title, item: `${siteConfig.url}/learn/guides/${resource.slug}` },
          ],
        }}
      />

      {/* JSON-LD: HowTo (STAR method only) */}
      {resource.slug === 'star-method-guide' && resource.howToSteps && (
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: resource.title,
            description: resource.description,
            step: resource.howToSteps.map((s, i) => ({
              '@type': 'HowToStep',
              position: i + 1,
              name: s.name,
              text: s.text,
            })),
          }}
        />
      )}

      <div className="max-w-3xl mx-auto">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-caption text-[var(--foreground-tertiary)] mb-6">
          <Link href="/" className="hover:text-[#2563eb] transition-colors">Home</Link>
          <span className="mx-2">&rsaquo;</span>
          <Link href="/learn/guides" className="hover:text-[#2563eb] transition-colors">Resources</Link>
          <span className="mx-2">&rsaquo;</span>
          <span className="text-[var(--foreground-secondary)]">{resource.title}</span>
        </nav>

        {/* Pillar backlink (hub-and-spoke mesh) */}
        {resource.pillarSlug && (
          <p className="text-caption text-[var(--foreground-tertiary)] mb-2">
            Part of:{' '}
            <Link
              href={`/learn/guides/${resource.pillarSlug}`}
              className="text-[#2563eb] hover:underline"
            >
              {getPillarTitle(resource.pillarSlug)}
            </Link>
          </p>
        )}

        {/* Title */}
        <h1 className="text-display text-[var(--foreground)]">{resource.title}</h1>
        <p className="text-body text-[var(--foreground-tertiary)] mt-3 max-w-2xl">
          {resource.content.intro}
        </p>

        {/* Content sections */}
        <div className="mt-section space-y-section">
          {resource.content.sections.map((section, i) => (
            <section key={i}>
              <h2 className="text-heading text-[var(--foreground)]">{section.heading}</h2>
              <div className="text-body text-[var(--foreground-secondary)] mt-2 leading-relaxed whitespace-pre-line">
                {section.body}
              </div>
              {section.links && section.links.length > 0 && (
                <p className="mt-3 text-caption text-[var(--foreground-tertiary)]">
                  Related:{' '}
                  {section.links.map((link, j) => (
                    <span key={link.href}>
                      <Link
                        href={link.href}
                        className="text-[#2563eb] hover:underline"
                      >
                        {link.text}
                      </Link>
                      {j < section.links!.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                </p>
              )}
            </section>
          ))}
        </div>

        {/* Tips */}
        {resource.content.tips.length > 0 && (
          <section className="mt-section">
            <h2 className="text-heading text-[var(--foreground)]">Key Tips</h2>
            <ul className="mt-3 space-y-2">
              {resource.content.tips.map((tip, i) => (
                <li key={i} className="flex gap-3 text-body text-[var(--foreground-secondary)]">
                  <span className="text-[#2563eb] font-bold flex-shrink-0">&bull;</span>
                  {tip}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* FAQ */}
        {resource.content.faq.length > 0 && (
          <section className="mt-section">
            <h2 className="text-heading text-[var(--foreground)]">Frequently Asked Questions</h2>
            <div className="mt-3 space-y-element">
              {resource.content.faq.map((faq, i) => (
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

        {/* Related Resources */}
        {related.length > 0 && (
          <section className="mt-region">
            <h2 className="text-heading text-[var(--foreground)]">Related Resources</h2>
            <div className="grid sm:grid-cols-3 gap-element mt-3">
              {related.map(r => (
                <Link
                  key={r.slug}
                  href={`/learn/guides/${r.slug}`}
                  className="surface-card p-4 hover:bg-[var(--color-surface)] transition-colors"
                >
                  <p className="text-subheading text-[var(--foreground)]">{r.title}</p>
                  <p className="text-caption text-[var(--foreground-tertiary)] mt-1 line-clamp-2">{r.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="mt-region text-center surface-card-bordered p-7">
          <h2 className="text-heading text-[var(--foreground)]">
            {resource.category === 'companies'
              ? `Practice for ${resource.title.split('at ')[1]?.split(' —')[0] || 'This Company'}`
              : 'Put This Into Practice'}
          </h2>
          <p className="text-body text-[var(--foreground-tertiary)] mt-2">
            {resource.category === 'companies'
              ? `Start a mock interview tailored to this company's culture and interview style.`
              : 'Practice with our AI interviewer and get instant scored feedback on your answers.'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <Link
              href={resource.category === 'companies'
                ? `/?company=${encodeURIComponent(resource.title.split('at ')[1]?.split(' —')[0] || '')}`
                : '/signup'}
              className="inline-flex items-center justify-center h-11 px-5 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-[10px] text-sm font-medium transition-colors"
            >
              {resource.category === 'companies' ? 'Start Practice Interview' : 'Start Practicing Free'}
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
