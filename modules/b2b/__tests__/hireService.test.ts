import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockSendEmail = vi.fn().mockResolvedValue(true)
vi.mock('@shared/services/emailService', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}))

// User mock — supports chained .select().lean() and findByIdAndUpdate
const mockUserFindById = vi.fn()
const mockUserFindByIdAndUpdate = vi.fn()
const mockUserCountDocuments = vi.fn()

// Organization mock
const mockOrgFindById = vi.fn()
const mockOrgFindOne = vi.fn()
const mockOrgFindOneAndUpdate = vi.fn()
const mockOrgExists = vi.fn()
const mockOrgCreate = vi.fn()
const mockOrgFindByIdAndUpdate = vi.fn()

// InterviewSession mock
const mockSessionFind = vi.fn()
const mockSessionCountDocuments = vi.fn()
const mockSessionCreate = vi.fn()
const mockSessionFindOne = vi.fn()

// InterviewTemplate mock
const mockTemplateFind = vi.fn()
const mockTemplateCreate = vi.fn()

vi.mock('@shared/db/models', () => ({
  User: {
    findById: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockUserFindById(...args) }),
      lean: () => mockUserFindById(...args),
    }),
    findByIdAndUpdate: (...args: unknown[]) => mockUserFindByIdAndUpdate(...args),
    countDocuments: (...args: unknown[]) => mockUserCountDocuments(...args),
  },
  Organization: {
    findById: (...args: unknown[]) => ({ lean: () => mockOrgFindById(...args) }),
    findOne: (...args: unknown[]) => ({ lean: () => mockOrgFindOne(...args) }),
    findOneAndUpdate: (...args: unknown[]) => mockOrgFindOneAndUpdate(...args),
    exists: (...args: unknown[]) => mockOrgExists(...args),
    create: (...args: unknown[]) => mockOrgCreate(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockOrgFindByIdAndUpdate(...args),
  },
  InterviewSession: {
    find: (...args: unknown[]) => {
      const chain = {
        sort: () => chain,
        skip: () => chain,
        limit: () => chain,
        lean: () => mockSessionFind(...args),
      }
      return chain
    },
    countDocuments: (...args: unknown[]) => mockSessionCountDocuments(...args),
    create: (...args: unknown[]) => mockSessionCreate(...args),
    findOne: (...args: unknown[]) => ({ lean: () => mockSessionFindOne(...args) }),
  },
  InterviewTemplate: {
    find: (...args: unknown[]) => ({
      sort: () => ({ lean: () => mockTemplateFind(...args) }),
    }),
    create: (...args: unknown[]) => mockTemplateCreate(...args),
  },
}))

