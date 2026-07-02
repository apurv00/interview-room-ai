/**
 * PR "resume pagination + graceful parse" — salvage & normalization helpers.
 *
 * These are what make the import chain partial-tolerant: truncated LLM JSON
 * is repaired to the last complete value, and whatever survived is coerced
 * into editor-safe shapes with per-ITEM (never per-section) junk dropping.
 */
import { describe, it, expect } from 'vitest'
import { salvageTruncatedJson, normalizeParsedResume } from '@resume/lib/parseSalvage'

describe('salvageTruncatedJson', () => {
  it('parses valid JSON untouched', () => {
    expect(salvageTruncatedJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it('repairs output cut mid-object inside an array', () => {
    const cut = '{"experience": [{"company": "Acme", "bullets": ["a", "b"]}, {"company": "Hal'
    expect(salvageTruncatedJson(cut)).toEqual({
      experience: [{ company: 'Acme', bullets: ['a', 'b'] }],
    })
  })

  it('repairs output cut mid-string', () => {
    const cut = '{"summary": "Senior engineer with ten years of exp'
    // The dangling partial string is dropped; the object closes empty.
    expect(salvageTruncatedJson(cut)).toEqual({})
  })

  it('repairs output cut right after a complete key-value pair', () => {
    const cut = '{"summary": "done", "skills": [{"category": "Langs", "items": ["TS", "Go"]}'
    expect(salvageTruncatedJson(cut)).toEqual({
      summary: 'done',
      skills: [{ category: 'Langs', items: ['TS', 'Go'] }],
    })
  })

  it('drops a dangling key with no value', () => {
    const cut = '{"summary": "done", "experience'
    expect(salvageTruncatedJson(cut)).toEqual({ summary: 'done' })
  })

  it('returns null for structurally broken (not truncated) input', () => {
    expect(salvageTruncatedJson('{"a": ]}')).toBeNull()
  })

  it('returns null for non-JSON garbage and empty input', () => {
    expect(salvageTruncatedJson('sorry, I cannot help')).toBeNull()
    expect(salvageTruncatedJson('')).toBeNull()
  })
})

describe('normalizeParsedResume', () => {
  it('normalizes valid sections and reports them imported', () => {
    const { resume, importedSections, droppedSections } = normalizeParsedResume({
      contactInfo: { fullName: '  Jane  ', email: 'j@x.co', phone: '' },
      summary: 'A summary.',
      experience: [{ company: 'Acme', title: 'Eng', bullets: ['did x', ''] }],
      skills: [{ category: 'Langs', items: ['TS', 42, 'Go'] }],
    })
    expect(importedSections).toEqual(['contact info', 'summary', 'experience', 'skills'])
    expect(droppedSections).toEqual([])
    expect(resume.contactInfo).toEqual({ fullName: 'Jane', email: 'j@x.co' })
    const exp = resume.experience as Array<Record<string, unknown>>
    expect(exp[0]).toMatchObject({ id: 'exp-1', company: 'Acme', bullets: ['did x'] })
    const skills = resume.skills as Array<Record<string, unknown>>
    expect(skills[0].items).toEqual(['TS', 'Go'])
  })

  it('drops junk per-item, never per-section', () => {
    const { resume, importedSections } = normalizeParsedResume({
      experience: [
        { company: '', title: '' },              // junk — dropped
        { company: 'Real Co', title: 'Dev' },     // kept
        'not an object',                          // junk — dropped
      ],
    })
    expect(importedSections).toEqual(['experience'])
    expect((resume.experience as unknown[])).toHaveLength(1)
  })

  it('reports attempted-but-unusable sections as dropped', () => {
    const { importedSections, droppedSections } = normalizeParsedResume({
      summary: 'ok',
      education: [{ institution: '', degree: '' }],  // attempted, nothing usable
      projects: [],                                  // empty array = not attempted
    })
    expect(importedSections).toEqual(['summary'])
    expect(droppedSections).toEqual(['education'])
  })

  it('imports without contactInfo (no all-or-nothing gate)', () => {
    const { importedSections } = normalizeParsedResume({
      experience: [{ company: 'Acme', title: 'Eng' }],
    })
    expect(importedSections).toEqual(['experience'])
  })

  it('returns empty result for non-object input', () => {
    expect(normalizeParsedResume(null).importedSections).toEqual([])
    expect(normalizeParsedResume('text').importedSections).toEqual([])
  })

  it('guarantees ids and bullet arrays the editor depends on', () => {
    const { resume } = normalizeParsedResume({
      experience: [{ company: 'A' }, { company: 'B' }],
      education: [{ institution: 'MIT' }],
      projects: [{ name: 'P' }],
    })
    const exp = resume.experience as Array<Record<string, unknown>>
    expect(exp.map(e => e.id)).toEqual(['exp-1', 'exp-2'])
    expect(exp[0].bullets).toEqual([])
    expect((resume.education as Array<Record<string, unknown>>)[0].id).toBe('edu-1')
    expect((resume.projects as Array<Record<string, unknown>>)[0].id).toBe('proj-1')
  })
})
