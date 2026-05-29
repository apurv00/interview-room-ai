import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ExecutiveTemplate from '../../components/templates/ExecutiveTemplate'
import EntryLevelTemplate from '../../components/templates/EntryLevelTemplate'
import AcademicTemplate from '../../components/templates/AcademicTemplate'
import CareerChangeTemplate from '../../components/templates/CareerChangeTemplate'
import { SAMPLE_RESUME_DATA } from '../../config/templates'
import type { ResumeData } from '../../validators/resume'

const sample = SAMPLE_RESUME_DATA as unknown as ResumeData

function countMarkers(container: HTMLElement, selector: string): number {
  return container.querySelectorAll(selector).length
}

describe('ExecutiveLayout pagination markers', () => {
  it('executive template emits experience units and executive summary', () => {
    const { container } = render(<ExecutiveTemplate data={sample} />)
    expect(screen.getByText('Executive Summary')).toBeTruthy()
    expect(countMarkers(container, '[data-resume-section="experience"]')).toBe(1)
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
    expect(countMarkers(container, '[data-resume-skills-category]')).toBeGreaterThan(0)
  })
})

describe('EarlyCareerLayout pagination markers', () => {
  it('entry-level places education before experience in DOM order', () => {
    const { container } = render(<EntryLevelTemplate data={sample} />)
    const education = container.querySelector('[data-resume-section="education"]')
    const experience = container.querySelector('[data-resume-section="experience"]')
    expect(education).toBeTruthy()
    expect(experience).toBeTruthy()
    expect(
      education!.compareDocumentPosition(experience!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByText('Objective')).toBeTruthy()
  })

  it('academic variant uses research section titles', () => {
    const { container } = render(<AcademicTemplate data={sample} />)
    expect(container.textContent).toContain('Research Interests')
    expect(container.textContent).toContain('Research Experience')
    expect(countMarkers(container, '[data-resume-section-unit]')).toBeGreaterThan(0)
  })
})

describe('CareerChangeLayout pagination markers', () => {
  it('career-change template places skills before experience', () => {
    const { container } = render(<CareerChangeTemplate data={sample} />)
    const skills = container.querySelector('[data-resume-section="skills"]')
    const experience = container.querySelector('[data-resume-section="experience"]')
    expect(skills).toBeTruthy()
    expect(experience).toBeTruthy()
    expect(skills!.compareDocumentPosition(experience!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Career Objective')).toBeTruthy()
  })
})
