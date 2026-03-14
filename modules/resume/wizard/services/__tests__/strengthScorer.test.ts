import { describe, it, expect } from 'vitest'
import { calculateStrengthScore, type StrengthInput } from '../strengthScorer'

describe('calculateStrengthScore', () => {
  it('returns 0 for empty data', () => {
    const result = calculateStrengthScore({})
    expect(result.total).toBe(0)
    expect(result.breakdown.contact).toBe(0)
    expect(result.breakdown.experience).toBe(0)
    expect(result.breakdown.education).toBe(0)
    expect(result.breakdown.skills).toBe(0)
    expect(result.breakdown.extras).toBe(0)
  })

  describe('contact scoring', () => {
    it('scores 2 points per contact field', () => {
      const result = calculateStrengthScore({
        contactInfo: { fullName: 'Jane', email: 'j@e.com' },
      })
      expect(result.breakdown.contact).toBe(4)
    })

    it('scores max 10 for all fields', () => {
      const result = calculateStrengthScore({
        contactInfo: {
          fullName: 'Jane',
          email: 'j@e.com',
          phone: '555-1234',
          city: 'SF',
          linkedInUrl: 'https://linkedin.com/in/jane',
        },
      })
      expect(result.breakdown.contact).toBe(10)
    })

    it('ignores empty strings', () => {
      const result = calculateStrengthScore({
        contactInfo: { fullName: '', email: '', phone: '  ', city: '' },
      })
      expect(result.breakdown.contact).toBe(0)
    })
  })

  describe('experience scoring', () => {
    it('scores 8 per role up to 4', () => {
      const roles = Array.from({ length: 5 }, (_, i) => ({
        rawBullets: ['did stuff'],
        followUpQuestions: [],
        bulletDecisions: [],
        finalBullets: [],
      }))
      const result = calculateStrengthScore({ roles })
      // 4 roles * 8 = 32, plus bullets
      expect(result.breakdown.experience).toBeGreaterThanOrEqual(32)
    })

    it('scores bullets and follow-up answers', () => {
      const result = calculateStrengthScore({
        roles: [{
          rawBullets: ['a', 'b', 'c', 'd'],
          followUpQuestions: [
            { answer: 'yes' },
            { answer: 'no' },
          ],
          bulletDecisions: [{ decision: 'accept' }],
          finalBullets: [],
        }],
      })
      // 8 (role) + 3 (bullets, capped) + 2 (answers) + 2 (accepted) = 15
      expect(result.breakdown.experience).toBe(15)
    })

    it('caps at 40', () => {
      const roles = Array.from({ length: 4 }, () => ({
        rawBullets: ['a', 'b', 'c', 'd'],
        followUpQuestions: [{ answer: 'y' }, { answer: 'y' }, { answer: 'y' }],
        bulletDecisions: [{ decision: 'accept' }],
        finalBullets: [],
      }))
      const result = calculateStrengthScore({ roles })
      expect(result.breakdown.experience).toBe(40)
    })
  })

  describe('education scoring', () => {
    it('scores 5 per entry up to 2', () => {
      const result = calculateStrengthScore({
        education: [
          { institution: 'MIT', degree: 'BS' },
          { institution: 'Stanford', degree: 'MS' },
          { institution: 'Harvard', degree: 'PhD' },
        ],
      })
      expect(result.breakdown.education).toBe(10) // 2 * 5
    })

    it('adds bonus for GPA and honors', () => {
      const result = calculateStrengthScore({
        education: [{ institution: 'MIT', degree: 'BS', gpa: '3.9', honors: 'Cum Laude' }],
      })
      expect(result.breakdown.education).toBe(10) // 5 + 2.5 + 2.5
    })
  })

  describe('skills scoring', () => {
    it('scores 4 per category with 3+ items', () => {
      const result = calculateStrengthScore({
        skills: {
          hard: ['a', 'b', 'c'],
          soft: ['d', 'e', 'f'],
          technical: ['g', 'h'],
        },
      })
      // 2 categories * 4 = 8, plus 8 total skills -> floor(8/5)*2 = 2
      expect(result.breakdown.skills).toBe(10)
    })

    it('adds bonus for total skill count', () => {
      const result = calculateStrengthScore({
        skills: {
          hard: ['a', 'b', 'c', 'd', 'e'],
          soft: ['f', 'g', 'h', 'i', 'j'],
          technical: ['k', 'l', 'm', 'n', 'o'],
        },
      })
      // 3 categories * 4 = 12, plus 15 skills -> floor(15/5)*2 = 6 => 18
      expect(result.breakdown.skills).toBe(18)
    })
  })

  describe('extras scoring', () => {
    it('scores projects and certs', () => {
      const result = calculateStrengthScore({
        projects: [{ name: 'P1' }, { name: 'P2' }],
        certifications: [{ name: 'C1' }],
      })
      // 2 projects * 5 = 10, 1 cert * 2.5 = 2.5
      expect(result.breakdown.extras).toBe(12.5)
    })

    it('adds 5 for summary', () => {
      const result = calculateStrengthScore({
        finalSummary: 'A skilled professional.',
      })
      expect(result.breakdown.extras).toBe(5)
    })

    it('caps at 15', () => {
      const result = calculateStrengthScore({
        projects: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }],
        certifications: [{ name: 'C1' }, { name: 'C2' }, { name: 'C3' }],
        finalSummary: 'Summary here',
      })
      expect(result.breakdown.extras).toBe(15)
    })
  })

  describe('total score', () => {
    it('sums all categories correctly', () => {
      const fullData: StrengthInput = {
        contactInfo: { fullName: 'J', email: 'e', phone: 'p', city: 'c', linkedInUrl: 'l' },
        roles: Array.from({ length: 4 }, () => ({
          rawBullets: ['a', 'b', 'c'],
          followUpQuestions: [{ answer: 'y' }, { answer: 'y' }, { answer: 'y' }],
          bulletDecisions: [{ decision: 'accept' }],
          finalBullets: [],
        })),
        education: [
          { institution: 'MIT', degree: 'BS', gpa: '3.9', honors: 'Honors' },
          { institution: 'Stanford', degree: 'MS' },
        ],
        skills: {
          hard: ['a', 'b', 'c', 'd', 'e'],
          soft: ['f', 'g', 'h', 'i', 'j'],
          technical: ['k', 'l', 'm', 'n', 'o'],
        },
        projects: [{ name: 'P1' }, { name: 'P2' }],
        certifications: [{ name: 'C1' }, { name: 'C2' }],
        finalSummary: 'Summary',
      }
      const result = calculateStrengthScore(fullData)
      // Verify total equals sum of breakdown
      const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0)
      expect(result.total).toBe(Math.min(100, sum))
      // Verify all categories are maxed or near max
      expect(result.breakdown.contact).toBe(10)
      expect(result.breakdown.experience).toBe(40)
      expect(result.breakdown.education).toBe(15)
      expect(result.breakdown.skills).toBeGreaterThanOrEqual(18)
      expect(result.breakdown.extras).toBe(15)
      expect(result.total).toBeGreaterThanOrEqual(95)
    })
  })
})
