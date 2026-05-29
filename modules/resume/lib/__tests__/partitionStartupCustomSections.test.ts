import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { partitionStartupCustomSections } from '../partitionStartupCustomSections'
import StartupTemplate from '../../components/templates/StartupTemplate'
import type { ResumeData } from '../../validators/resume'

describe('partitionStartupCustomSections', () => {
  it('routes side project and interest titles into dedicated buckets', () => {
    const result = partitionStartupCustomSections([
      { id: '1', title: 'Side Projects', content: 'Built X' },
      { id: '2', title: 'Interests', content: 'Climbing' },
      { id: '3', title: 'Volunteering', content: 'Mentor' },
    ])
    expect(result.sideProjects).toHaveLength(1)
    expect(result.interests).toHaveLength(1)
    expect(result.other).toHaveLength(1)
    expect(result.other[0].title).toBe('Volunteering')
  })

  it('renders every partitioned custom group as a paginatable data-resume-section block', () => {
    const data = {
      name: 'S',
      contactInfo: { fullName: 'A', email: 'a@b.c' },
      customSections: [
        { id: 'sp', title: 'Side Projects', content: 'Built a CLI tool.' },
        { id: 'it', title: 'Interests', content: 'Climbing, photography.' },
        { id: 'vol', title: 'Volunteer Work', content: 'Mentor at Code2040.' },
      ],
    } as unknown as ResumeData
    const html = renderToStaticMarkup(createElement(StartupTemplate, { data }))
    // Each partitioned group must remain an addressable, marker-bearing section so
    // the paginator can break around it (no group silently dropped).
    expect(html).toContain('Side Projects')
    expect(html).toContain('Interests')
    expect(html).toContain('Volunteer Work')
    const sectionMarkers = (html.match(/data-resume-section="custom-/g) || []).length
    expect(sectionMarkers).toBe(3)
  })
})
