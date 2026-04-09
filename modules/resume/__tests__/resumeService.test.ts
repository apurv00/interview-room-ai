import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockFindById = vi.fn()
const mockUpdateOne = vi.fn()

vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockFindById(...args) }),
    }),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}))

import {
  listResumes,
  getResume,
  saveResume,
  deleteResume,
  getUserProfileContext,
  getProfileForResume,
} from '@resume/services/resumeService'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resumeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateOne.mockResolvedValue({ acknowledged: true })
  })

  describe('listResumes', () => {
    it('returns null when user not found', async () => {
      mockFindById.mockResolvedValue(null)
      const result = await listResumes('user-1')
      expect(result).toBeNull()
    })

    it('returns empty list for a user with no resumes', async () => {
      mockFindById.mockResolvedValue({ savedResumes: [], targetRole: '', currentTitle: '' })
      const result = await listResumes('user-1')
      expect(result).not.toBeNull()
      expect(result!.resumes).toEqual([])
      expect(result!.count).toBe(0)
      expect(result!.limit).toBe(3)
      expect(result!.hasProfile).toBe(false)
    })

    it('formats saved resumes with defaults', async () => {
      mockFindById.mockResolvedValue({
        savedResumes: [
          { id: 'r1', name: 'Alpha', template: 'technical', targetRole: 'SWE', atsScore: 87, updatedAt: '2026-01-01' },
          { id: 'r2' }, // bare — should fall back to defaults
        ],
        targetRole: 'Product Manager',
        currentTitle: '',
      })
      const result = await listResumes('user-1')
      expect(result!.count).toBe(2)
      expect(result!.hasProfile).toBe(true)
      expect(result!.resumes[0]).toMatchObject({
        id: 'r1',
        name: 'Alpha',
        template: 'technical',
        atsScore: 87,
      })
      expect(result!.resumes[1]).toMatchObject({
        name: 'Untitled Resume',
        template: 'professional',
        atsScore: null,
      })
    })
  })

  describe('getResume', () => {
    it('returns null when user not found', async () => {
      mockFindById.mockResolvedValue(null)
      expect(await getResume('user-1', 'r1')).toBeNull()
    })

    it('returns null when resume id not found', async () => {
      mockFindById.mockResolvedValue({ savedResumes: [{ id: 'r1' }, { id: 'r2' }] })
      expect(await getResume('user-1', 'r3')).toBeNull()
    })

    it('returns the matching resume', async () => {
      const resume = { id: 'r1', name: 'My Resume', summary: 'Hi' }
      mockFindById.mockResolvedValue({ savedResumes: [resume] })
      expect(await getResume('user-1', 'r1')).toEqual(resume)
    })
  })

  describe('saveResume', () => {
    it('updates an existing resume when id is provided', async () => {
      const data = {
        id: 'r1',
        name: 'Updated',
        template: 'executive' as const,
        targetRole: 'VP Eng',
        summary: 'Hands-on leader',
        experience: [],
        education: [],
        skills: [],
      }
      const result = await saveResume('user-1', data)
      expect(result).toEqual({ id: 'r1' })
      expect(mockUpdateOne).toHaveBeenCalledTimes(1)
      const [filter, update] = mockUpdateOne.mock.calls[0]
      expect(filter).toEqual({ _id: 'user-1', 'savedResumes.id': 'r1' })
      expect(update.$set['savedResumes.$.name']).toBe('Updated')
      expect(update.$set['savedResumes.$.template']).toBe('executive')
      expect(update.$set['savedResumes.$.fullText']).toContain('Hands-on leader')
    })

    it('builds fullText from structured data when not provided', async () => {
      const data = {
        id: 'r1',
        name: 'Auto',
        contactInfo: { fullName: 'Jane Doe', email: 'jane@example.com' },
        summary: 'Experienced engineer',
        experience: [{
          id: 'e1', company: 'Acme', title: 'Engineer', startDate: '2020',
          endDate: '2024', bullets: ['Shipped thing', 'Led team'],
        }],
        education: [{
          id: 'ed1', institution: 'MIT', degree: 'BS', field: 'CS',
          graduationDate: '2020',
        }],
        skills: [{ category: 'Languages', items: ['TypeScript', 'Python'] }],
      }
      await saveResume('user-1', data)
      const [, update] = mockUpdateOne.mock.calls[0]
      const fullText = update.$set['savedResumes.$.fullText'] as string
      expect(fullText).toContain('Jane Doe')
      expect(fullText).toContain('jane@example.com')
      expect(fullText).toContain('EXPERIENCE')
      expect(fullText).toContain('Engineer at Acme')
      expect(fullText).toContain('Shipped thing')
      expect(fullText).toContain('EDUCATION')
      expect(fullText).toContain('BS in CS - MIT')
      expect(fullText).toContain('SKILLS')
      expect(fullText).toContain('Languages: TypeScript, Python')
    })

    it('uses provided fullText when supplied (no rebuild)', async () => {
      await saveResume('user-1', {
        id: 'r1',
        name: 'Resume',
        fullText: 'PRE-BUILT TEXT',
      })
      const [, update] = mockUpdateOne.mock.calls[0]
      expect(update.$set['savedResumes.$.fullText']).toBe('PRE-BUILT TEXT')
    })

    it('creates a new resume when no id and under limit', async () => {
      mockFindById.mockResolvedValue({ savedResumes: [{ id: 'r1' }] })
      const result = await saveResume('user-1', { name: 'Fresh' })
      expect(result).toMatchObject({ created: true })
      expect((result as { id: string }).id).toBeTruthy()
      expect(mockUpdateOne).toHaveBeenCalledTimes(1)
      const [filter, update] = mockUpdateOne.mock.calls[0]
      expect(filter).toEqual({ _id: 'user-1' })
      expect(update.$push.savedResumes.name).toBe('Fresh')
      expect(update.$push.savedResumes.template).toBe('professional')
    })

    it('returns RESUME_LIMIT error when user already has 3 resumes', async () => {
      mockFindById.mockResolvedValue({
        savedResumes: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      })
      const result = await saveResume('user-1', { name: 'Fourth' })
      expect(result).toMatchObject({ code: 'RESUME_LIMIT' })
      expect(mockUpdateOne).not.toHaveBeenCalled()
    })
  })

  describe('deleteResume', () => {
    it('calls $pull on savedResumes by id', async () => {
      const result = await deleteResume('user-1', 'r2')
      expect(result).toEqual({ success: true })
      const [filter, update] = mockUpdateOne.mock.calls[0]
      expect(filter).toEqual({ _id: 'user-1' })
      expect(update.$pull.savedResumes).toEqual({ id: 'r2' })
    })
  })

  describe('getUserProfileContext', () => {
    it('returns empty string when profile has no fields', async () => {
      mockFindById.mockResolvedValue(null)
      expect(await getUserProfileContext('user-1')).toBe('')
    })

    it('concatenates available profile fields', async () => {
      mockFindById.mockResolvedValue({
        currentTitle: 'Staff Engineer',
        currentIndustry: 'Fintech',
        experienceLevel: '8',
        topSkills: ['TypeScript', 'Distributed Systems'],
      })
      const ctx = await getUserProfileContext('user-1')
      expect(ctx).toContain('Staff Engineer')
      expect(ctx).toContain('Fintech')
      expect(ctx).toContain('8')
      expect(ctx).toContain('TypeScript, Distributed Systems')
    })

    it('skips missing fields gracefully', async () => {
      mockFindById.mockResolvedValue({ currentTitle: 'Designer' })
      const ctx = await getUserProfileContext('user-1')
      expect(ctx).toContain('Designer')
      expect(ctx).not.toContain('Industry')
      expect(ctx).not.toContain('Experience')
    })
  })

  describe('getProfileForResume', () => {
    it('returns null when user not found', async () => {
      mockFindById.mockResolvedValue(null)
      expect(await getProfileForResume('user-1')).toBeNull()
    })

    it('maps profile fields into resume-shaped data', async () => {
      mockFindById.mockResolvedValue({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        currentTitle: 'Principal Engineer',
        currentIndustry: 'AI',
        topSkills: ['Math', 'Systems'],
        linkedinUrl: 'https://linkedin.com/in/ada',
        targetRole: 'Chief Scientist',
      })
      const result = await getProfileForResume('user-1')
      expect(result).not.toBeNull()
      expect(result!.contactInfo).toEqual({
        fullName: 'Ada Lovelace',
        email: 'ada@example.com',
        linkedin: 'https://linkedin.com/in/ada',
      })
      expect(result!.summary).toBe('Experienced Principal Engineer in the AI industry.')
      expect(result!.skills).toEqual([{ category: 'Core Skills', items: ['Math', 'Systems'] }])
      expect(result!.targetRole).toBe('Chief Scientist')
    })

    it('generates minimal summary when industry missing', async () => {
      mockFindById.mockResolvedValue({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        currentTitle: 'Admiral',
      })
      const result = await getProfileForResume('user-1')
      expect(result!.summary).toBe('Experienced Admiral.')
    })

    it('returns empty summary when no current title', async () => {
      mockFindById.mockResolvedValue({ name: 'Anon', email: 'a@b.co' })
      const result = await getProfileForResume('user-1')
      expect(result!.summary).toBe('')
      expect(result!.skills).toEqual([])
    })
  })
})