import {
  isRecruiter,
  isOrgAdmin,
  getHireUser,
  getDashboardData,
  listCandidates,
  createInvite,
  verifyInviteToken,
  listPendingInvites,
  createOrg,
  getOrg,
  updateOrgSettings,
  listTemplates,
  createTemplate,
  type HireUser,
} from '@b2b/services/hireService'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('hireService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendEmail.mockResolvedValue(true)
  })

  describe('role predicates', () => {
    it('isRecruiter returns true for recruiter with org', () => {
      const u: HireUser = { _id: 'u1', role: 'recruiter', organizationId: 'org1' }
      expect(isRecruiter(u)).toBe(true)
    })

    it('isRecruiter returns true for org_admin and platform_admin', () => {
      expect(isRecruiter({ _id: 'u', role: 'org_admin', organizationId: 'o' })).toBe(true)
      expect(isRecruiter({ _id: 'u', role: 'platform_admin', organizationId: 'o' })).toBe(true)
    })

    it('isRecruiter returns false when missing organizationId', () => {
      expect(isRecruiter({ _id: 'u1', role: 'recruiter' })).toBe(false)
    })

    it('isRecruiter returns false for candidate role', () => {
      expect(isRecruiter({ _id: 'u1', role: 'candidate', organizationId: 'org1' })).toBe(false)
    })

    it('isOrgAdmin is stricter than isRecruiter', () => {
      const recruiterOnly: HireUser = { _id: 'u', role: 'recruiter', organizationId: 'o' }
      expect(isRecruiter(recruiterOnly)).toBe(true)
      expect(isOrgAdmin(recruiterOnly)).toBe(false)

      const admin: HireUser = { _id: 'u', role: 'org_admin', organizationId: 'o' }
      expect(isOrgAdmin(admin)).toBe(true)
    })
  })

  describe('getHireUser', () => {
    it('returns the user from the DB', async () => {
      mockUserFindById.mockResolvedValue({ _id: 'u1', role: 'recruiter', organizationId: 'org1' })
      const result = await getHireUser('u1')
      expect(result).toEqual({ _id: 'u1', role: 'recruiter', organizationId: 'org1' })
    })
  })

  describe('getDashboardData', () => {
    it('returns empty stats when org not found', async () => {
      mockOrgFindById.mockResolvedValue(null)
      mockSessionFind.mockResolvedValue([])
      const result = await getDashboardData('org1')
      expect(result.org).toBeNull()
      expect(result.stats).toEqual({
        totalCandidates: 0,
        completedInterviews: 0,
        avgScore: 0,
        pendingInvites: 0,
      })
    })

    it('aggregates stats across sessions', async () => {
      const now = new Date()
      mockOrgFindById.mockResolvedValue({
        name: 'Acme',
        plan: 'pro',
        currentSeats: 3,
        maxSeats: 10,
        monthlyInterviewsUsed: 20,
        monthlyInterviewLimit: 100,
      })
      mockSessionFind.mockResolvedValue([
        {
          status: 'completed', candidateEmail: 'a@x.co', candidateName: 'A',
          feedback: { overall_score: 80 }, config: { role: 'SWE' }, completedAt: now,
        },
        {
          status: 'completed', candidateEmail: 'b@x.co', candidateName: 'B',
          feedback: { overall_score: 60 }, config: { role: 'PM' }, completedAt: now,
        },
        {
          status: 'created', candidateEmail: 'c@x.co', candidateName: 'C',
          config: { role: 'SWE' },
        },
      ])
      const result = await getDashboardData('org1')
      expect(result.org).toMatchObject({ name: 'Acme', plan: 'pro' })
      expect(result.stats.totalCandidates).toBe(3)
      expect(result.stats.completedInterviews).toBe(2)
      expect(result.stats.avgScore).toBe(70) // (80+60)/2
      expect(result.stats.pendingInvites).toBe(1)
      expect(result.recentCandidates).toHaveLength(3)
    })

    it('handles zero completed sessions (no divide-by-zero)', async () => {
      mockOrgFindById.mockResolvedValue({
        name: 'Acme', plan: 'free',
        currentSeats: 1, maxSeats: 5,
        monthlyInterviewsUsed: 0, monthlyInterviewLimit: 10,
      })
      mockSessionFind.mockResolvedValue([
        { status: 'created', candidateEmail: 'a@x.co', config: {} },
      ])
      const result = await getDashboardData('org1')
      expect(result.stats.avgScore).toBe(0)
      expect(result.stats.completedInterviews).toBe(0)
    })
  })

  describe('listCandidates', () => {
    it('applies status filter and paginates', async () => {
      const sessions = [
        {
          _id: { toString: () => 'sess1' },
          candidateEmail: 'a@x.co',
          candidateName: 'Alice',
          status: 'completed',
          config: { role: 'SWE', interviewType: 'screening', experience: '3-6' },
          feedback: {
            overall_score: 85,
            pass_probability: 'High',
            dimensions: {
              answer_quality: {
                strengths: ['clear communication', 'structured', 'deep'],
                weaknesses: ['brief', 'rushed', 'no metrics'],
              },
            },
            red_flags: ['tardy', 'unprepared', 'no follow-up', 'extra'],
          },
          recruiterNotes: 'notes',
          createdAt: new Date('2026-01-01'),
          completedAt: new Date('2026-01-02'),
          durationActualSeconds: 600,
        },
      ]
      mockSessionFind.mockResolvedValue(sessions)
      mockSessionCountDocuments.mockResolvedValue(25)
      const result = await listCandidates('org1', { status: 'completed', page: 2 })
      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]).toMatchObject({
        id: 'sess1',
        candidateEmail: 'a@x.co',
        overallScore: 85,
        passProb: 'High',
      })
      expect(result.candidates[0].strengths).toHaveLength(2) // sliced to 2
      expect(result.candidates[0].redFlags).toHaveLength(3) // sliced to 3
      expect(result.pagination).toEqual({ page: 2, limit: 20, total: 25, pages: 2 })
    })

    it('ignores invalid status values', async () => {
      mockSessionFind.mockResolvedValue([])
      mockSessionCountDocuments.mockResolvedValue(0)
      await listCandidates('org1', { status: 'hacker-inject' })
      // The find arg is in both calls
      expect(mockSessionCountDocuments).toHaveBeenCalledWith({ organizationId: 'org1' })
    })

    it('handles null feedback safely', async () => {
      mockSessionFind.mockResolvedValue([{
        _id: { toString: () => 's1' },
        status: 'created',
        config: {},
        createdAt: new Date(),
      }])
      mockSessionCountDocuments.mockResolvedValue(1)
      const result = await listCandidates('org1', {})
      expect(result.candidates[0].overallScore).toBeNull()
      expect(result.candidates[0].passProb).toBeNull()
      expect(result.candidates[0].strengths).toEqual([])
    })
  })

  describe('createInvite', () => {
    const inviteData = {
      candidateEmail: 'CAND@X.co',
      candidateName: 'Candidate',
      role: 'SWE',
      interviewType: 'screening',
      experience: '3-6',
      duration: 15 as const,
    }

    it('fails when organization is not found', async () => {
      mockOrgFindOneAndUpdate.mockResolvedValue(null)
      mockOrgExists.mockResolvedValue(false)
      const result = await createInvite('u1', 'org1', inviteData)
      expect(result).toMatchObject({ error: 'Organization not found', status: 404 })
    })

    it('fails with 429 when monthly limit reached', async () => {
      mockOrgFindOneAndUpdate.mockResolvedValue(null)
      mockOrgExists.mockResolvedValue(true)
      const result = await createInvite('u1', 'org1', inviteData)
      expect(result).toMatchObject({ error: 'Monthly interview limit reached', status: 429 })
    })

    it('creates the invite session, generates a token, and sends email', async () => {
      mockOrgFindOneAndUpdate.mockResolvedValue({ _id: 'org1' })
      mockSessionCreate.mockResolvedValue({
        _id: { toString: () => 'sess-new' },
      })
      const result = await createInvite('u1', 'org1', inviteData)
      expect(result).toMatchObject({
        success: true,
        sessionId: 'sess-new',
        candidateEmail: 'CAND@X.co',
        emailSent: true,
      })
      expect((result as { inviteLink: string }).inviteLink).toContain('/interview?invite=sess-new&token=')

      // Session was created with lowercased email and a token hash
      const createArg = mockSessionCreate.mock.calls[0][0]
      expect(createArg.candidateEmail).toBe('cand@x.co')
      expect(createArg.inviteTokenHash).toBeTruthy()
      expect(createArg.inviteTokenExpiry).toBeInstanceOf(Date)
      expect(createArg.status).toBe('created')

      // Email was sent
      expect(mockSendEmail).toHaveBeenCalledTimes(1)
      expect(mockSendEmail.mock.calls[0][0].to).toBe('cand@x.co')
    })

    it('still returns success when email delivery fails', async () => {
      mockOrgFindOneAndUpdate.mockResolvedValue({ _id: 'org1' })
      mockSessionCreate.mockResolvedValue({ _id: { toString: () => 'sess-1' } })
      mockSendEmail.mockRejectedValueOnce(new Error('smtp down'))
      const result = await createInvite('u1', 'org1', inviteData)
      expect((result as { success: boolean }).success).toBe(true)
      expect((result as { emailSent: boolean }).emailSent).toBe(false)
    })
  })

  describe('verifyInviteToken', () => {
    it('returns true when token hash matches and not expired', async () => {
      mockSessionFindOne.mockResolvedValue({ _id: 'sess1' })
      const result = await verifyInviteToken('sess1', 'some-token-value')
      expect(result).toBe(true)
    })

    it('returns false when token hash does not match', async () => {
      mockSessionFindOne.mockResolvedValue(null)
      const result = await verifyInviteToken('sess1', 'wrong-token')
      expect(result).toBe(false)
    })

    it('hashes the token with sha256 before querying', async () => {
      mockSessionFindOne.mockResolvedValue(null)
      await verifyInviteToken('sess1', 'plain-token')
      const queryArg = mockSessionFindOne.mock.calls[0][0]
      expect(queryArg.inviteTokenHash).toBeTruthy()
      expect(queryArg.inviteTokenHash).not.toBe('plain-token')
      // sha256 hex is 64 chars
      expect(queryArg.inviteTokenHash).toHaveLength(64)
      expect(queryArg.inviteTokenExpiry.$gt).toBeInstanceOf(Date)
    })
  })

  describe('listPendingInvites', () => {
    it('formats pending invites for the UI', async () => {
      mockSessionFind.mockResolvedValue([
        {
          _id: { toString: () => 's1' },
          candidateEmail: 'a@x.co',
          candidateName: 'Alice',
          config: { role: 'SWE', interviewType: 'screening' },
          createdAt: new Date('2026-01-01'),
          status: 'created',
        },
      ])
      const result = await listPendingInvites('org1')
      expect(result.invites).toHaveLength(1)
      expect(result.invites[0]).toMatchObject({
        id: 's1',
        candidateEmail: 'a@x.co',
        role: 'SWE',
        interviewType: 'screening',
        status: 'created',
      })
    })
  })

  describe('createOrg', () => {
    it('fails when user not found', async () => {
      mockUserFindById.mockResolvedValue(null)
      const result = await createOrg('u1', { name: 'Acme', slug: 'acme' })
      expect(result).toMatchObject({ error: 'User not found', status: 404 })
    })

    it('fails when user is already in an organization', async () => {
      mockUserFindById.mockResolvedValue({ _id: 'u1', organizationId: 'existing' })
      const result = await createOrg('u1', { name: 'Acme', slug: 'acme' })
      expect(result).toMatchObject({ error: 'Already in an organization', status: 400 })
    })

    it('fails when slug is already taken', async () => {
      mockUserFindById.mockResolvedValue({ _id: 'u1' })
      mockOrgFindOne.mockResolvedValue({ _id: 'existing', slug: 'acme' })
      const result = await createOrg('u1', { name: 'Acme', slug: 'acme' })
      expect(result).toMatchObject({ error: 'Organization slug already taken', status: 409 })
    })

    it('creates org and promotes user to org_admin', async () => {
      mockUserFindById.mockResolvedValue({ _id: 'u1' })
      mockOrgFindOne.mockResolvedValue(null)
      mockOrgCreate.mockResolvedValue({
        _id: { toString: () => 'org-new' },
        name: 'Acme',
        slug: 'acme',
      })
      const result = await createOrg('u1', { name: 'Acme', slug: 'acme' })
      expect(result).toMatchObject({
        success: true,
        organization: { id: 'org-new', name: 'Acme', slug: 'acme' },
      })
      expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith('u1', {
        $set: { organizationId: { toString: expect.any(Function) }, role: 'org_admin' },
      })
    })
  })

  describe('getOrg', () => {
    it('returns null shape when org not found', async () => {
      mockOrgFindById.mockResolvedValue(null)
      mockUserCountDocuments.mockResolvedValue(0)
      const result = await getOrg('org1')
      expect(result.organization).toBeNull()
    })

    it('returns org with live team count', async () => {
      mockOrgFindById.mockResolvedValue({
        _id: { toString: () => 'org1' },
        name: 'Acme',
        slug: 'acme',
        domain: 'acme.com',
        plan: 'pro',
        maxSeats: 10,
        monthlyInterviewLimit: 100,
        monthlyInterviewsUsed: 20,
        settings: { whiteLabel: true },
      })
      mockUserCountDocuments.mockResolvedValue(5)
      const result = await getOrg('org1')
      expect(result.organization).toMatchObject({
        id: 'org1',
        name: 'Acme',
        plan: 'pro',
        currentSeats: 5,
        maxSeats: 10,
      })
    })
  })

  describe('updateOrgSettings', () => {
    it('builds dot-notation update for settings keys', async () => {
      mockOrgFindByIdAndUpdate.mockResolvedValue({})
      await updateOrgSettings('org1', {
        name: 'New Name',
        settings: { whiteLabel: true, brandColor: '#000' },
      })
      const [id, update] = mockOrgFindByIdAndUpdate.mock.calls[0]
      expect(id).toBe('org1')
      expect(update.$set).toMatchObject({
        name: 'New Name',
        'settings.whiteLabel': true,
        'settings.brandColor': '#000',
      })
    })

    it('skips undefined setting values', async () => {
      mockOrgFindByIdAndUpdate.mockResolvedValue({})
      await updateOrgSettings('org1', {
        settings: { whiteLabel: true, brandColor: undefined },
      })
      const [, update] = mockOrgFindByIdAndUpdate.mock.calls[0]
      expect(update.$set).toHaveProperty('settings.whiteLabel', true)
      expect(update.$set).not.toHaveProperty('settings.brandColor')
    })
  })

  describe('templates', () => {
    it('listTemplates formats for UI', async () => {
      mockTemplateFind.mockResolvedValue([
        {
          _id: { toString: () => 't1' },
          name: 'Tmpl1',
          description: 'desc',
          role: 'SWE',
          experienceLevel: 'senior',
          questions: [{ text: 'q1' }, { text: 'q2' }],
          settings: { duration: 20 },
          isActive: true,
          createdAt: new Date('2026-01-01'),
        },
      ])
      const result = await listTemplates('org1')
      expect(result.templates).toHaveLength(1)
      expect(result.templates[0]).toMatchObject({
        id: 't1',
        name: 'Tmpl1',
        questionCount: 2,
        duration: 20,
        isActive: true,
      })
    })

    it('createTemplate returns created id and name', async () => {
      mockTemplateCreate.mockResolvedValue({
        _id: { toString: () => 't-new' },
        name: 'Fresh',
      })
      const result = await createTemplate('org1', 'u1', {
        name: 'Fresh',
        role: 'PM',
        questions: [{ text: 'q1' }, { text: 'q2' }],
      })
      expect(result).toEqual({
        success: true,
        template: { id: 't-new', name: 'Fresh' },
      })
      const arg = mockTemplateCreate.mock.calls[0][0]
      expect(arg.settings.duration).toBe(10)
      expect(arg.settings.questionCount).toBe(2)
      expect(arg.settings.allowFollowUps).toBe(true)
    })
  })
})
