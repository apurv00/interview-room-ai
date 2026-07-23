import { describe, expect, it } from 'vitest'
import sitemap from '../../../sitemap'
import { siteConfig } from '@shared/siteConfig'
import { metadata as jobsMetadata } from '../layout'
import { generateMetadata as jobDetailMetadata } from '../[id]/layout'
import { metadata as startMetadata } from '../start/layout'
import { metadata as trackerMetadata } from '../tracker/layout'

describe('Jobs search metadata boundary', () => {
  it('publishes one branded title, a Jobs canonical, and Jobs social metadata', () => {
    expect(jobsMetadata.title).toEqual({
      default: 'Jobs',
      template: `%s | Jobs | ${siteConfig.name}`,
    })
    expect(jobsMetadata.alternates?.canonical).toBe('/jobs')
    expect(jobsMetadata.openGraph).toMatchObject({
      url: '/jobs',
      title: `Jobs | ${siteConfig.name}`,
    })
    expect(jobsMetadata.twitter).toMatchObject({
      title: `Jobs | ${siteConfig.name}`,
    })
  })

  it.each([
    ['start', startMetadata, 'Personalize your job search', '/jobs/start'],
    ['tracker', trackerMetadata, 'Application tracker', '/jobs/tracker'],
  ])('keeps the %s utility route self-canonical and out of search results', (_route, metadata, title, canonical) => {
    expect(metadata.title).toBe(title)
    expect(metadata.alternates?.canonical).toBe(canonical)
    expect(metadata.robots).toMatchObject({
      index: false,
      follow: false,
      googleBot: { index: false, follow: false },
    })
  })

  it('keeps each gated detail route self-canonical and out of search results', () => {
    const metadata = jobDetailMetadata({ params: { id: 'job id' } })

    expect(metadata.title).toBe('Job details')
    expect(metadata.alternates?.canonical).toBe('/jobs/job%20id')
    expect(metadata.robots).toMatchObject({
      index: false,
      follow: false,
      googleBot: { index: false, follow: false },
    })
  })

  it('lists only the public Jobs discovery route in the sitemap', () => {
    const jobsEntries = sitemap().filter(({ url }) => url.startsWith(`${siteConfig.url}/jobs`))

    expect(jobsEntries).toEqual([
      {
        url: `${siteConfig.url}/jobs`,
        changeFrequency: 'hourly',
        priority: 0.9,
      },
    ])
  })
})
