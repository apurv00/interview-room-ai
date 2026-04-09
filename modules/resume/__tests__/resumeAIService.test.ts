import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Use vi.hoisted so the mock reference is available at module-load time.
const { mockCompletion } = vi.hoisted(() => ({ mockCompletion: vi.fn() }))

vi.mock('@shared/services/modelRouter', () => ({
  completion: (...args: unknown[]) => mockCompletion(...args),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: () => ({
      select: () => ({
        lean: () => Promise.resolve({
          currentTitle: 'Engineer',
          topSkills: ['TypeScript'],
        }),
      }),
    }),
  },
}))

import {
  enhanceSection,
  enhanceBullets,
  generateFullResume,
  checkATS,
  tailorResume,
  parseResumeToStructured,
  generateSTARStories,
} from '@resume/services/resumeAIService'

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockTextResponse(text: string) {
  mockCompletion.mockResolvedValueOnce({
    text,
    model: 'claude-sonnet-4-6-20250514',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 200,
    usedFallback: false,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resumeAIService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('enhanceSection', () => {
    it('returns the enhanced text from Claude', async () => {
      mockTextResponse('Enhanced summary text.')
      const result = await enhanceSection('user-1', {
        sectionType: 'summary',
        currentContent: 'basic summary',
        targetRole: 'Staff Engineer',
      })
      expect(result).toEqual({ enhanced: 'Enhanced summary text.' })
      expect(mockCompletion).toHaveBeenCalledTimes(1)
      const args = mockCompletion.mock.calls[0][0]
      expect(args.system).toContain('Target role: Staff Engineer')
      expect(args.messages[0].content).toContain('basic summary')
    })

    it('returns empty enhanced string when Claude returns empty text', async () => {
      mockCompletion.mockResolvedValueOnce({
        text: '',
        model: 'claude-sonnet-4-6-20250514',
        provider: 'anthropic',
        inputTokens: 10,
        outputTokens: 10,
        usedFallback: false,
      })
      const result = await enhanceSection('user-1', {
        sectionType: 'summary',
        currentContent: 'foo',
      })
      expect(result).toEqual({ enhanced: '' })
    })
  })

  describe('enhanceBullets', () => {
    it('parses a JSON array of bullets from Claude', async () => {
      mockTextResponse('["Delivered X", "Owned Y", "Scaled Z"]')
      const result = await enhanceBullets('user-1', {
        bullets: ['did x', 'did y', 'did z'],
      })
      expect(result.bullets).toEqual(['Delivered X', 'Owned Y', 'Scaled Z'])
    })

    it('falls back to original bullets on JSON parse failure', async () => {
      mockTextResponse('not valid json at all')
      const original = ['did x', 'did y']
      const result = await enhanceBullets('user-1', { bullets: original })
      expect(result.bullets).toEqual(original)
    })

    it('falls back to original bullets when result is not an array', async () => {
      mockTextResponse('{"not": "an array"}')
      const original = ['did x']
      const result = await enhanceBullets('user-1', { bullets: original })
      expect(result.bullets).toEqual(original)
    })

    it('extracts JSON even with leading prose', async () => {
      mockTextResponse('Here you go:\n["Shipped feature", "Led migration"]\nHope this helps.')
      const result = await enhanceBullets('user-1', { bullets: ['old'] })
      expect(result.bullets).toEqual(['Shipped feature', 'Led migration'])
    })
  })

  describe('generateFullResume', () => {
    it('parses the sections JSON from Claude', async () => {
      mockTextResponse('{"sections":[{"type":"summary","content":"Summary."}]}')
      const result = await generateFullResume('user-1', { targetRole: 'PM' })
      expect(result.sections).toEqual([{ type: 'summary', content: 'Summary.' }])
    })

    it('falls back to empty sections on parse failure', async () => {
      mockTextResponse('totally not json')
      const result = await generateFullResume('user-1', {})
      expect(result).toEqual({ sections: [] })
    })
  })

  describe('checkATS', () => {
    it('returns normalized ATS result with defaults', async () => {
      mockTextResponse(JSON.stringify({
        score: 82,
        issues: [{ category: 'formatting', severity: 'warning', message: 'issue', fix: 'fix it' }],
        keywords: { found: ['typescript'], missing: ['graphql'], total: 2 },
        formatting: { score: 90, issues: ['no issues'] },
        sections: { found: ['summary'], missing: ['education'], recommended: ['projects'] },
        summary: 'Looks good',
      }))
      const result = await checkATS({ resumeText: 'x'.repeat(200) })
      expect(result.score).toBe(82)
      expect(result.issues).toHaveLength(1)
      expect(result.keywords.found).toEqual(['typescript'])
      expect(result.formatting.score).toBe(90)
      expect(result.sections.missing).toEqual(['education'])
      expect(result.summary).toBe('Looks good')
    })

    it('fills missing fields with safe defaults', async () => {
      mockTextResponse(JSON.stringify({ score: 50 }))
      const result = await checkATS({ resumeText: 'x'.repeat(200) })
      expect(result.score).toBe(50)
      expect(result.issues).toEqual([])
      expect(result.keywords).toEqual({ found: [], missing: [], total: 0 })
      expect(result.formatting).toEqual({ score: 0, issues: [] })
      expect(result.sections).toEqual({ found: [], missing: [], recommended: [] })
    })

    it('passes job description context to Claude', async () => {
      mockTextResponse('{"score": 70}')
      await checkATS({ resumeText: 'resume text here', jobDescription: 'JD text here' })
      const args = mockCompletion.mock.calls[0][0]
      expect(args.messages[0].content).toContain('JD text here')
      expect(args.messages[0].content).toContain('<job_description>')
    })

    it('throws on unparseable JSON', async () => {
      mockTextResponse('not json')
      await expect(checkATS({ resumeText: 'x'.repeat(200) })).rejects.toThrow(/Failed to parse ATS/)
    })
  })

  describe('tailorResume', () => {
    it('returns tailored content with defaults', async () => {
      mockTextResponse(JSON.stringify({
        tailoredResume: 'NEW RESUME',
        changes: [{ section: 'exp', change: 'reordered', reason: 'relevance' }],
        matchScore: 78,
        missingKeywords: ['kubernetes'],
        addedKeywords: ['typescript', 'react'],
      }))
      const result = await tailorResume({
        resumeText: 'resume',
        jobDescription: 'job',
        companyName: 'Acme',
      })
      expect(result.tailoredResume).toBe('NEW RESUME')
      expect(result.matchScore).toBe(78)
      expect(result.addedKeywords).toEqual(['typescript', 'react'])
      const args = mockCompletion.mock.calls[0][0]
      expect(args.system).toContain('Target company: Acme')
    })

    it('fills missing fields with safe defaults', async () => {
      mockTextResponse('{}')
      const result = await tailorResume({ resumeText: 'r', jobDescription: 'j' })
      expect(result).toEqual({
        tailoredResume: '',
        changes: [],
        matchScore: 0,
        missingKeywords: [],
        addedKeywords: [],
      })
    })

    it('throws on unparseable JSON', async () => {
      mockTextResponse('garbage')
      await expect(
        tailorResume({ resumeText: 'r', jobDescription: 'j' })
      ).rejects.toThrow(/Failed to parse tailoring/)
    })
  })

  describe('parseResumeToStructured', () => {
    it('parses structured resume JSON', async () => {
      const payload = {
        contactInfo: { fullName: 'Jane', email: 'j@x.co' },
        summary: 'text',
        experience: [],
        education: [],
        skills: [],
        projects: [],
        certifications: [],
      }
      mockTextResponse(JSON.stringify(payload))
      const result = await parseResumeToStructured('some resume text')
      expect(result).toEqual(payload)
    })

    it('returns null on unparseable JSON', async () => {
      mockTextResponse('not valid')
      const result = await parseResumeToStructured('text')
      expect(result).toBeNull()
    })
  })

  describe('generateSTARStories', () => {
    it('returns empty array when no bullets provided', async () => {
      const result = await generateSTARStories('user-1', { experience: [] })
      expect(result).toEqual([])
      expect(mockCompletion).not.toHaveBeenCalled()
    })

    it('returns empty array when experience has no bullets', async () => {
      const result = await generateSTARStories('user-1', {
        experience: [{ id: 'e1', company: 'Acme', title: 'Eng', bullets: [] }],
      })
      expect(result).toEqual([])
      expect(mockCompletion).not.toHaveBeenCalled()
    })

    it('parses STAR stories and maps them back to experience ids', async () => {
      mockTextResponse(JSON.stringify([
        {
          bulletIndex: 1,
          situation: 'S1',
          task: 'T1',
          action: 'A1',
          result: 'R1',
          targetQuestion: 'Tell me about leadership',
          skills: ['leadership', 'delivery'],
        },
      ]))
      const result = await generateSTARStories('user-1', {
        experience: [
          { id: 'e1', company: 'Acme', title: 'Engineer', bullets: ['Led migration'] },
        ],
      })
      expect(result).toHaveLength(1)
      expect(result[0].experienceId).toBe('e1')
      expect(result[0].originalBullet).toBe('Led migration')
      expect(result[0].situation).toBe('S1')
      expect(result[0].skills).toEqual(['leadership', 'delivery'])
    })

    it('returns empty array when response has no JSON array', async () => {
      mockTextResponse('there is no array here')
      const result = await generateSTARStories('user-1', {
        experience: [{ id: 'e1', company: 'Acme', title: 'Eng', bullets: ['did x'] }],
      })
      expect(result).toEqual([])
    })

    it('returns empty array when JSON parse fails', async () => {
      mockTextResponse('[this is not valid json]')
      const result = await generateSTARStories('user-1', {
        experience: [{ id: 'e1', company: 'Acme', title: 'Eng', bullets: ['did x'] }],
      })
      expect(result).toEqual([])
    })
  })
})
