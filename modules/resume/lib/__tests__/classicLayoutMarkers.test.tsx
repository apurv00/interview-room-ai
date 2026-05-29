import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProfessionalTemplate from '../../components/templates/ProfessionalTemplate'
import MinimalistTemplate from '../../components/templates/MinimalistTemplate'
import FederalTemplate from '../../components/templates/FederalTemplate'
import TechnicalTemplate from '../../components/templates/TechnicalTemplate'
import { SAMPLE_RESUME_DATA } from '../../config/templates'
import type { ResumeData } from '../../validators/resume'

const sample = SAMPLE_RESUME_DATA as unknown as ResumeData

function countMarkers(container: HTMLElement, selector: string): number {
  return container.querySelectorAll(selector).length
}

describe('ClassicLayout pagination markers', () => {
  it('professional template emits section and unit markers', () => {
    const { container } = render(<ProfessionalTemplate data={sample} />)
    expect(countMarkers(container, '[data-resume-section="experience"]')).toBe(1)
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
    expect(countMarkers(container, '[data-resume-section-header]')).toBeGreaterThan(0)
    expect(countMarkers(container, '[data-resume-skills-category]')).toBeGreaterThan(0)
    expect(screen.getByText('Professional Summary')).toBeTruthy()
  })

  it('minimalist template emits skills header for continuation overlay', () => {
    const { container } = render(<MinimalistTemplate data={sample} />)
    expect(countMarkers(container, '[data-resume-section="skills"]')).toBe(1)
    const skillsHeader = container.querySelector('[data-resume-skills-header]')
    expect(skillsHeader?.getAttribute('data-resume-skills-header')).toBe('Skills')
  })

  it('federal template uses USAJobs section titles and unit markers', () => {
    const { container } = render(<FederalTemplate data={sample} />)
    expect(container.textContent).toContain('Summary of Qualifications')
    expect(container.textContent).toContain('Work Experience')
    expect(container.textContent).toContain('Job-Related Skills')
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
  })

  it('technical template places skills before summary with grid layout', () => {
    const { container } = render(<TechnicalTemplate data={sample} />)
    const skills = container.querySelector('[data-resume-section="skills"]')
    const summary = container.querySelector('[data-resume-section="summary"]')
    expect(skills).toBeTruthy()
    expect(summary).toBeTruthy()
    expect(skills!.compareDocumentPosition(summary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.textContent).toContain('Technical Skills')
  })
})
