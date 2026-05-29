import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import CreativeTemplate from '../../components/templates/CreativeTemplate'
import SidebarSlateTemplate from '../../components/templates/SidebarSlateTemplate'
import StartupTemplate from '../../components/templates/StartupTemplate'
import { SAMPLE_RESUME_DATA } from '../../config/templates'
import type { ResumeData } from '../../validators/resume'

const sample = SAMPLE_RESUME_DATA as unknown as ResumeData

function countMarkers(container: HTMLElement, selector: string): number {
  return container.querySelectorAll(selector).length
}

describe('SidebarLayout pagination markers', () => {
  it('creative template emits two-column body wrapper', () => {
    const { container } = render(<CreativeTemplate data={sample} />)
    const body = container.querySelector('[data-resume-section="body"]')
    expect(body).toBeTruthy()
    expect(body?.hasAttribute('data-resume-columns')).toBe(true)
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
  })

  it('sidebar-slate variant uses same column contract', () => {
    const { container } = render(<SidebarSlateTemplate data={sample} />)
    expect(container.querySelector('[data-resume-columns]')).toBeTruthy()
    expect(container.textContent).toContain('Profile')
  })
})

describe('StartupLayout pagination markers', () => {
  it('startup template emits section units and skills categories', () => {
    const { container } = render(<StartupTemplate data={sample} />)
    expect(countMarkers(container, '[data-resume-section="experience"]')).toBe(1)
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
    expect(countMarkers(container, '[data-resume-skills-category]')).toBeGreaterThan(0)
    expect(container.textContent).toContain('About')
  })
})
